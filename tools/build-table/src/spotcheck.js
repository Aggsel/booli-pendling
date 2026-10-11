// Compares the table with ResRobot's arrive-by trips for a few known stops. Only logs; never fails the job.
const RESROBOT = 'https://api.resrobot.se/v2.1';

async function api(path, params, key) {
  const res = await fetch(`${RESROBOT}/${path}?` + new URLSearchParams({ ...params, format: 'json', accessId: key }));
  if (!res.ok) throw new Error(`ResRobot svarade ${res.status}`);
  return res.json();
}
const stopOf = async (name, key) => {
  const r = await api('location.name', { input: name, maxNo: 1 }, key);
  const s = ((r.stopLocationOrCoordLocation || [])[0] || {}).StopLocation;
  return s ? { id: s.extId, name: s.name } : null;
};
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

export async function spotCheck(table, names, key, log) {
  const dest = await stopOf(table.destination.name, key);
  if (!dest) return log('Spot check: hittade inte resmålet i ResRobot');
  const target = toMin(table.arriveBy);
  log(`Spot check mot ResRobot, framme ${table.arriveBy} ${table.serviceDate}:`);
  log('  hållplats                     tabell  resrobot  diff');
  let within = 0, n = 0;
  for (const name of names) {
    try {
      const row = table.stops.find((r) => r[6] === name) || table.stops.find((r) => r[6].startsWith(name.split(' ')[0]));
      const from = await stopOf(name, key);
      if (!from) { log(`  ${name.padEnd(30)} hittades inte i ResRobot`); continue; }
      const res = await api('trip', {
        originId: from.id, destId: dest.id, date: table.serviceDate, time: table.arriveBy, searchForArrival: 1,
      }, key);
      const trips = (res.Trip || []).filter((t) => t.Destination.date === table.serviceDate && toMin(t.Destination.time) <= target);
      const latest = trips.map((t) => (t.Origin.date < table.serviceDate ? -1e9 : toMin(t.Origin.time))).sort((a, b) => b - a)[0];
      const rr = latest == null || latest < 0 ? null : target - latest;
      const tab = row ? row[2] : null;
      const diff = rr != null && tab != null ? tab - rr : null;
      if (diff != null) { n++; if (Math.abs(diff) <= 3) within++; }
      log(`  ${name.padEnd(30)} ${String(tab ?? '–').padStart(6)}  ${String(rr ?? '–').padStart(8)}  ${diff == null ? '–' : (diff > 0 ? '+' : '') + diff}${diff != null && Math.abs(diff) > 3 ? '  ⚠' : ''}`);
    } catch (e) {
      log(`  ${name.padEnd(30)} fel: ${e.message}`);
    }
  }
  log(`Spot check: ${within} av ${n} inom ±3 min`);
}
