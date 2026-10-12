import { eachRow, hasFile, secs } from './csv.js';
import { activeServices, candidateTuesdays, addDays } from './service-day.js';
import { latestDepartures, lastDepartures, byArrivalDesc, byDepartureAsc, modeLetters, MODE_BITS } from './csa.js';

const H = 3600;
// The last trip home leaves between 18:00 and 03:00 and is home by 04:00. Västtrafik's first morning buses
// leave just before 04:00, and a night trip that waits for them would otherwise count as everyone's "last trip".
const EVENING_FROM = 18 * H, EVENING_UNTIL = 27 * H, HOME_BY = 28 * H, MAX_TRIP_HOME = 3 * H;
const FOOT_RADIUS_M = 300, WALK_MS = 4.5 / 3.6, DETOUR = 1.3;
const DEFAULT_CHANGE = 120;

// GTFS route_type (basic and extended) → t train, s tram, b bus, f ferry
export function modeOf(type) {
  const t = +type;
  if (t === 2 || t === 1 || (t >= 100 && t < 200) || (t >= 400 && t < 500)) return MODE_BITS.t;
  if (t === 0 || (t >= 900 && t < 1000)) return MODE_BITS.s;
  if (t === 4 || (t >= 1000 && t < 1300)) return MODE_BITS.f;
  return MODE_BITS.b;
}

export function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function readStatic(dir) {
  const stops = [], stopIdx = new Map();
  await eachRow(dir, 'stops.txt', (r, c) => {
    const id = r[c.stop_id];
    stopIdx.set(id, stops.length);
    stops.push({ id, name: (r[c.stop_name] || '').trim().normalize('NFC'), lat: +r[c.stop_lat], lon: +r[c.stop_lon],
      parent: c.parent_station != null ? r[c.parent_station] || '' : '', type: c.location_type != null ? +r[c.location_type] || 0 : 0 });
  });
  const routes = new Map();
  await eachRow(dir, 'routes.txt', (r, c) => routes.set(r[c.route_id], modeOf(r[c.route_type])));
  const trips = new Map();
  await eachRow(dir, 'trips.txt', (r, c) => trips.set(r[c.trip_id], { service: r[c.service_id], mode: routes.get(r[c.route_id]) ?? MODE_BITS.b }));
  const calendar = new Map(), dates = new Map();
  if (hasFile(dir, 'calendar.txt')) {
    await eachRow(dir, 'calendar.txt', (r, c) => calendar.set(r[c.service_id], {
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => r[c[d]] === '1'),
      start: r[c.start_date], end: r[c.end_date],
    }));
  }
  if (hasFile(dir, 'calendar_dates.txt')) {
    await eachRow(dir, 'calendar_dates.txt', (r, c) => {
      const id = r[c.service_id];
      if (!dates.has(id)) dates.set(id, new Map());
      dates.get(id).set(r[c.date], +r[c.exception_type]);
    });
  }
  const transfers = [];
  if (hasFile(dir, 'transfers.txt')) {
    await eachRow(dir, 'transfers.txt', (r, c) => {
      if (+r[c.transfer_type] !== 2 || c.min_transfer_time == null) return;
      const a = stopIdx.get(r[c.from_stop_id]), b = stopIdx.get(r[c.to_stop_id]);
      const t = +r[c.min_transfer_time];
      if (a != null && b != null && Number.isFinite(t)) transfers.push([a, b, t]);
    });
  }
  return { stops, stopIdx, trips, calendar, dates, transfers };
}

const tripsOn = (feed, date) => {
  const svc = activeServices(feed.calendar, feed.dates, date);
  const out = [];
  for (const [id, t] of feed.trips) if (svc.has(t.service)) out.push(id);
  return out;
};

// The first normal Tuesday at least a week ahead that the feed actually has service on.
export function pickServiceDate(feed, today) {
  for (const d of candidateTuesdays(today)) if (tripsOn(feed, d).length) return d;
  throw new Error('Tidtabellen har ingen trafik någon av de kommande tisdagarna');
}

// Stream stop_times.txt, keeping only the active trips' rows, and build the morning and evening connection sets.
async function readConnections(dir, feed, date, windows) {
  // A trip can run on the service day (offset 0) and, for the late evening, on the day after (offset 24 h).
  const runs = new Map(); // trip id → [offset seconds]
  for (const id of tripsOn(feed, date)) runs.set(id, [0]);
  for (const id of tripsOn(feed, addDays(date, 1))) (runs.get(id) || runs.set(id, []).get(id)).push(24 * H);
  const rows = new Map();
  await eachRow(dir, 'stop_times.txt', (r, c) => {
    const id = r[c.trip_id];
    if (!runs.has(id)) return;
    const s = feed.stopIdx.get(r[c.stop_id]);
    const arr = secs(r[c.arrival_time]), dep = secs(r[c.departure_time]);
    if (s == null || (arr < 0 && dep < 0)) return;
    let list = rows.get(id);
    if (!list) rows.set(id, (list = []));
    list.push([+r[c.stop_sequence], s, arr < 0 ? dep : arr, dep < 0 ? arr : dep]);
  });

  const sets = windows.map(() => ({ dep: [], arr: [], from: [], to: [], trip: [], mode: [], seq: [] }));
  let nTrips = 0;
  for (const [id, list] of rows) {
    list.sort((a, b) => a[0] - b[0]);
    const mode = feed.trips.get(id).mode;
    for (const off of runs.get(id)) {
      const t = nTrips++;
      for (let k = 0; k + 1 < list.length; k++) {
        const dep = list[k][3] + off, arr = list[k + 1][2] + off;
        windows.forEach((w, wi) => {
          if (dep < w.minDep || dep > w.maxDep || arr > w.maxArr) return;
          const cs = sets[wi];
          cs.dep.push(dep); cs.arr.push(arr); cs.from.push(list[k][1]); cs.to.push(list[k + 1][1]);
          cs.trip.push(t); cs.mode.push(mode); cs.seq.push(list[k][0]);
        });
      }
    }
  }
  const typed = (cs) => ({
    n: cs.dep.length, dep: Int32Array.from(cs.dep), arr: Int32Array.from(cs.arr), from: Int32Array.from(cs.from),
    to: Int32Array.from(cs.to), trip: Int32Array.from(cs.trip), mode: Uint8Array.from(cs.mode), seq: Int32Array.from(cs.seq),
  });
  return { sets: sets.map(typed), nTrips };
}

// Footpaths between stops within 300 m (straight line × 1.3 at 4.5 km/h), plus transfers.txt.
function footpaths(stops, used, transfers) {
  const foot = new Array(stops.length);
  const cell = (s) => `${Math.floor(s.lat * 370)},${Math.floor(s.lon * 197)}`; // ≈ 300 m cells around 58° N
  const grid = new Map();
  for (const i of used) {
    const k = cell(stops[i]);
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  }
  for (const i of used) {
    const s = stops[i];
    const [y, x] = cell(s).split(',').map(Number);
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${y + dy},${x + dx}`) || []) {
        if (j === i) continue;
        const m = metres(s, stops[j]);
        if (m <= FOOT_RADIUS_M) out.push([j, Math.round((m * DETOUR) / WALK_MS)]);
      }
    }
    foot[i] = out;
  }
  const changeTime = new Int32Array(stops.length).fill(DEFAULT_CHANGE);
  for (const [a, b, t] of transfers) {
    if (a === b) { changeTime[a] = t; continue; }
    const list = foot[a] || (foot[a] = []);
    const ex = list.find(([j]) => j === b);
    if (ex) ex[1] = t; else list.push([b, t]);
  }
  return { foot, changeTime };
}

// The destination's stops: by name, or else every stop within `radius` metres of its coordinates.
function destinationStops(stops, d, log) {
  const re = new RegExp(d.stopNamePattern.normalize('NFC'), 'i');
  let matched = stops.map((s, i) => i).filter((i) => re.test(stops[i].name));
  if (!matched.length && d.lat != null) {
    const near = stops.map((s, i) => [i, metres(d, s)]).sort((a, b) => a[1] - b[1]);
    matched = near.filter(([, m]) => m <= (d.radius || 200)).map(([i]) => i);
    if (matched.length) log(`${d.name}: inget namn matchar ${d.stopNamePattern}, använder hållplatserna inom ${d.radius || 200} m`);
    else log(`${d.name}: närmaste hållplatser är ${near.slice(0, 10).map(([i, m]) => `${stops[i].name} (${Math.round(m)} m)`).join(', ')}`);
  }
  if (!matched.length) return null;
  const ids = new Set(matched.map((i) => stops[i].id));
  const all = stops.map((s, i) => i).filter((i) => ids.has(stops[i].id) || ids.has(stops[i].parent));
  const main = matched.find((i) => stops[i].type === 1) ?? matched[0];
  log(`${d.name}: ${all.length} hållplatser (${[...new Set(all.map((i) => stops[i].name))].join(', ')})`);
  return { stops: all, main: d.lat != null ? { lat: d.lat, lon: d.lon } : stops[main] };
}

const hhmm = (t) => `${String(Math.floor(t / H) % 24).padStart(2, '0')}:${String(Math.floor((t % H) / 60)).padStart(2, '0')}`;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Builds one table per destination in config.
 * opts: { today: "YYYY-MM-DD", serviceDate?: "YYYY-MM-DD", source: string, log?: fn }
 */
export async function buildTables(dir, config, opts) {
  const log = opts.log || (() => {});
  const feed = await readStatic(dir);
  log(`${feed.stops.length} hållplatser, ${feed.trips.size} turer i tidtabellen`);
  const date = opts.serviceDate || pickServiceDate(feed, opts.today);
  const target = secs(config.arriveBy);
  const maxSecs = config.maxMinutes * 60;
  const windows = [
    { minDep: target - maxSecs, maxDep: target, maxArr: target },
    { minDep: EVENING_FROM, maxDep: EVENING_UNTIL + MAX_TRIP_HOME, maxArr: EVENING_UNTIL + MAX_TRIP_HOME },
  ];
  const { sets: [morning, evening], nTrips } = await readConnections(dir, feed, date, windows);
  log(`Trafikdag ${date}: ${morning.n} förbindelser på morgonen, ${evening.n} på kvällen`);

  const used = new Set();
  for (const cs of [morning, evening]) for (let i = 0; i < cs.n; i++) { used.add(cs.from[i]); used.add(cs.to[i]); }
  const dests = config.destinations.map((d) => ({ d, found: destinationStops(feed.stops, d, log) }));
  for (const { d, found } of dests) {
    if (!found) throw new Error(`Hittade ingen hållplats för ${d.name} (${d.stopNamePattern})`);
    for (const s of found.stops) used.add(s);
  }
  const { foot, changeTime } = footpaths(feed.stops, used, feed.transfers);
  const nStops = feed.stops.length;
  const mOrder = byArrivalDesc(morning, morning.seq);
  const eOrder = byDepartureAsc(evening, evening.seq);

  const out = [];
  for (const { d, found } of dests) {
    const rev = latestDepartures({ nStops, nTrips, cs: morning, order: mOrder, target, destStops: found.stops, foot, changeTime, maxSecs });
    const last = lastDepartures({ nStops, nTrips, cs: evening, order: eOrder, destStops: found.stops, foot, changeTime,
      from: EVENING_FROM, until: EVENING_UNTIL, maxTrip: MAX_TRIP_HOME, arriveBy: HOME_BY });

    // Merge platforms into their station, keeping the best value.
    const merged = new Map();
    for (let i = 0; i < nStops; i++) {
      if (!rev.modes[i] || rev.latest[i] < target - maxSecs) continue;
      const s = feed.stops[i];
      const pi = s.parent ? feed.stopIdx.get(s.parent) : null;
      const key = pi != null ? pi : i;
      const row = { min: Math.round((target - rev.latest[i]) / 60), chg: rev.chg[i], modes: rev.modes[i], last: last[i] };
      const ex = merged.get(key);
      if (!ex) { merged.set(key, row); continue; }
      if (row.min < ex.min || (row.min === ex.min && row.chg < ex.chg)) Object.assign(ex, { min: row.min, chg: row.chg, modes: row.modes });
      if (row.last > ex.last) ex.last = row.last;
    }
    const rows = [...merged].map(([k, v]) => {
      const s = feed.stops[k];
      return [r5(s.lat), r5(s.lon), v.min, v.chg, modeLetters(v.modes), v.last >= 0 ? hhmm(v.last) : null, s.name];
    }).filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[2] <= config.maxMinutes);
    rows.sort((a, b) => a[2] - b[2] || a[6].localeCompare(b[6], 'sv'));
    log(`${d.name}: ${rows.length} hållplatser inom ${config.maxMinutes} min`);
    out.push({
      key: d.key,
      table: {
        version: 1,
        destination: { key: d.key, name: d.name, label: d.label || d.name, lat: r5(found.main.lat), lon: r5(found.main.lon) },
        serviceDate: date,
        arriveBy: config.arriveBy,
        generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        source: opts.source,
        fields: ['lat', 'lon', 'min', 'chg', 'modes', 'last', 'name'],
        stops: rows,
      },
    });
  }
  return out;
}
