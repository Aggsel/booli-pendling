// ==UserScript==
// @name         Booli pendlingspoäng
// @namespace    booli-travel-times
// @version      1.9.3
// @description  Pendlingspoäng och restider på Booli, direkt under bostadens fakta
// @homepageURL  https://github.com/Aggsel/booli-pendling
// @supportURL   https://github.com/Aggsel/booli-pendling/issues
// @updateURL    https://raw.githubusercontent.com/Aggsel/booli-pendling/main/booli-pendling.user.js
// @downloadURL  https://raw.githubusercontent.com/Aggsel/booli-pendling/main/booli-pendling.user.js
// @license      MIT
// @match        https://www.booli.se/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @sandbox      JavaScript
// @connect      api.resrobot.se
// @connect      routing.openstreetmap.de
// @connect      overpass-api.de
// @connect      overpass.kumi.systems
// @connect      overpass.private.coffee
// @connect      nominatim.openstreetmap.org
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;

  // =====================================================================
  // Config
  // =====================================================================
  const RESROBOT = 'https://api.resrobot.se/v2.1';
  const OSRM = 'https://routing.openstreetmap.de';
  const CACHE_TTL = 7 * 24 * 3600 * 1000;
  const CACHE_NS = 'v4:'; // bump when cached data changes shape
  // Weekly travel-time tables, published by the repository's GitHub Action (tools/build-table), for result lists.
  const TABLE_BASE = 'https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/';
  // Used until the published index (data/tables.json) has been fetched.
  const TABLES = [{ key: 'gbg-c', label: 'Göteborg C', name: 'Göteborg Centralstation', lat: 57.7089, lon: 11.9735 }];
  const TABLE_TTL = 7 * 24 * 3600 * 1000;
  const INDEX_TTL = 6 * 3600 * 1000; // the index is small: check often, so new destinations and tables show up soon
  const TABLE_STALE_DAYS = 21;
  const LIST_MAXES = [20, 30, 40, 50, 60];

  // ResRobot request product classes (trafiklab.se/api/our-apis/resrobot-v21/common)
  const MODES = [
    { key: 'train', label: 'Tåg', icon: '🚆', bits: 2 | 4 | 16 },
    { key: 'tram', label: 'Spårvagn', icon: '🚋', bits: 64 },
    { key: 'bus', label: 'Buss', icon: '🚌', bits: 8 | 128 },
    { key: 'metro', label: 'Tunnelbana', icon: '🚇', bits: 32 },
    { key: 'ferry', label: 'Båt', icon: '⛴️', bits: 256 },
  ];
  const TRAIN_BITS = MODES[0].bits;
  const ALL_BITS = MODES.reduce((s, m) => s | m.bits, 0);
  const NIGHTS = {
    weekday: { label: 'vardagskvällar', ok: (g) => g >= 1 && g <= 4 },
    fri: { label: 'fredagkväll', ok: (g) => g === 5 },
    sat: { label: 'lördagkväll', ok: (g) => g === 6 },
  };
  const ICON = { walk: '🚶', bike: '🚲', other: '•', ...Object.fromEntries(MODES.map((m) => [m.key, m.icon])) };
  ICON.car = '🚗';
  const NAME = { walk: 'promenad', bike: 'cykel', car: 'bil', other: 'kollektivtrafik', ...Object.fromEntries(MODES.map((m) => [m.key, m.label.toLowerCase()])) };
  const chain = (rides) => (rides.length ? rides.map((k) => ICON[k] || ICON.other).join(' › ') : ICON.walk);
  const modeNames = (rides) => [...new Set(rides)].map((k) => NAME[k] || NAME.other).join(' och ');

  // Values that can be shown in Booli's facts row and on the map card
  const KPIS = [
    { key: 'commute', label: 'Pendling', desc: 'Restid till ditt viktigaste resmål' },
    { key: 'station', label: 'Till station', desc: 'Snabbaste sättet till närmaste tågstation' },
    { key: 'score', label: 'Poäng', desc: 'Pendlingspoängen 0–100' },
    { key: 'transit', label: 'Kollektivt', desc: 'Restid med bara kollektivtrafik' },
    { key: 'bike', label: 'Cykel hela vägen', desc: 'Cykeltid till ditt viktigaste resmål' },
    { key: 'lastHome', label: 'Sista hem', desc: 'När sista resan hem går' },
    { key: 'grocery', label: 'Matbutik', desc: 'Närmaste livsmedelsbutik', everyday: 'grocery' },
    { key: 'school', label: 'Skola', desc: 'Närmaste grundskola', everyday: 'school' },
    { key: 'car', label: 'Bil', desc: 'Körtid i rusning till ditt viktigaste resmål', everyday: 'car' },
  ];
  // A value tied to an "I vardagen" category is only available while that category is on.
  const kpiAvailable = (k, c) => !k.everyday || c.everyday[k.everyday].on;
  // What the click-to-reveal panel shows
  const DETAILS = [
    { key: 'station', label: 'Närmaste tågstation' },
    { key: 'route', label: 'Färdsätt' },
    { key: 'today', label: 'Skillnad mot idag' },
    { key: 'times', label: 'Avresa och ankomst' },
    { key: 'via', label: 'Station resan går via' },
    { key: 'transitOnly', label: 'Bara kollektivtrafik' },
    { key: 'lastHome', label: 'Sista resan hem' },
    { key: 'everyday', label: 'Matbutik, skola och bil' },
    { key: 'bikeAll', label: 'Cykel hela vägen' },
    { key: 'breakdown', label: 'Så räknas poängen' },
    { key: 'compareTable', label: 'Jämförelsetabell mot idag' },
  ];

  const DETAIL_LEVELS = {
    kort: { label: 'Kort', desc: 'Närmaste tågstation, färdsätt och skillnaden mot idag.', keys: ['station', 'route', 'today'] },
    standard: { label: 'Standard', desc: 'Även avresa och ankomst, vilken station resan går via, restid med bara kollektivtrafik, sista resan hem samt matbutik, skola och bil.',
      keys: ['station', 'route', 'today', 'times', 'via', 'transitOnly', 'lastHome', 'everyday'] },
    allt: { label: 'Allt', desc: 'Även cykel hela vägen, hur poängen räknas och en jämförelsetabell mot idag.', keys: DETAILS.map((d) => d.key) },
  };
  // Levels as they were before the "today" and "everyday" items existed, for migrating saved choices.
  const OLD_LEVELS = {
    kort: ['station', 'route'],
    standard: ['station', 'route', 'times', 'via', 'transitOnly', 'lastHome'],
    allt: ['station', 'route', 'times', 'via', 'transitOnly', 'lastHome', 'bikeAll', 'breakdown'],
  };
  const OLD_DETAIL_KEYS = OLD_LEVELS.allt;
  const detailsFor = (level) => Object.fromEntries(DETAILS.map((d) => [d.key, DETAIL_LEVELS[level].keys.includes(d.key)]));
  const levelOf = (details) => Object.keys(DETAIL_LEVELS).find((l) => DETAILS.every((d) => !!details[d.key] === DETAIL_LEVELS[l].keys.includes(d.key))) || 'egen';

  const PRESETS = [
    { key: 'restid', label: 'Restiden', desc: 'Kort pendling betyder mest', w: [70, 15, 15] },
    { key: 'balans', label: 'Balanserat', desc: 'Allt väger ungefär lika', w: [40, 30, 30] },
    { key: 'kvall', label: 'Sena kvällar', desc: 'Att kunna ta sig hem sent', w: [45, 15, 40] },
  ];
  const presetOf = (w) => (PRESETS.find((p) => p.w[0] === w.commute && p.w[1] === w.access && p.w[2] === w.lastHome) || { key: 'egen' }).key;
  const WEIGHT_LEVELS = [{ v: 1, label: 'Lite' }, { v: 3, label: 'Mellan' }, { v: 5, label: 'Mycket' }];

  const DEFAULT_DEST = { ideal: 30, max: 60, weight: 3 };
  const DEFAULTS = {
    apiKey: '',
    timeMode: 'arrive',
    time: '08:00',
    modes: MODES.map((m) => m.key),
    changePenalty: 5,
    accessModes: { walk: true, bike: true, bus: true }, // ways you'd get to the station
    accessIdeal: 10,
    accessMax: 30,
    stationBuffer: 3, // minutes to park the bike and reach the platform
    directMax: 45, // longest walk or bike ride counted as a whole commute on its own
    walkSpeed: 5,
    bikeSpeed: 16,
    radius: 8000,
    lastHome: 'weekday',
    lastHomeIdeal: '00:00',
    lastHomeEarliest: '21:00',
    weights: { commute: 70, access: 15, lastHome: 15 },
    kpis: ['commute', 'station'],
    details: detailsFor('standard'),
    home: null, // { label, lat, lon }, only ever stored in this browser
    showTodayDelta: true,
    everyday: { grocery: { on: true, mode: 'bike' }, school: { on: true, mode: 'walk' }, car: { on: true } },
    destinations: [{ name: 'Göteborg Centralstation', id: '740000002', lat: 57.708895, lon: 11.973479, ...DEFAULT_DEST }],
    list: { dest: 'mine', max: 0, over: 'dim', sort: false }, // result lists: 'mine', a table key or 'off'; max minutes (0 = all)
  };

  function cfg() {
    const saved = GM_getValue('config', {});
    if (saved.departTime && !saved.time) { saved.time = saved.departTime; saved.timeMode = 'depart'; }
    const c = Object.assign({}, DEFAULTS, saved);
    c.weights = Object.assign({}, DEFAULTS.weights, saved.weights || {});
    c.list = Object.assign({}, DEFAULTS.list, saved.list || {});
    if (saved.list && saved.list.table === 'off' && !saved.list.dest) c.list.dest = 'off';
    delete c.list.table;
    c.details = Object.assign({}, DEFAULTS.details, saved.details || {});
    c.everyday = {
      grocery: { ...DEFAULTS.everyday.grocery, ...((saved.everyday || {}).grocery || {}) },
      school: { ...DEFAULTS.everyday.school, ...((saved.everyday || {}).school || {}) },
      car: { ...DEFAULTS.everyday.car, ...((saved.everyday || {}).car || {}) },
    };
    // Migrations from earlier versions
    if (saved.details && !('today' in saved.details)) {
      const old = Object.keys(OLD_LEVELS).find((l) => OLD_DETAIL_KEYS.every((k) => !!saved.details[k] === OLD_LEVELS[l].includes(k)));
      c.details = old ? detailsFor(old) : { ...saved.details, today: true, everyday: true, compareTable: false };
    }
    if (!saved.accessModes) c.accessModes = saved.access === 'walk' ? { walk: true, bike: false, bus: true } : { ...DEFAULTS.accessModes };
    if (saved.bikeToDest === false) c.details.bikeAll = false;
    delete c.access;
    delete c.bikeToDest;
    c.kpis = KPIS.filter((k) => kpiAvailable(k, c)).map((k) => k.key).filter((k) => (c.kpis || []).includes(k)).slice(0, 3);
    if (!c.kpis.length) c.kpis = [...DEFAULTS.kpis];
    c.destinations = (c.destinations || []).map((d) => {
      const x = { ...DEFAULT_DEST, ...d };
      x.weight = x.weight <= 2 ? 1 : x.weight >= 4 ? 5 : 3; // old 1–5 scale → Lite / Mellan / Mycket
      return x;
    });
    return c;
  }
  const saveCfg = (c) => GM_setValue('config', c);
  const productsOf = (c) => MODES.filter((m) => c.modes.includes(m.key)).reduce((s, m) => s | m.bits, 0) || ALL_BITS;

  // =====================================================================
  // Helpers
  // =====================================================================
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const cleanName = (n) => String(n).replace(/\s*\([^)]*\)\s*$/, '');
  const pad = (n) => String(n).padStart(2, '0');
  function parseTime(str) {
    const t = String(str).trim().replace(/[.,]/g, ':');
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(t);
    if (!m) return null;
    const h = +m[1], min = +(m[2] || 0);
    return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
  }
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (iso) => iso.slice(11, 16);
  const changesText = (n) => (n === 1 ? '1 byte' : `${n} byten`);
  const km1 = (km) => km.toFixed(1).replace('.', ',');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lin = (v, good, bad) => (v <= good ? 100 : v >= bad ? 0 : (100 * (bad - v)) / (bad - good));
  // Minutes after noon, so 23:30 < 00:30 < 02:00 compare correctly for late-night times
  const nightMins = (t) => { const [h, m] = t.split(':').map(Number); return (h * 60 + m - 720 + 1440) % 1440; };

  function dayFrom(offset, ok) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    while (!ok(d.getDay())) d.setDate(d.getDate() + 1);
    return d;
  }
  const commuteDate = () => ymd(dayFrom(1, (g) => g >= 1 && g <= 5));

  // =====================================================================
  // HTTP + cache
  // =====================================================================
  function gmJson(url, { method = 'GET', data, headers } = {}) {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method,
        url,
        data,
        headers,
        onload: (r) => {
          let body = null;
          try { body = JSON.parse(r.responseText); } catch {}
          if (r.status === 200 && body) return resolve(body);
          if (r.status === 401 || r.status === 403) return reject(new Error('API-nyckeln godkändes inte'));
          if (r.status === 429) return reject(new Error('För många anrop, försök igen om en minut'));
          if (body && /NO_RESULT|NO_MATCH/i.test(body.errorCode || '')) return resolve({});
          reject(new Error((body && body.errorText) || `Anropet misslyckades (${r.status})`));
        },
        onerror: () => reject(new Error('Nätverksfel')),
      })
    );
  }
  const api = (path, params, key = cfg().apiKey) =>
    gmJson(`${RESROBOT}/${path}?` + new URLSearchParams({ ...params, format: 'json', accessId: key }));

  // One in-memory copy of the cache, written through to storage, so parallel lookups don't overwrite each other.
  let cacheMem = null;
  function loadCache() {
    if (!cacheMem) {
      cacheMem = GM_getValue('cache', {});
      for (const k of Object.keys(cacheMem)) if (!k.startsWith(CACHE_NS) || Date.now() - cacheMem[k].t > CACHE_TTL) delete cacheMem[k];
    }
  }
  // Read or write a value directly, without a lookup function.
  function cacheGet(key) {
    loadCache();
    const hit = cacheMem[CACHE_NS + key];
    return hit && Date.now() - hit.t < CACHE_TTL ? hit.v : null;
  }
  function cachePut(key, v) {
    loadCache();
    const k = CACHE_NS + key;
    if (cacheMem[k] && JSON.stringify(cacheMem[k].v) === JSON.stringify(v)) return; // unchanged, skip the write
    cacheMem[k] = { t: Date.now(), v };
    GM_setValue('cache', cacheMem);
  }
  async function cached(key, fn) {
    key = CACHE_NS + key;
    loadCache();
    const hit = cacheMem[key];
    if (hit && Date.now() - hit.t < CACHE_TTL) return JSON.parse(JSON.stringify(hit.v));
    const v = await fn();
    cacheMem[key] = { t: Date.now(), v: JSON.parse(JSON.stringify(v ?? null)) };
    GM_setValue('cache', cacheMem);
    return v;
  }
  const soft = (pr) => pr.catch(() => null);

  // =====================================================================
  // Routing
  // =====================================================================
  const stopsOf = (res) => (res.stopLocationOrCoordLocation || []).map((x) => x.StopLocation).filter(Boolean);

  async function nearbyStations(p, c) {
    const res = await api('location.nearbystops', {
      originCoordLat: p.lat, originCoordLong: p.lon, r: c.radius, maxNo: 200, products: TRAIN_BITS,
    });
    const trains = stopsOf(res).filter((s) => {
      const prods = [].concat(s.ProductAtStop || s.productAtStop || []);
      return !prods.length || prods.some((x) => TRAIN_BITS & Number(x.cls));
    });
    trains.sort((a, b) => Number(a.dist) - Number(b.dist));
    return trains.slice(0, 3).map((s) => ({ id: s.extId || s.id, name: cleanName(s.name), dist: Number(s.dist), lat: +s.lat, lon: +s.lon }));
  }

  // A place is either a stop ({ id }) or a coordinate ({ lat, lon }).
  const placeParams = (place, prefix) =>
    place.id ? { [`${prefix}Id`]: place.id } : { [`${prefix}CoordLat`]: place.lat, [`${prefix}CoordLong`]: place.lon };

  function addMins(iso, m) {
    const d = new Date(iso);
    d.setMinutes(d.getMinutes() + m);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return { date: ymd(d), time, iso: `${ymd(d)}T${time}:00` };
  }
  const minsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

  // rides = the mode of each vehicle leg, e.g. ['bus', 'train']. Line numbers are deliberately dropped.
  function parseTrip(t) {
    const legs = [].concat((t.LegList && t.LegList.Leg) || []);
    const rides = legs.filter((l) => l.type === 'JNY').map((l) => {
      const pr = [].concat(l.Product || [])[0] || {};
      const mode = MODES.find((m) => m.bits & Number(pr.cls));
      return mode ? mode.key : 'other';
    });
    const dep = `${t.Origin.date}T${t.Origin.time}`;
    const arr = `${t.Destination.date}T${t.Destination.time}`;
    return { dep, arr, mins: minsBetween(dep, arr), rides, changes: Math.max(0, rides.length - 1) };
  }

  // Commute trip. "Arrive by" picks the latest departure that still makes it; "leave at" the earliest arrival.
  // offset = minutes spent before boarding (walking or cycling to the station), used for "leave at".
  async function commuteTrip(from, destId, c, offset = 0) {
    const date = commuteDate();
    const arrive = c.timeMode === 'arrive';
    const target = `${date}T${c.time}:00`;
    const start = addMins(target, arrive ? 0 : offset);
    const res = await api('trip', {
      ...placeParams(from, 'origin'), destId, date: start.date, time: start.time,
      searchForArrival: arrive ? 1 : 0, products: productsOf(c),
    });
    let trips = (res.Trip || []).map(parseTrip);
    if (arrive) {
      trips = trips.filter((t) => t.arr <= target);
      trips.sort((a, b) => b.dep.localeCompare(a.dep) || a.mins - b.mins);
    } else {
      trips.sort((a, b) => a.arr.localeCompare(b.arr) || a.mins - b.mins);
    }
    return trips[0] || null;
  }

  // Last trip home, searched forwards: probe late times first (02:00, 00:30, 23:00, 21:00, 18:00).
  // The first probe that finds trips tells us where the evening's service ends; then step forward to the very last one.
  // Trips must leave after 18:00, leave before 04:00 and take at most 3 hours (no overnight waits).
  async function lastTripHome(destId, to, c) {
    const night = dayFrom(0, NIGHTS[c.lastHome].ok);
    const noon = `${ymd(night)}T12:00:00`;
    const floor = `${ymd(night)}T18:00:00`;
    const cutoff = addMins(noon, 16 * 60).iso;
    const search = async (iso) => {
      const s = addMins(iso, 0);
      const res = await api('trip', {
        originId: destId, ...placeParams(to, 'dest'), date: s.date, time: s.time, numF: 6, products: productsOf(c),
      });
      return (res.Trip || []).map(parseTrip).filter((t) => t.rides.length && t.dep >= floor && t.dep < cutoff && t.mins <= 180);
    };
    const latest = (ts) => ts.reduce((a, b) => (b.dep > a.dep ? b : a));
    for (const hoursAfterNoon of [14, 12.5, 11, 9, 6]) {
      const found = await search(addMins(noon, hoursAfterNoon * 60).iso);
      if (!found.length) continue;
      let last = latest(found);
      for (let i = 0; i < 4; i++) {
        const more = (await search(addMins(last.dep, 1).iso)).filter((t) => t.dep > last.dep);
        if (!more.length) break;
        last = latest(more);
      }
      return last;
    }
    return null;
  }

  // Route distance (and free-flow duration). Walking and cycling minutes come from the user's own speeds.
  async function routeKm(profile, a, b) {
    const r = await gmJson(`${OSRM}/routed-${profile}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, { headers: OSM_HEADERS });
    const route = r.routes && r.routes[0];
    return route ? { km: route.distance / 1000, mins: route.duration / 60 } : null;
  }
  const minsAt = (km, kmh) => Math.round((km / kmh) * 60);

  // =====================================================================
  // Everyday places, driving and the "today" baseline
  // =====================================================================
  // The main Overpass server rejects anonymous browser POSTs with 406, so: GET, identify ourselves, fall back to mirrors.
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  // OpenStreetMap's free services ask every client to identify itself.
  const OSM_HEADERS = { Accept: '*/*', 'User-Agent': 'BooliPendling/1.1 (Tampermonkey userscript, commute helper for booli.se)' };
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const RUSH_FACTOR = 1.3; // free-flow driving time × this ≈ rush hour (an estimate, labelled as such)
  const PLACE_RADIUS = 6000;

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Nearby listings share one Overpass answer: positions are snapped to a ~300 m grid.
  const gridKey = (p) => `${(Math.round(p.lat / 0.003) * 0.003).toFixed(3)},${(Math.round(p.lon / 0.005) * 0.005).toFixed(3)}`;

  // OpenStreetMap has no reliable "grundskola" tag in Sweden; leave out schools that clearly aren't one.
  const NOT_PRIMARY = /gymnasi|komvux|vuxenutbildning|\bsfi\b|högskola|universitet|folkhögskola|kulturskola|musikskola|trafikskola|körskola|dansskola|yrkeshögskola|\byh\b/i;
  function isPrimarySchool(tags) {
    if (NOT_PRIMARY.test(tags.name || '')) return false;
    const isced = tags['isced:level'];
    if (isced && !/[012]/.test(isced)) return false;
    return true;
  }

  async function nearbyPlaces(p, kinds) {
    const around = `(around:${PLACE_RADIUS},${p.lat},${p.lon})`;
    const parts = [];
    if (kinds.includes('grocery')) parts.push(`nwr${around}[shop~"^(supermarket|convenience)$"];`);
    if (kinds.includes('school')) parts.push(`nwr${around}[amenity=school];`, `nwr${around}[amenity=kindergarten];`);
    const q = `[out:json][timeout:25];(${parts.join('')});out center tags;`;
    let res = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        res = await gmJson(`${endpoint}?data=${encodeURIComponent(q)}`, { headers: OSM_HEADERS });
        if (res && Array.isArray(res.elements)) break;
        res = null;
      } catch { /* try the next mirror */ }
    }
    if (!res) throw new Error('OpenStreetMap svarar inte just nu');
    const out = { grocery: [], primary: [], preschool: [] };
    for (const e of res.elements || []) {
      const pos = e.type === 'node' ? { lat: e.lat, lon: e.lon } : e.center;
      if (!pos) continue;
      const t = e.tags || {};
      const item = { lat: +pos.lat.toFixed(5), lon: +pos.lon.toFixed(5) };
      if (t.shop) out.grocery.push(item);
      else if (t.amenity === 'kindergarten') out.preschool.push(item);
      else if (t.amenity === 'school' && isPrimarySchool(t)) out.primary.push(item);
    }
    // Keep storage small: only the nearest few of each kind.
    for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => haversineKm(p, a) - haversineKm(p, b)).slice(0, 12);
    return out;
  }

  const nearestOf = (list, p) => (list || []).reduce((best, x) => (!best || haversineKm(p, x) < haversineKm(p, best) ? x : best), null);
  const PROFILE = { walk: 'foot', bike: 'bike', car: 'car' };

  // Travel time to a place with the chosen way of getting there.
  async function placeTrip(p, place, mode, c) {
    const pk = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    const route = await soft(cached(`${PROFILE[mode]}:${pk}:${place.lat},${place.lon}`, () => routeKm(PROFILE[mode], p, place)));
    const km = route ? route.km : haversineKm(p, place) * 1.3;
    const mins = mode === 'walk' ? minsAt(km, c.walkSpeed) : mode === 'bike' ? minsAt(km, c.bikeSpeed)
      : Math.max(1, Math.round(route ? route.mins : (km / 40) * 60));
    return { km, mins, mode };
  }

  // Everything in "I vardagen" for one position. Only categories that are switched on are fetched.
  async function everydayFor(p, c) {
    const ev = { grocery: null, school: null, cars: {} };
    const kinds = ['grocery', 'school'].filter((k) => c.everyday[k].on);
    const tasks = [];
    if (kinds.length) {
      tasks.push((async () => {
        const places = await cached(`osm:${gridKey(p)}:${kinds.join('+')}`, () => nearbyPlaces(p, kinds));
        if (c.everyday.grocery.on) {
          const g = nearestOf(places.grocery, p);
          ev.grocery = g ? await placeTrip(p, g, c.everyday.grocery.mode, c) : { none: true };
        }
        if (c.everyday.school.on) {
          const pr = nearestOf(places.primary, p), pre = nearestOf(places.preschool, p);
          const [a, b] = await Promise.all([
            pr ? placeTrip(p, pr, c.everyday.school.mode, c) : null,
            pre ? placeTrip(p, pre, c.everyday.school.mode, c) : null,
          ]);
          ev.school = a || b ? { primary: a, preschool: b } : { none: true };
        }
      })().catch((e) => { ev.error = e.message; }));
    }
    if (c.everyday.car.on) {
      const pk = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      for (const d of c.destinations) {
        if (!d.lat) continue;
        tasks.push(soft(cached(`car:${pk}:${d.id}`, () => routeKm('car', p, d))).then((r) => {
          if (r) ev.cars[d.id] = { km: r.km, mins: Math.round(r.mins * RUSH_FACTOR) };
        }));
      }
    }
    await Promise.all(tasks);
    return ev;
  }

  async function geocodeHome(label) {
    const url = `${NOMINATIM}?` + new URLSearchParams({ format: 'jsonv2', limit: 1, countrycodes: 'se', 'accept-language': 'sv', q: label });
    const res = await gmJson(url, { headers: OSM_HEADERS });
    const hit = Array.isArray(res) ? res[0] : null;
    return hit ? { label, lat: +(+hit.lat).toFixed(5), lon: +(+hit.lon).toFixed(5) } : null;
  }

  // The "today" baseline is the same calculation run from the home address. It goes through the same cache,
  // so it is computed once per settings change and then reused for every listing.
  const todayMemo = new Map();
  function memoToday(kind, c, fn) {
    if (!c.home || !c.home.lat) return Promise.resolve(null);
    const key = kind + JSON.stringify(c);
    if (!todayMemo.has(key)) todayMemo.set(key, fn().catch(() => { todayMemo.delete(key); return null; }));
    return todayMemo.get(key);
  }
  const todayBase = (c) => memoToday('base', c, async () => {
    const r = await evaluate({ ...c.home, sure: true }, c);
    return { r, sc: score(r, c) };
  });
  const todayEveryday = (c) => memoToday('ev', c, async () => {
    const ev = await everydayFor(c.home, c);
    if (ev.error) throw new Error(ev.error); // not memoised, so it is retried next time
    return ev;
  });

  // ---------- comparing with today ----------
  const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  // Minutes: lower is better. kind: worse | better | same. long = "+12 min längre", short = "+12 min mot idag"
  function deltaMins(here, today) {
    if (here == null || today == null) return null;
    const d = Math.round(here - today);
    if (d === 0) return { kind: 'same', long: 'Samma som idag', short: 'Samma som idag', d };
    if (d > 0) return { kind: 'worse', long: `+${fmtDur(d)} längre`, short: `+${fmtDur(d)} mot idag`, d };
    return { kind: 'better', long: `−${fmtDur(-d)} kortare`, short: `−${fmtDur(-d)} mot idag`, d };
  }
  // Last trip home: clock times past midnight compare correctly, and later is better.
  function deltaLastHome(hereHm, todayHm) {
    if (!hereHm || !todayHm) return null;
    const d = nightMins(hereHm) - nightMins(todayHm);
    if (d === 0) return { kind: 'same', long: 'Samma som idag', short: 'Samma som idag', d };
    return d > 0
      ? { kind: 'better', long: `${fmtDur(d)} senare`, short: `${fmtDur(d)} senare`, d }
      : { kind: 'worse', long: `${fmtDur(-d)} tidigare`, short: `${fmtDur(-d)} tidigare`, d };
  }
  const DELTA_TEXT = { worse: '#6e4700', better: '#1f5a37', same: '#3d3d3b' };

  // =====================================================================
  // Listing position
  // =====================================================================
  const listingId = () => (location.pathname.match(/\/(?:annons|bostad)\/(\d+)/) || [])[1];
  const inSweden = (lat, lon) => lat > 55 && lat < 69.5 && lon > 10.5 && lon < 24.5;

  function coordsOf(o) {
    const lat = Number(o.latitude ?? o.lat);
    const lon = Number(o.longitude ?? o.lon ?? o.lng);
    return Number.isFinite(lat) && Number.isFinite(lon) && inSweden(lat, lon) ? { lat, lon } : null;
  }

  function findCoords(root, id) {
    let best = null, fallback = null;
    (function walk(o, owned, depth) {
      if (best || !o || typeof o !== 'object' || depth > 40) return;
      const mine = owned || Object.values(o).some((v) => typeof v !== 'object' && String(v) === id);
      const c = coordsOf(o);
      if (c) { if (mine) { best = c; return; } fallback = fallback || c; }
      for (const [k, v] of Object.entries(o)) walk(v, mine || k.includes(id), depth + 1);
    })(root, false, 0);
    return best ? { ...best, sure: true } : fallback ? { ...fallback, sure: false } : null;
  }

  // Next.js app-router pages ship their data as escaped string chunks; decode them into plain text.
  function flightText(doc) {
    let out = '';
    for (const s of doc.querySelectorAll('script')) {
      const t = s.textContent;
      if (!t.includes('__next_f')) continue;
      for (const m of t.matchAll(/__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
        try { out += JSON.parse(m[1]); } catch {}
      }
    }
    return out;
  }

  // Every lat/long pair in the text, grouped, scored by closeness to a mention of the listing id and by repetition.
  function pairCandidates(text, id) {
    const idRe = new RegExp(`(?<!\\d)${id}(?!\\d)`, 'g');
    const ids = [...text.matchAll(idRe)].map((m) => m.index);
    const res = [
      { re: /\\?"(?:latitude|lat)\\?"\s*:\s*"?(\d{2}\.\d+)"?[^{}]{0,200}?\\?"(?:longitude|lng|lon)\\?"\s*:\s*"?(\d{1,2}\.\d+)"?/g, latFirst: true },
      { re: /\\?"(?:longitude|lng|lon)\\?"\s*:\s*"?(\d{1,2}\.\d+)"?[^{}]{0,200}?\\?"(?:latitude|lat)\\?"\s*:\s*"?(\d{2}\.\d+)"?/g, latFirst: false },
    ];
    const groups = new Map();
    for (const { re, latFirst } of res) {
      for (const m of text.matchAll(re)) {
        const lat = +(latFirst ? m[1] : m[2]);
        const lon = +(latFirst ? m[2] : m[1]);
        if (!inSweden(lat, lon)) continue;
        const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const g = groups.get(key) || { lat, lon, count: 0, dist: Infinity, at: m.index };
        g.count++;
        for (const i of ids) g.dist = Math.min(g.dist, Math.abs(i - m.index));
        groups.set(key, g);
      }
    }
    const near = (g) => g.dist < 1500;
    return [...groups.values()].sort((a, b) =>
      near(a) !== near(b) ? (near(a) ? -1 : 1) : b.count - a.count || a.dist - b.dist);
  }

  async function getListingCoords(id, debug, url = location.href) {
    const html = await (await fetch(url, { credentials: 'include' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = html + '\n' + flightText(doc);

    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const c = findCoords(JSON.parse(s.textContent), id);
        if (c) { if (debug) debug.source = 'json-ld'; return { ...c, sure: true }; }
      } catch {}
    }
    let jsonFallback = null;
    for (const s of doc.querySelectorAll('script')) {
      const t = s.textContent.trim();
      if (!t.startsWith('{') && s.type !== 'application/json') continue;
      try {
        const c = findCoords(JSON.parse(t), id);
        if (c && c.sure) { if (debug) debug.source = 'json-state'; return c; }
        jsonFallback = jsonFallback || c;
      } catch {}
    }
    const cands = pairCandidates(text, id);
    if (debug) {
      debug.candidates = cands.slice(0, 5).map((g) => ({
        lat: g.lat, lon: g.lon, count: g.count, distToId: g.dist,
        snippet: text.slice(Math.max(0, g.at - 200), g.at + 150),
      }));
      const i = text.search(new RegExp(`(?<!\\d)${id}(?!\\d)`));
      debug.idSnippet = i >= 0 ? text.slice(Math.max(0, i - 200), i + 300) : null;
    }
    const best = cands[0];
    if (best) {
      const dominant = cands.length === 1 || best.count >= 2 * cands[1].count;
      if (debug) debug.source = 'text-scan';
      return { lat: best.lat, lon: best.lon, sure: best.dist < 1500 || (dominant && best.count >= 2) };
    }
    if (jsonFallback && debug) debug.source = 'json-loose';
    return jsonFallback;
  }

  // One position lookup per listing, shared by map popups, list cards and the exact calculation.
  const posJobs = new Map();
  function listingPos(id, url) {
    if (!posJobs.has(id)) {
      posJobs.set(id, cached(`pos:${id}`, () => getListingCoords(id, null, url)).catch(() => null)
        .then((p) => { listPos.set(id, p || null); return p; }));
    }
    return posJobs.get(id);
  }

  // =====================================================================
  // Travel-time table: approximate commutes for lists, without any API calls
  // =====================================================================
  const KM_LAT = 111.2;
  const ACCESS_RADIUS_KM = 3;
  const tableMem = new Map(); // 'index' or table key → parsed copy, or null while there is none
  const tableJobs = new Map();
  const tablesFailed = new Set(); // no copy at all: fetch failed and nothing stored
  let onTableLoaded = () => {};

  // List of stops plus a grid of ~1 km cells, for fast lookups around a position.
  function indexTable(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.stops) || !Array.isArray(data.fields) || !data.destination) return null;
    const f = Object.fromEntries(data.fields.map((k, i) => [k, i]));
    const kmLon = KM_LAT * Math.cos((data.destination.lat * Math.PI) / 180);
    const grid = new Map();
    const stops = data.stops.map((r) => ({
      lat: r[f.lat], lon: r[f.lon], min: r[f.min], chg: r[f.chg] || 0, modes: r[f.modes] || '', last: r[f.last] ?? null, name: r[f.name] || '',
    }));
    for (const s of stops) {
      const k = `${Math.floor(s.lat * KM_LAT)},${Math.floor(s.lon * kmLon)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(s);
    }
    const ageDays = Math.floor((Date.now() - new Date(data.generated).getTime()) / 86400000);
    return { data, stops, grid, kmLon, dest: data.destination, ageDays, stale: ageDays > TABLE_STALE_DAYS };
  }
  // The index of published tables: [{ key, name, label, lat, lon }]
  const parseIndex = (data) => (data && data.version === 1 && Array.isArray(data.tables) ? data.tables.filter((t) => t.key && t.lat) : null);
  const remoteFile = (name) => (name === 'index' ? 'tables.json' : `travel-times-${name}.json`);
  const parseRemote = (name, data) => (name === 'index' ? parseIndex(data) : indexTable(data));

  // The stored copy, right away. Fetched on first use and then once a week; a failed fetch keeps the stored copy.
  function tableNow(name) {
    if (!tableMem.has(name)) {
      const stored = GM_getValue(`table:${name}`, null);
      const v = stored ? parseRemote(name, stored.data) : null;
      tableMem.set(name, v);
      const oldIndex = name === 'index' && v && !v.every((m) => m.generated); // from before the index had build times
      if (!v || oldIndex || Date.now() - stored.t > (name === 'index' ? INDEX_TTL : TABLE_TTL)) refreshTable(name);
    }
    const v = tableMem.get(name);
    // A table rebuilt since our copy (the index says so) is fetched again right away.
    if (v && name !== 'index' && !tableJobs.has(name)) {
      const meta = (tableMem.get('index') || []).find((m) => m.key === name);
      if (meta && meta.generated && meta.generated > v.data.generated) refreshTable(name);
    }
    return v;
  }
  function refreshTable(name) {
    if (!tableJobs.has(name)) {
      tableJobs.set(name, gmJson(TABLE_BASE + remoteFile(name)).then((data) => {
        const v = parseRemote(name, data);
        if (!v) throw new Error('Okänd tabell');
        GM_setValue(`table:${name}`, { t: Date.now(), data });
        tableMem.set(name, v);
        onTableLoaded();
        return v;
      }).catch(() => {
        const v = tableMem.get(name) || null;
        if (!v) { tablesFailed.add(name); onTableLoaded(); } // nothing to show: fall back to the old per-card button
        return v;
      }));
    }
    return tableJobs.get(name);
  }

  const mainDestOf = (c) => c.destinations.slice().sort((a, b) => (b.weight || 1) - (a.weight || 1))[0];
  // Which published table belongs to a destination: the one whose stop is within 500 m of it.
  const tableMetaFor = (d) => (d && d.lat ? (tableNow('index') || TABLES).find((m) => haversineKm(d, m) < 0.5) || null : null);

  const tableIndex = () => tableNow('index') || TABLES;
  // Your resmål that have a published table.
  const myTables = (c) => {
    const out = [];
    for (const d of c.destinations) { const m = tableMetaFor(d); if (m && !out.includes(m)) out.push(m); }
    return out;
  };
  // The tables the lists use, as [{ meta, t }]: the destination chosen in the filter bar, or "Mina resmål"
  // (your resmål with a table, else the first published one). main = true: only your main resmål, for the
  // placeholder before an exact value. t is the table, or 'loading' while its first copy is on its way.
  function tablesFor(c, main = false) {
    let metas;
    if (main) metas = [tableMetaFor(mainDestOf(c))].filter(Boolean);
    else if (c.list.dest === 'off') metas = [];
    else if (c.list.dest && c.list.dest !== 'mine') metas = [tableIndex().find((m) => m.key === c.list.dest) || tableIndex()[0]];
    else { metas = myTables(c); if (!metas.length) metas = [tableIndex()[0]]; }
    const out = [];
    for (const meta of metas) {
      const t = tableNow(meta.key);
      if (t) out.push({ meta, t });
      else if (!tablesFailed.has(meta.key)) out.push({ meta, t: 'loading' });
    }
    return out;
  }
  const estimateMain = (p, c) => {
    const [x] = tablesFor(c, true);
    return x ? { e: estimate(p, c, x.t), t: x.t } : { e: null };
  };

  // Approximate commute from any position: walk or cycle (straight line × 1.3) to a stop in the table, plus that
  // stop's minutes; or walk or cycle the whole way. No network calls.
  function estimate(p, c, t) {
    if (!p || !t || typeof t !== 'object') return null;
    let best = null;
    const consider = (o) => { if (!best || o.mins < best.mins) best = o; };
    const cy = Math.floor(p.lat * KM_LAT), cx = Math.floor(p.lon * t.kmLon), r = Math.ceil(ACCESS_RADIUS_KM);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      for (const s of t.grid.get(`${cy + dy},${cx + dx}`) || []) {
        const km = haversineKm(p, s);
        if (km > ACCESS_RADIUS_KM) continue;
        const via = { via: s.name, chg: s.chg, modes: s.modes, last: s.last, ride: s.min };
        const walk = minsAt(km * 1.3, c.walkSpeed);
        if (walk <= c.accessMax) consider({ mins: walk + s.min, access: { how: 'walk', mins: walk }, ...via });
        if (c.accessModes.bike) {
          const bike = minsAt(km * 1.3, c.bikeSpeed);
          if (bike <= c.accessMax) consider({ mins: bike + c.stationBuffer + s.min, access: { how: 'bike', mins: bike }, ...via });
        }
      }
    }
    const km = haversineKm(p, t.dest) * 1.3;
    for (const [how, on, kmh] of [['walk', c.accessModes.walk, c.walkSpeed], ['bike', c.accessModes.bike, c.bikeSpeed]]) {
      const mins = minsAt(km, kmh);
      if (on && mins <= c.directMax) consider({ mins, access: { how, mins }, direct: true, via: null, chg: 0, modes: '', last: null });
    }
    return best;
  }

  // For the map shading: can anywhere in the rectangle [s, w, n, e] (a point when s = n and w = e) reach the
  // destination within `max` minutes? The same sums as estimate(), measured from the rectangle's nearest point,
  // but it stops at the first way that works, skips stops that can't help, and uses flat distances (fine over a
  // few kilometres). Much faster than estimate() in the dense city centre.
  function reachable(rect, c, t, max) {
    const [s, w, n, e] = rect;
    const kmLon = t.kmLon;
    const distKm = (p) => {
      const dy = (p.lat - Math.min(n, Math.max(s, p.lat))) * KM_LAT, dx = (p.lon - Math.min(e, Math.max(w, p.lon))) * kmLon;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const direct = distKm(t.dest) * 1.3;
    for (const [on, kmh] of [[c.accessModes.walk, c.walkSpeed], [c.accessModes.bike, c.bikeSpeed]]) {
      if (on && minsAt(direct, kmh) <= Math.min(c.directMax, max)) return true;
    }
    const reachKm = (kmh, spare) => Math.min(ACCESS_RADIUS_KM, ((Math.min(c.accessMax, spare) + 0.5) / 60) * kmh / 1.3);
    const reach = Math.max(reachKm(c.walkSpeed, max), c.accessModes.bike ? reachKm(c.bikeSpeed, max - c.stationBuffer) : 0);
    if (reach <= 0) return false;
    const r = Math.ceil(reach);
    for (let cy = Math.floor(s * KM_LAT) - r; cy <= Math.floor(n * KM_LAT) + r; cy++) {
      for (let cx = Math.floor(w * kmLon) - r; cx <= Math.floor(e * kmLon) + r; cx++) {
        for (const st of t.grid.get(`${cy},${cx}`) || []) {
          if (st.min > max) continue;
          const km = distKm(st);
          if (km > reach) continue;
          const walk = minsAt(km * 1.3, c.walkSpeed);
          if (walk <= c.accessMax && walk + st.min <= max) return true;
          if (c.accessModes.bike) {
            const bike = minsAt(km * 1.3, c.bikeSpeed);
            if (bike <= c.accessMax && bike + c.stationBuffer + st.min <= max) return true;
          }
        }
      }
    }
    return false;
  }

  const MONTHS = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const fmtDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const TABLE_ICON = { t: ICON.train, s: ICON.tram, b: ICON.bus, f: ICON.ferry };
  const estText = (e, meta) => `${e ? `ca ${e.mins} min` : 'pendling okänd'} till ${meta.label}`;
  function estTitle(e, t, c) {
    if (!e) return `Ingen hållplats eller väg inom räckhåll i tidtabellen till ${t.dest.name}.`;
    const way = (a) => (a.how === 'bike' ? 'Cykla' : 'Gå');
    const parts = [];
    if (e.direct) parts.push(`${way(e.access)} hela vägen, ${e.access.mins} min`);
    else {
      parts.push(`${way(e.access)} ${e.access.mins} min till ${e.via}${e.access.how === 'bike' && c.stationBuffer ? `, ${c.stationBuffer} min att parkera` : ''}`);
      parts.push(`sedan ${e.ride} min ${[...e.modes].map((m) => TABLE_ICON[m] || '').join('')} ${e.chg ? changesText(e.chg) : 'direkt'}`.replace(/\s+/g, ' '));
      if (e.last) parts.push(`sista resan hem ${e.last}`);
    }
    parts.push(`Uppskattning från tidtabellen ${fmtDay(t.data.serviceDate)}, framme ${t.data.arriveBy}`);
    return parts.join('. ') + '.';
  }

  // ---------- positions for result-list cards ----------
  // Booli's result pages carry the listings' data for the map. Pick out each listing's position from it.
  function positionsIn(doc, ids) {
    const want = new Set(ids);
    const found = new Map();
    const visit = (root) => (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 60 || found.size === want.size) return;
      if (!Array.isArray(o)) {
        for (const k of ['booliId', 'listingId', 'id']) {
          const v = o[k];
          if ((typeof v !== 'string' && typeof v !== 'number') || !want.has(String(v)) || found.has(String(v))) continue;
          const c = findCoords(o, String(v));
          if (c && c.sure) found.set(String(v), { lat: c.lat, lon: c.lon, sure: true });
        }
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    })(root, 0);
    for (const s of doc.querySelectorAll('script')) {
      const t = s.textContent.trim();
      if (!(t.startsWith('{') || t.startsWith('[')) && s.type !== 'application/json' && s.type !== 'application/ld+json') continue;
      try { visit(JSON.parse(t)); } catch {}
    }
    const flight = flightText(doc);
    for (const line of flight.split('\n')) {
      if (found.size === want.size) break;
      const i = line.indexOf(':');
      if (i < 0 || !/[[{]/.test(line[i + 1] || '')) continue;
      try { visit(JSON.parse(line.slice(i + 1))); } catch {}
    }
    // Last resort: a coordinate pair whose nearest listing id in the text is this one.
    const rest = ids.filter((id) => !found.has(id));
    if (rest.length) {
      const text = flight + [...doc.querySelectorAll('script')].map((s) => s.textContent).join('\n');
      const mentions = [...text.matchAll(/(?<!\d)(\d{5,9})(?!\d)/g)].filter((m) => want.has(m[1])).map((m) => ({ id: m[1], at: m.index }));
      if (mentions.length) {
        for (const g of pairCandidates(text, '0')) {
          const near = mentions.reduce((a, b) => (Math.abs(b.at - g.at) < Math.abs(a.at - g.at) ? b : a));
          if (Math.abs(near.at - g.at) < 600 && rest.includes(near.id) && !found.has(near.id)) found.set(near.id, { lat: g.lat, lon: g.lon, sure: false });
        }
      }
    }
    return found;
  }

  const listPos = new Map(); // id → position, or null when it can't be found
  const parsedPages = new Set();
  const posQueue = [];
  let posActive = 0;
  let locating = false;
  let onPositions = () => {};
  function knownPos(id) {
    if (listPos.has(id)) return listPos.get(id);
    const p = cacheGet(`pos:${id}`);
    if (p) listPos.set(id, p);
    return p || undefined;
  }
  function pumpPositions() {
    while (posActive < 3 && posQueue.length) {
      const { id, url } = posQueue.shift();
      posActive++;
      listingPos(id, url).then((p) => { listPos.set(id, p || null); }).finally(() => { posActive--; onPositions(); pumpPositions(); });
    }
  }
  // Positions for the cards: from this page's data first, then from the page fetched once, then listing by listing
  // (at most 3 at a time). None of this costs any Trafiklab calls.
  async function locateCards(cards) {
    const missing = () => cards.filter((x) => knownPos(x.id) === undefined && !posQueue.some((q) => q.id === x.id) && !posJobs.has(x.id));
    const keep = (found) => {
      loadCache();
      for (const [id, p] of found) { listPos.set(id, p); cacheMem[CACHE_NS + `pos:${id}`] = { t: Date.now(), v: p }; }
      if (found.size) GM_setValue('cache', cacheMem);
    };
    if (locating || !missing().length) return;
    locating = true;
    try { await locateFrom(location.href, missing, keep); } finally { locating = false; }
    for (const x of missing()) posQueue.push({ id: x.id, url: x.url });
    pumpPositions();
  }
  async function locateFrom(page, missing, keep) {
    if (!parsedPages.has(`doc:${page}`)) {
      parsedPages.add(`doc:${page}`);
      keep(positionsIn(document, missing().map((x) => x.id)));
    }
    if (missing().length > 3 && !parsedPages.has(`get:${page}`)) {
      parsedPages.add(`get:${page}`);
      try {
        const html = await (await fetch(page, { credentials: 'include' })).text();
        keep(positionsIn(new DOMParser().parseFromString(html, 'text/html'), missing().map((x) => x.id)));
      } catch {}
      onPositions();
    }
  }

  // =====================================================================
  // Evaluation + score
  // =====================================================================
  async function evaluate(p, c) {
    const pk = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    const prod = productsOf(c);
    const tk = `${c.timeMode}:${c.time}:${prod}`;

    // Nearby train stations and how to reach the two closest
    let stations = [], stationError = null;
    try { stations = await cached(`st:${pk}:${c.radius}`, () => nearbyStations(p, c)); } catch (e) { stationError = e.message; }
    const near = stations.slice(0, 2);
    await Promise.all(near.map(async (st, i) => {
      const [walk, bike, ride] = await Promise.all([
        soft(cached(`foot:${pk}:${st.id}`, () => routeKm('foot', p, st))),
        c.accessModes.bike ? soft(cached(`bike:${pk}:${st.id}`, () => routeKm('bike', p, st))) : null,
        i === 0 && c.accessModes.bus ? soft(cached(`trip:${pk}:${st.id}:${tk}`, () => commuteTrip(p, st.id, c))) : null,
      ]);
      st.walkKm = walk ? walk.km : (st.dist / 1000) * 1.3; // rough detour factor if routing fails
      st.opts = [];
      if (c.accessModes.walk) st.opts.push({ how: 'walk', mins: minsAt(st.walkKm, c.walkSpeed) });
      if (bike) st.opts.push({ how: 'bike', mins: minsAt(bike.km, c.bikeSpeed) });
      if (ride && ride.rides.length) st.opts.push({ how: 'transit', mins: ride.mins, rides: ride.rides });
      // If none of your chosen ways works (e.g. only bus, and no bus goes there), walking is what's left.
      if (!st.opts.length) st.opts.push({ how: 'walk', mins: minsAt(st.walkKm, c.walkSpeed) });
      st.best = st.opts.reduce((a, b) => (b.mins < a.mins ? b : a));
    }));

    const dests = await Promise.all(c.destinations.map(async (d) => {
      try {
        // Candidate 1: public transport door to door
        const doorP = cached(`trip:${pk}:${d.id}:${tk}`, () => commuteTrip(p, d.id, c));
        // Candidates 2+: walk or cycle to one of the two nearest stations, then public transport
        const comboPs = [];
        for (const st of near) {
          if (st.id === d.id) continue;
          for (const a of st.opts.filter((o) => o.how !== 'transit' && o.mins <= c.accessMax)) {
            const off = a.mins + c.stationBuffer;
            const key = `stn:${st.id}:${d.id}:${tk}:${c.timeMode === 'arrive' ? 0 : off}`;
            comboPs.push(soft(cached(key, () => commuteTrip({ id: st.id }, d.id, c, off))).then((t) => {
              if (!t || !t.rides.length) return null;
              const dep = addMins(t.dep, -off).iso;
              return { kind: a.how, station: st, access: a, dep, arr: t.arr, mins: minsBetween(dep, t.arr), rides: [a.how, ...t.rides], changes: t.changes };
            }));
          }
        }
        // Candidates: walk or cycle the whole way, if you'd walk or cycle and it's within your limit
        const [footAll, bikeAll] = await Promise.all([
          c.accessModes.walk && d.lat ? soft(cached(`foot:${pk}:${d.id}`, () => routeKm('foot', p, d))) : null,
          (c.accessModes.bike || c.details.bikeAll || c.kpis.includes('bike')) && d.lat ? soft(cached(`bike:${pk}:${d.id}`, () => routeKm('bike', p, d))) : null,
        ]);
        const target = `${commuteDate()}T${c.time}:00`;
        const direct = (mode, km, kmh) => {
          const mins = minsAt(km, kmh);
          if (mins > c.directMax) return null;
          const dep = c.timeMode === 'arrive' ? addMins(target, -mins).iso : target;
          const arr = c.timeMode === 'arrive' ? target : addMins(target, mins).iso;
          return { kind: `${mode}All`, mode, km, dep, arr, mins, rides: [mode], changes: 0 };
        };
        const door = await doorP;
        const routes = [
          ...(door ? [{ kind: 'door', ...door }] : []),
          ...(await Promise.all(comboPs)).filter(Boolean),
          footAll && direct('walk', footAll.km, c.walkSpeed),
          bikeAll && c.accessModes.bike && direct('bike', bikeAll.km, c.bikeSpeed),
        ].filter(Boolean);
        for (const rt of routes) rt.eff = rt.mins + rt.changes * c.changePenalty;
        routes.sort((a, b) => a.eff - b.eff);
        const route = routes[0] || null;

        // Last trip home follows the chosen route: if you cycled to the station, you go home via that station.
        let last = null;
        if (c.lastHome !== 'off' && route) {
          if (route.mode) {
            last = { always: true, mode: route.mode }; // walking or cycling home has no last departure
          } else if (route.kind === 'door') {
            last = await soft(cached(`last:${pk}:${d.id}:${c.lastHome}:${prod}`, () => lastTripHome(d.id, p, c)));
          } else {
            const t = await soft(cached(`laststn:${route.station.id}:${d.id}:${c.lastHome}:${prod}`, () => lastTripHome(d.id, { id: route.station.id }, c)));
            if (t) last = { ...t, rides: [...t.rides, route.kind] };
          }
        }
        const bike = bikeAll;
        return {
          d, route, last,
          door: route && route.kind !== 'door' ? routes.find((x) => x.kind === 'door') || null : null,
          bike: bike ? { km: bike.km, mins: minsAt(bike.km, c.bikeSpeed) } : null,
          eff: route ? route.eff : null,
        };
      } catch (e) {
        return { d, error: e.message };
      }
    }));

    return { p, station: near[0] || null, stationError, dests };
  }

  function score(r, c) {
    const parts = [];
    let cap = null;

    if (r.dests.length) {
      let sw = 0, ss = 0;
      for (const x of r.dests) {
        const w = Math.max(1, +x.d.weight || 1);
        x.s = x.route ? lin(x.eff, x.d.ideal, x.d.max) : 0;
        if (!x.route && !cap) cap = x.error ? `Kunde inte kontrollera ${x.d.name}` : `Ingen resa till ${x.d.name} med dina färdsätt`;
        else if (x.route && x.eff > x.d.max && !cap) cap = `Över din gräns på ${x.d.max} min till ${x.d.name}`;
        x.loss = w * (100 - x.s);
        sw += w; ss += w * x.s;
      }
      parts.push({ key: 'commute', label: 'Pendling', s: ss / sw, w: c.weights.commute });
    }

    const acc = r.station ? lin(r.station.best.mins, c.accessIdeal, c.accessMax) : 0;
    parts.push({ key: 'access', label: 'Till stationen', s: acc, w: c.weights.access });

    if (c.lastHome !== 'off' && r.dests.length) {
      let sw = 0, ss = 0;
      const ideal = nightMins(c.lastHomeIdeal), earliest = nightMins(c.lastHomeEarliest);
      for (const x of r.dests) {
        const w = Math.max(1, +x.d.weight || 1);
        x.lastS = x.last && x.last.always ? 100 : x.last ? clamp((100 * (nightMins(hm(x.last.dep)) - earliest)) / Math.max(1, ideal - earliest), 0, 100) : 0;
        sw += w; ss += w * x.lastS;
      }
      parts.push({ key: 'lastHome', label: 'Sista resan hem', s: ss / sw, w: c.weights.lastHome });
    }

    const wsum = parts.reduce((s, x) => s + x.w, 0) || 1;
    let total = parts.reduce((s, x) => s + x.w * x.s, 0) / wsum;
    if (cap) total = Math.min(total, 40);
    total = Math.round(total / 5) * 5;

    let reason = cap;
    if (!reason) {
      const worst = parts.reduce((a, b) => (b.w * (100 - b.s) > a.w * (100 - a.s) ? b : a));
      if (total >= 90 || worst.s >= 99) reason = 'Uppfyller dina önskemål';
      else if (worst.key === 'commute') {
        const x = r.dests.reduce((a, b) => (b.loss > a.loss ? b : a));
        reason = `${x.eff - x.d.ideal} min över din önskade tid till ${x.d.name}${x.route.changes ? ', byten inräknade' : ''}`;
      } else if (worst.key === 'access') {
        reason = r.station
          ? `${r.station.best.mins - c.accessIdeal} min över din önskade tid till en station`
          : `Ingen tågstation inom ${c.radius / 1000} km`;
      } else {
        const x = r.dests.reduce((a, b) => (b.lastS < a.lastS ? b : a));
        reason = x.last ? `Sista resan hem går ${hm(x.last.dep)}, tidigare än du vill` : `Ingen sen resa hem från ${x.d.name}`;
      }
    }
    return { total, parts, reason, capped: !!cap };
  }

  // =====================================================================
  // Inline panel
  // =====================================================================
  const PANEL_CSS = `
    :host { display: block; margin: 32px 0 24px; font: inherit; color: inherit; }
    :host(.collapsed) { display: none; }
    :host(.floating) { position: fixed; left: 12px; right: 12px; bottom: 12px; margin: 0 0 0 auto;
      max-width: 420px; z-index: 2147483000; }
    :host(.floating) .panel { box-shadow: 0 8px 28px rgba(0, 0, 0, .18); }
    * { box-sizing: border-box; }
    .panel { background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; overflow: hidden; }
    .label { padding: 14px 16px 0; color: #6b6b6b; font-size: .9em; }
    .summary { display: flex; align-items: center; gap: 14px; width: 100%; padding: 8px 16px 14px;
      background: none; border: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; }
    .badge { flex: none; width: 54px; height: 54px; border-radius: 10px; display: grid; place-items: center;
      color: #fff; font-weight: 700; font-size: 1.4em; font-variant-numeric: tabular-nums; background: #9a9a9a; }
    .good { background: #1d7a46; } .ok { background: #a86400; } .poor { background: #b3261e; }
    .main { flex: 1; min-width: 0; }
    .line1 { font-weight: 600; }
    .line2 { margin-top: 1px; }
    .reason { margin-top: 3px; color: #6b6b6b; font-size: .88em; }
    .chev { flex: none; width: 20px; height: 20px; color: #6b6b6b; transition: transform .2s ease; }
    .summary[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .detail { border-top: 1px solid #ececec; padding: 2px 16px 14px; }
    .head { display: flex; align-items: center; gap: 14px; padding: 14px 16px; }
    .close { flex: none; align-self: flex-start; border: 0; background: none; font: inherit; color: #6b6b6b; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 10px 0;
      border-bottom: 1px solid #f0f0f0; color: inherit; text-decoration: none; }
    .row:hover .name { text-decoration: underline; }
    .name { font-weight: 600; }
    .sub { color: #6b6b6b; font-size: .88em; }
    .mins { font-weight: 700; font-size: 1.15em; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
    .mins small { display: block; font-weight: 400; font-size: .72em; color: #6b6b6b; }
    h3 { font-size: .9em; font-weight: 600; margin: 14px 0 6px; }
    .part { display: grid; grid-template-columns: 1fr 120px 2.2em; align-items: center; gap: 10px; padding: 3px 0; font-size: .92em; }
    .bar { height: 6px; border-radius: 3px; background: #ececec; overflow: hidden; }
    .bar i { display: block; height: 100%; background: #1d7a46; }
    .bar i.ok { background: #a86400; } .bar i.poor { background: #b3261e; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; color: #6b6b6b; font-size: .85em; }
    .btn { font: inherit; font-size: 1em; padding: 7px 12px; border-radius: 6px; border: 1px solid #1f1f1f; background: #fff; color: #1f1f1f; cursor: pointer; white-space: nowrap; }
    .btn.primary { background: #1f1f1f; color: #fff; }
    .err { color: #b3261e; }
    button:focus-visible, a:focus-visible { outline: 2px solid #1f1f1f; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }

    /* Details card (handoff part B) */
    .panel { border-color: #e6e5e2; border-radius: 12px; color: #1b1b1b; }
    .good { background: #2e7d4f; }
    .badge.big { width: 76px; height: 76px; border-radius: 12px; font-size: 34px; }
    .head { padding: 18px 20px; gap: 16px; }
    .head .line1 { font-size: 19px; font-weight: 600; }
    .head .reason { font-size: 16px; color: #5c5c5a; }
    .close { min-width: 44px; min-height: 44px; font-size: 18px; }
    .detail { padding: 0 20px 18px; border-top-color: #e6e5e2; }
    .group { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin: 22px 0 2px;
      font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #5c5c5a; }
    .group .addr { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 14px; }
    .row { padding: 14px 0; border-bottom: 1px solid #efeeeb; gap: 16px; }
    .row .l { flex: 1; min-width: 0; }
    .row .name { font-size: 19px; font-weight: 600; }
    .row .sub { font-size: 16px; color: #5c5c5a; }
    .row .r { flex: none; display: flex; flex-direction: column; align-items: flex-end; text-align: right; }
    .row .mins { font-size: 26px; font-weight: 700; line-height: 1.15; }
    .row .cap { font-size: 15px; color: #5c5c5a; }
    .delta { display: inline-block; margin-top: 4px; padding: 3px 8px; border-radius: 6px; font-size: 14px; font-weight: 600; white-space: nowrap; }
    .delta.worse { background: #f6ead2; color: #6e4700; }
    .delta.better { background: #e3f1e8; color: #1f5a37; }
    .delta.same { background: #f1f0ed; color: #3d3d3b; }
    .loading { color: #5c5c5a; font-size: 15px; padding: 12px 0; }
    .summary-box { background: #f6f5f2; border-radius: 10px; padding: 14px 16px; margin: 10px 0 12px; }
    .summary-box strong { display: block; font-size: 17px; }
    .summary-box span { color: #5c5c5a; font-size: 15px; }
    .tablewrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 15px; }
    th, td { text-align: left; padding: 9px 8px 9px 0; border-bottom: 1px solid #efeeeb; vertical-align: middle; }
    thead th { font-size: 13px; font-weight: 600; color: #5c5c5a; }
    tbody th { font-weight: 600; }
    td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td .delta { margin-top: 0; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .foot { font-size: 14px; color: #5c5c5a; }
    .foot small { display: block; font-size: 12px; margin-top: 2px; }
  `;
  const CHEVRON = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const tone = (s) => (s >= 75 ? 'good' : s >= 50 ? 'ok' : 'poor');

  const host = document.createElement('div');
  host.id = 'booli-commute-score';
  const root = host.attachShadow({ mode: 'open' });
  let state = { status: 'idle' };
  let expanded = false;
  let factEls = []; // our items in Booli's facts row, one per chosen KPI

  function toggle() {
    if (state.status === 'nokey') return openSettings(factEls[0]);
    expanded = !expanded;
    if (expanded) loadExtras();
    render();
  }
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'toggle') toggle();
    if (t.dataset.act === 'settings') openSettings(t);
    if (t.dataset.act === 'retryEv' && state.status === 'done') {
      Object.assign(state, { ev: null, evP: null, todayEv: null, todayEvP: null });
      loadExtras();
      render();
    }
  });

  const FACT_LABELS = ['Boarea', 'Biarea', 'Rum', 'Tomtarea', 'Byggår', 'Avgift', 'Våning', 'Driftkostnad'];

  // The smallest element that holds at least three of Booli's fact labels (Boarea, Rum, Byggår ...).
  function findFactsRow() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!FACT_LABELS.includes(node.nodeValue.trim())) continue;
      if (host.contains(node)) continue;
      let el = node.parentElement;
      while (el && el !== document.body) {
        const txt = el.textContent;
        if (FACT_LABELS.filter((l) => txt.includes(l)).length >= 3) return el;
        if (el.querySelector('h1')) break;
        el = el.parentElement;
      }
    }
    return null;
  }

  // Copy Booli's own "Byggår" item so ours gets exactly the same typography and spacing.
  function makeFact(row, spec) {
    const items = [...row.children].filter((ch) => ch !== host && !ch.hasAttribute('data-bcs'));
    if (!items.length) return null;
    const tpl = items.find((ch) => ch.textContent.includes('Byggår')) || items[items.length - 1];
    const el = tpl.cloneNode(true);
    el.setAttribute('data-bcs', '');
    el.removeAttribute('id');
    el.removeAttribute('href');
    el.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    let n;
    while ((n = w.nextNode())) if (n.nodeValue.trim()) texts.push(n);
    const label = texts.find((t) => FACT_LABELS.includes(t.nodeValue.trim())) || texts[0];
    const value = texts.find((t) => t !== label);
    if (!label || !value) return null;
    label.nodeValue = spec.label;
    el._spec = spec;
    for (const t of texts) if (t !== label && t !== value) t.nodeValue = '';
    const extra = document.createElement('span');
    extra.style.cssText = 'display:inline-flex;align-items:center;gap:.3em;margin-left:.35em;vertical-align:middle;';
    value.after(extra);
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;font-weight:600;line-height:1.3;margin-top:2px;';
    sub.hidden = true;
    const valueEl = value.parentElement;
    if (valueEl === el) el.appendChild(sub); else valueEl.after(sub);
    el._sub = sub;
    el.style.cursor = 'pointer';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    el._value = value;
    el._extra = extra;
    return el;
  }

  const TONE_COLOR = { good: '#1d7a46', ok: '#a86400', poor: '#b3261e' };
  const CHEV = (open) => `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" style="opacity:.55;transition:transform .2s;transform:rotate(${open ? 180 : 0}deg)"><path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const iconHtml = (icon) => (icon ? `<span aria-hidden="true" style="font-size:.85em">${icon}</span>` : '');
  // How you'd reach the station: 🚶 / 🚲 / 🚌 ...
  const accessIcon = (best) => (best.how === 'transit' ? ICON[best.rides[0]] || ICON.other : ICON[best.how]);
  const shortName = (n) => String(n).replace(/\s*Centralstation$/i, ' C').replace(/\s+station$/i, '');

  // Which KPI items to show, in order. "Varje resmål" expands to one item per destination.
  function kpiSpecs(c) {
    const out = [];
    for (const k of KPIS) {
      if (!c.kpis.includes(k.key) || !kpiAvailable(k, c)) continue;
      if (k.key === 'dests') for (const d of c.destinations) out.push({ id: `dest:${d.id}`, key: 'dests', label: `Till ${shortName(d.name)}`, dest: d });
      else out.push({ id: k.key, key: k.key, label: k.label });
    }
    return out;
  }

  // value: for the facts row, card: "value unit" text for the map card, extra: dot/icon html, title: longer explanation
  function kpiValue(spec, st, c) {
    const lower = spec.label.toLowerCase();
    if (st.status === 'loading' && spec.key === 'commute' && st.est) { // the table's estimate, until the exact value is ready
      return { value: `ca ${st.est.mins} min`, extra: '', card: `ca ${st.est.mins} min pendling` };
    }
    if (st.status !== 'done') {
      const v = st.status === 'error' ? '–' : '…';
      return { value: v, extra: '', card: `${v} ${lower}` };
    }
    const { r, sc } = st;
    const main = mainDest(r);
    const none = (text) => ({ value: text, extra: '', card: `${lower}: ${text.toLowerCase()}` });
    const pending = () => ({ value: '…', extra: '', card: `… ${lower}` });
    const mins = (m, unit, extra = '', title) => ({ value: `${m} min`, extra, card: `${m} min ${unit}`, title });
    switch (spec.key) {
      case 'score':
        return { value: String(sc.total), extra: dotHtml(tone(sc.total)), card: `${sc.total} poäng`, title: sc.reason };
      case 'commute':
        if (!main || !main.route) return none('Ingen resa');
        const v = mins(main.route.mins, 'pendling', c.kpis.includes('score') ? '' : dotHtml(tone(sc.total)),
          `Pendlingspoäng ${sc.total} av 100. ${sc.reason}`);
        const tm = c.home && c.showTodayDelta && st.today && st.today.r.dests.find((y) => y.d.id === main.d.id);
        v.delta = tm ? deltaMins(main.route.mins, tm.route && tm.route.mins) : null;
        if (v.delta) v.card += ` (${v.delta.short})`;
        return v;
      case 'station':
        if (!r.station) return none('Ingen nära');
        return mins(r.station.best.mins, 'till station', iconHtml(accessIcon(r.station.best)), `${r.station.name}, ${accessText(r.station.best)}`);
      case 'walk': {
        const w = r.station && r.station.opts.find((o) => o.how === 'walk');
        return w ? mins(w.mins, 'gång till station', '', r.station.name) : none('Ingen nära');
      }
      case 'transit': {
        const t = main && main.route && (main.route.kind === 'door' ? main.route : main.door);
        return t ? mins(t.mins, 'kollektivt', '', main.d.name) : none('Ingen resa');
      }
      case 'bike':
        return main && main.bike ? mins(main.bike.mins, 'cykel hela vägen', '', main.d.name) : none('–');
      case 'lastHome':
        if (!main || !main.last) return none('Ingen');
        if (main.last.always) return { value: 'Ingen gräns', extra: iconHtml(ICON[main.last.mode]), card: 'sista hem: ingen gräns',
          title: `Du ${main.last.mode === 'bike' ? 'cyklar' : 'går'} hela vägen` };
        return { value: hm(main.last.dep), extra: '', card: `sista hem ${hm(main.last.dep)}`, title: main.d.name };
      case 'grocery': {
        if (!st.ev) return pending();
        const g = st.ev.grocery;
        return g && !g.none ? mins(g.mins, 'till matbutik', iconHtml(ICON[g.mode]), `Närmaste livsmedelsbutik, ${km1(g.km)} km`) : none('Ingen nära');
      }
      case 'school': {
        if (!st.ev) return pending();
        const sch = st.ev.school;
        const t = sch && !sch.none && (sch.primary || sch.preschool);
        return t ? mins(t.mins, 'till skola', iconHtml(ICON[t.mode]), sch.primary ? `Närmaste grundskola, ${km1(t.km)} km` : `Närmaste förskola, ${km1(t.km)} km`) : none('Ingen nära');
      }
      case 'car': {
        if (!st.ev) return pending();
        const cm = main && st.ev.cars[main.d.id];
        return cm ? mins(cm.mins, 'med bil', iconHtml(ICON.car), `${main.d.name} i rusningstrafik (uppskattad), ${km1(cm.km)} km`) : none('–');
      }
      case 'dests': {
        const x = r.dests.find((y) => y.d.id === spec.dest.id);
        return x && x.route ? mins(x.route.mins, `till ${shortName(x.d.name)}`, '', x.d.name) : none('Ingen resa');
      }
    }
    return none('–');
  }

  const mainDest = (r) => r.dests.slice().sort((a, b) => (b.d.weight || 1) - (a.d.weight || 1))[0];
  const dotHtml = (toneCls) => (toneCls
    ? `<span aria-hidden="true" style="display:inline-block;width:.5em;height:.5em;border-radius:50%;background:${TONE_COLOR[toneCls]}"></span>`
    : '');
  function updateFact(el, value, extraHtml, open, aria, delta) {
    el._value.nodeValue = value;
    el._sub.hidden = !delta;
    if (delta) { el._sub.textContent = delta.short; el._sub.style.color = DELTA_TEXT[delta.kind]; }
    el._extra.innerHTML = extraHtml;
    el.setAttribute('aria-expanded', String(open));
    el.setAttribute('aria-label', aria);
  }

  function mount() {
    if (!listingId()) {
      host.remove();
      factEls.forEach((e) => e.remove());
      factEls = [];
      return;
    }
    const specs = kpiSpecs(cfg());
    const ids = specs.map((sp) => sp.id).join('|');
    const sameItems = (parent) => factEls.length === specs.length && factEls.map((e) => e._spec.id).join('|') === ids &&
      factEls.every((e) => e.isConnected && e.parentElement === parent);
    if (host.isConnected && host.previousElementSibling && sameItems(host.previousElementSibling)) return;
    const row = findFactsRow();
    if (row) {
      if (!sameItems(row)) {
        factEls.forEach((e) => e.remove());
        factEls = specs.map((sp) => makeFact(row, sp));
        if (factEls.some((e) => !e)) factEls = [];
        factEls.forEach((e) => row.appendChild(e));
      }
      host.classList.remove('floating');
      if (host.previousElementSibling !== row) row.after(host);
      render();
    } else if (!host.isConnected) {
      host.classList.add('floating');
      document.body.appendChild(host);
      render();
    }
  }

  const pill = (dl, short) => (dl ? `<span class="delta ${dl.kind}">${esc(short ? dl.short : dl.long)}</span>` : '');
  function rowHtml({ name, lines = [], mins, caption, delta, href }) {
    const inner = `<div class="l"><div class="name">${esc(name)}</div>${lines.map((l) => `<div class="sub">${esc(l)}</div>`).join('')}</div>
      <div class="r"><div class="mins">${esc(mins)}</div>${caption ? `<div class="cap">${esc(caption)}</div>` : ''}${delta || ''}</div>`;
    return href ? `<a class="row" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`;
  }
  const mapsLink = (p, to, mode) =>
    `https://www.google.com/maps/dir/?api=1&origin=${p.lat},${p.lon}&destination=${to.lat},${to.lon}&travelmode=${mode}`;
  const accessText = (b) => (b.how === 'walk' ? `${b.mins} min promenad` : b.how === 'bike' ? `${b.mins} min med cykel` : `${b.mins} min med ${modeNames(b.rides)}`);
  const groupHtml = (title, rows, aside = '') =>
    (rows ? `<h4 class="group"><span>${esc(title)}</span>${aside ? `<span class="addr">${esc(aside)}</span>` : ''}</h4>${rows}` : '');

  function detailHtml(st, c) {
    const { r, sc } = st;
    const D = c.details;
    const home = c.home && c.home.lat ? c.home : null;
    const tr = home && st.today ? st.today.r : null;
    const tev = home ? st.todayEv : null;
    const ev = st.ev;
    const showDelta = D.today && !!home;
    const dPill = (dl) => (showDelta ? pill(dl) : '');
    const tDest = (id) => tr && tr.dests.find((y) => y.d.id === id);
    const main = mainDest(r);
    const tMain = main && tDest(main.d.id);
    const needEv = c.everyday.car.on || c.everyday.grocery.on || c.everyday.school.on;

    // ---- PENDLING ----
    let pend = '';
    for (const x of r.dests) {
      const lines = [];
      const rt = x.route;
      if (x.error) lines.push(x.error);
      else if (rt) {
        if (D.route) lines.push(chain(rt.rides));
        if (D.times) lines.push(`Avresa ${hm(rt.dep)}, framme ${hm(rt.arr)}`);
        if (rt.mode) lines.push(`${rt.mode === 'bike' ? 'Cykla' : 'Gå'} hela vägen, ${km1(rt.km)} km`);
        if (rt.station && D.via) lines.push(`${rt.kind === 'bike' ? 'Cykla' : 'Gå'} ${rt.access.mins} min till ${rt.station.name}`);
        if (rt.kind !== 'door' && D.transitOnly && x.door) lines.push(`Bara kollektivtrafik: ${x.door.mins} min`);
      } else lines.push('Ingen resa hittades med dina färdsätt');
      if (D.lastHome && c.lastHome !== 'off' && !x.error && rt) {
        lines.push(x.last && x.last.always ? `Sista resan hem: ingen tidsgräns, du ${x.last.mode === 'bike' ? 'cyklar' : 'går'}` : x.last ? `Sista resan hem ${hm(x.last.dep)} ${NIGHTS[c.lastHome].label}: ${chain(x.last.rides)}` : `Ingen resa hem efter 18:00, ${NIGHTS[c.lastHome].label}`);
      }
      if (D.bikeAll && x.bike && x.bike.mins <= 120) lines.push(`${ICON.bike} hela vägen: ${x.bike.mins} min, ${x.bike.km.toFixed(0)} km`);
      const t = tDest(x.d.id);
      pend += rowHtml({
        name: x.d.name, lines,
        mins: rt ? `${rt.mins} min` : '–',
        caption: rt ? (rt.mode ? `${ICON[rt.mode]} hela vägen` : rt.changes ? changesText(rt.changes) : 'direkt') : '',
        delta: dPill(deltaMins(rt && rt.mins, t && t.route && t.route.mins)),
        href: x.d.lat ? mapsLink(r.p, x.d, 'transit') : null,
      });
    }
    if (D.station) {
      if (r.station) {
        const s2 = r.station;
        const alts = s2.opts.filter((o) => o !== s2.best).map((o) => `${o.how === 'transit' ? chain(o.rides) : ICON[o.how]} ${o.mins} min`);
        pend += rowHtml({
          name: s2.name,
          lines: [`Närmaste tågstation, ${km1(s2.walkKm)} km till fots`, ...(alts.length ? [alts.join('    ')] : [])],
          mins: `${s2.best.mins} min`,
          caption: s2.best.how === 'transit' ? `${chain(s2.best.rides)} ${modeNames(s2.best.rides)}` : `${ICON[s2.best.how]} ${NAME[s2.best.how]}`,
          delta: dPill(deltaMins(s2.best.mins, tr && tr.station && tr.station.best.mins)),
          href: mapsLink(r.p, s2, s2.best.how === 'walk' ? 'walking' : s2.best.how === 'bike' ? 'bicycling' : 'transit'),
        });
      } else {
        pend += rowHtml({ name: 'Ingen tågstation hittades', lines: [r.stationError || `Ingen inom ${c.radius / 1000} km`], mins: '–' });
      }
    }
    if (D.everyday && c.everyday.car.on) {
      if (!ev) pend += '<div class="loading">Räknar ut körtiden…</div>';
      else for (const x of r.dests) {
        const cm = ev.cars[x.d.id];
        if (!cm) continue;
        const tc = tev && tev.cars[x.d.id];
        pend += rowHtml({
          name: `Bil till ${shortName(x.d.name)}`,
          lines: [`Rusningstrafik, ${c.timeMode === 'arrive' ? 'framme' : 'avresa'} ${c.time} (uppskattad)`, `${km1(cm.km)} km`],
          mins: `${cm.mins} min`, caption: `${ICON.car} bil`,
          delta: dPill(deltaMins(cm.mins, tc && tc.mins)),
          href: mapsLink(r.p, x.d, 'driving'),
        });
      }
    }

    // ---- VARDAG ----
    let vardag = '';
    if (D.everyday && (c.everyday.grocery.on || c.everyday.school.on)) {
      if (!ev) vardag = '<div class="loading">Hämtar matbutik och skolor…</div>';
      else if (ev.error) vardag = `<div class="loading">Kunde inte hämta matbutik och skolor: ${esc(ev.error)}. <button class="btn" data-act="retryEv">Försök igen</button></div>`;
      else {
        if (c.everyday.grocery.on) {
          const g = ev.grocery;
          vardag += g && !g.none
            ? rowHtml({ name: 'Matbutik', lines: [`Närmaste livsmedelsbutik, ${km1(g.km)} km`], mins: `${g.mins} min`,
                caption: `${ICON[g.mode]} ${NAME[g.mode]}`, delta: dPill(deltaMins(g.mins, tev && tev.grocery && tev.grocery.mins)) })
            : rowHtml({ name: 'Matbutik', lines: [`Ingen inom ${PLACE_RADIUS / 1000} km`], mins: '–' });
        }
        if (c.everyday.school.on) {
          const sch = ev.school || { none: true };
          const lines = [];
          if (sch.primary) lines.push(`Grundskola ${km1(sch.primary.km)} km`);
          else lines.push(`Ingen grundskola inom ${PLACE_RADIUS / 1000} km`);
          if (sch.preschool) lines.push(`Förskola ${km1(sch.preschool.km)} km, ${sch.preschool.mins} min`);
          lines.push('Närmast betyder inte att ni får plats där. Kolla kommunens placeringsregler.');
          const t = sch.primary || sch.preschool;
          const ts = tev && tev.school && (tev.school.primary || tev.school.preschool);
          vardag += rowHtml({ name: 'Skola och förskola', lines, mins: t ? `${t.mins} min` : '–',
            caption: t ? `${ICON[t.mode]} ${NAME[t.mode]}` : '', delta: dPill(deltaMins(t && t.mins, ts && ts.mins)) });
        }
      }
    }

    // ---- JÄMFÖRT MED IDAG ----
    let compare = '';
    if (home && (D.today || D.compareTable)) {
      if (!tr) compare = '<div class="loading">Räknar ut hur det ser ut idag…</div>';
      else {
        const dl = main && main.route && tMain && tMain.route ? main.route.mins - tMain.route.mins : null;
        if (D.today && dl) {
          const H = Math.round((Math.abs(dl) * 2 * 220) / 60);
          compare += `<div class="summary-box"><strong>Ungefär ${H} ${H === 1 ? 'timme' : 'timmar'} ${dl > 0 ? 'mer' : 'mindre'} pendling per år</strong>
            <span>${Math.abs(dl)} min ${dl > 0 ? 'längre' : 'kortare'} åt varje håll, 220 arbetsdagar.</span></div>`;
        }
        if (D.compareTable) {
          const m = (v) => (v == null ? '–' : `${v} min`);
          const rows = [];
          const add = (label, here, today, dlt) => { if (here != null || today != null) rows.push([label, here, today, dlt]); };
          add('Pendling', m(main && main.route && main.route.mins), m(tMain && tMain.route && tMain.route.mins),
            deltaMins(main && main.route && main.route.mins, tMain && tMain.route && tMain.route.mins));
          add('Till station', m(r.station && r.station.best.mins), m(tr.station && tr.station.best.mins),
            deltaMins(r.station && r.station.best.mins, tr.station && tr.station.best.mins));
          if (c.everyday.car.on) {
            const a = ev && main && ev.cars[main.d.id], b = tev && main && tev.cars[main.d.id];
            add('Bil i rusning', a ? m(a.mins) : null, b ? m(b.mins) : null, deltaMins(a && a.mins, b && b.mins));
          }
          if (c.everyday.grocery.on) {
            const a = ev && ev.grocery && !ev.grocery.none ? ev.grocery : null, b = tev && tev.grocery && !tev.grocery.none ? tev.grocery : null;
            add('Matbutik', a ? m(a.mins) : null, b ? m(b.mins) : null, deltaMins(a && a.mins, b && b.mins));
          }
          if (c.everyday.school.on) {
            const a = ev && ev.school && ev.school.primary, b = tev && tev.school && tev.school.primary;
            add('Skola', a ? m(a.mins) : null, b ? m(b.mins) : null, deltaMins(a && a.mins, b && b.mins));
          }
          if (c.lastHome !== 'off') {
            const lv = (x) => (!x ? null : !x.last ? 'Ingen' : x.last.always ? 'Ingen gräns' : hm(x.last.dep));
            const a = lv(main), b = lv(tMain);
            const free = (v) => v === 'Ingen gräns';
            const dlt = free(a) || free(b)
              ? (free(a) && free(b) ? { kind: 'same', long: 'Samma som idag' } : free(a) ? { kind: 'better', long: 'Ingen tidsgräns' } : { kind: 'worse', long: 'Har en tidsgräns' })
              : deltaLastHome(a !== 'Ingen' ? a : null, b !== 'Ingen' ? b : null);
            add('Sista resan hem', a, b, dlt);
          }
          compare += `<div class="tablewrap"><table><caption class="sr">Den här bostaden jämfört med idag</caption>
            <thead><tr><th scope="col">Vad</th><th scope="col">Här</th><th scope="col">Idag</th><th scope="col">Skillnad</th></tr></thead>
            <tbody>${rows.map(([l, a, b, dlt]) => `<tr><th scope="row">${esc(l)}</th><td class="n">${esc(a == null ? '–' : a)}</td><td class="n">${esc(b == null ? '–' : b)}</td><td>${pill(dlt) || '–'}</td></tr>`).join('')}</tbody>
          </table></div>`;
        }
      }
    }

    // ---- SÅ RÄKNAS POÄNGEN ----
    const parts = sc.parts.map((pt) => {
      const v = Math.round(pt.s);
      return `<div class="part"><span>${esc(pt.label)}</span><span class="bar"><i class="${tone(v)}" style="width:${v}%"></i></span><span class="num">${v}</span></div>`;
    }).join('');

    const when = `${c.timeMode === 'arrive' ? 'Framme senast' : 'Avresa'} ${c.time} en vardag.${home ? ` Jämfört med ${home.label}.` : ''}`;
    const loose = r.p.sure ? '' : ' Positionen är osäker, kontrollera med en kartlänk.';
    const osm = needEv || home ? '<small>Platser, vägar och adresser: © OpenStreetMap-bidragsgivare.</small>' : '';
    return groupHtml('Pendling', pend) + groupHtml('Vardag', vardag) + groupHtml('Jämfört med idag', compare, home ? home.label : '') +
      (D.breakdown ? groupHtml('Så räknas poängen', parts) : '') +
      `<div class="foot"><span>${esc(when + loose)}${osm}</span><button class="btn" data-act="settings">Inställningar</button></div>`;
  }

  function render() {
    let badge = '…', badgeCls = '', l1 = '', l2 = '', reason = '', detail = '', value = '…';
    const c = cfg();
    if (state.status === 'nokey') {
      badge = '?';
      value = 'Ställ in';
      l1 = 'Pendlingspoäng';
      l2 = 'Lägg till en gratis API-nyckel från Trafiklab och dina resmål för att se hur bostaden passar din pendling.';
      detail = `<div class="foot"><span></span><button class="btn primary" data-act="settings">Öppna inställningar</button></div>`;
    } else if (state.status === 'loading') {
      l1 = state.est ? `Beräknar din pendling… (ca ${state.est.mins} min)` : 'Beräknar din pendling…';
    } else if (state.status === 'error') {
      badge = '!';
      value = '–';
      l1 = 'Kunde inte beräkna pendlingen';
      reason = `<span class="err">${esc(state.message)}</span>`;
      detail = `<div class="foot"><span></span><button class="btn" data-act="settings">Inställningar</button></div>`;
    } else if (state.status === 'done') {
      const { r, sc } = state;
      badge = String(sc.total);
      badgeCls = tone(sc.total);
      const main = mainDest(r);
      value = main && main.route ? `${main.route.mins} min` : 'Ingen resa';
      l1 = main ? `${main.d.name}${main.route ? ` ${main.route.mins} min` : ': ingen resa'}` : 'Inga resmål valda';
      l2 = r.station ? `${r.station.name}, ${accessText(r.station.best)}` : 'Ingen tågstation i närheten';
      reason = esc(sc.reason);
      detail = detailHtml(state, c);
    }

    // Normal case: a "Pendling" item in Booli's facts row, details open below the row when clicked.
    const factMode = factEls.length > 0 && factEls[0].isConnected && !host.classList.contains('floating');
    if (factMode) {
      const open = expanded && state.status !== 'loading';
      factEls.forEach((el, i) => {
        const isLast = i === factEls.length - 1;
        if (state.status === 'nokey') {
          el.style.display = i === 0 ? '' : 'none';
          updateFact(el, 'Ställ in', '', false, `${el._spec.label}. Öppna inställningar`, null);
          return;
        }
        el.style.display = '';
        if (i === 0 && state.status === 'done') saveSummary(listingId(), state, c);
        const v = kpiValue(el._spec, state, c);
        updateFact(el, v.value, v.extra + (isLast ? CHEV(open) : ''), open,
          `${el._spec.label} ${v.value}${v.delta ? `, ${v.delta.short}` : ''}${v.title ? `, ${v.title}` : ''}. Visa detaljer`, v.delta);
      });
      host.classList.toggle('collapsed', !open);
      if (!open) { root.innerHTML = ''; return; }
      const name = state.status === 'done' ? 'Pendlingspoäng' : l1;
      root.innerHTML = `<style>${PANEL_CSS}</style>
        <section class="panel" aria-label="Pendlingsdetaljer">
          <div class="head">
            <span class="badge big ${badgeCls}" aria-label="Poäng ${esc(badge)} av 100">${esc(badge)}</span>
            <span class="main"><div class="line1">${esc(name)}</div>${reason ? `<div class="reason">${reason}</div>` : ''}</span>
            <button class="close" data-act="toggle" aria-label="Stäng detaljer">✕</button>
          </div>
          <div class="detail">${detail}</div>
        </section>`;
      return;
    }

    // Fallback when the facts row can't be found: a self-contained panel.
    const canExpand = !!detail;
    const open = canExpand && (expanded || state.status === 'nokey');
    host.classList.remove('collapsed');
    root.innerHTML = `<style>${PANEL_CSS}</style>
      <section class="panel" aria-label="Pendlingspoäng">
        <div class="label">Pendlingspoäng</div>
        <button class="summary" ${canExpand ? 'data-act="toggle"' : 'disabled'} aria-expanded="${open}" aria-controls="detail">
          <span class="badge ${badgeCls}" aria-label="Poäng ${esc(badge)} av 100">${esc(badge)}</span>
          <span class="main">
            <div class="line1">${esc(l1)}</div>
            ${l2 ? `<div class="line2">${esc(l2)}</div>` : ''}
            ${reason ? `<div class="reason">${reason}</div>` : ''}
          </span>
          ${canExpand ? CHEVRON : ''}
        </button>
        ${open ? `<div class="detail" id="detail">${detail}</div>` : ''}
      </section>`;
  }

  // Everyday values and the "today" baseline load lazily: when the details open,
  // or straight away if the fact row needs them.
  function loadExtras() {
    const st = state;
    if (st.status !== 'done') return;
    const c = cfg();
    const needEv = c.everyday.grocery.on || c.everyday.school.on || c.everyday.car.on;
    if (st.ev && st.ev.error) { st.ev = null; st.evP = null; }
    if (needEv && !st.evP) st.evP = everydayFor(st.r.p, c).then((ev) => { st.ev = ev; if (state === st) render(); });
    if (needEv && c.home && !st.todayEvP) st.todayEvP = todayEveryday(c).then((ev) => { st.todayEv = ev; if (state === st) render(); });
  }

  // =====================================================================
  // Map popup cards
  // =====================================================================
  // The card that opens when you click a house on the map: it has a "Stäng" button and links to one listing.
  const LISTING_HREF = /\/(?:annons|bostad)\/(\d+)/;

  function findPopupCards() {
    const out = [];
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
      if (!/^stäng$/i.test(label)) continue;
      let el = btn.parentElement;
      for (let depth = 0; el && el !== document.body && depth < 10; depth++, el = el.parentElement) {
        const links = [...el.querySelectorAll('a[href]')].filter((a) => LISTING_HREF.test(a.getAttribute('href')));
        const ids = new Set(links.map((a) => a.getAttribute('href').match(LISTING_HREF)[1]));
        if (ids.size > 1) break; // climbed out of the card into a list
        if (ids.size === 1) {
          const href = links[0].getAttribute('href');
          out.push({ card: el, id: [...ids][0], url: new URL(href, location.href).href });
          break;
        }
      }
    }
    return out;
  }

  // The "117 m²  4 rum  1 286 m² tomt" line inside a card.
  function findCardFactsLine(card) {
    for (const el of card.querySelectorAll('*')) {
      if (el.closest('[data-bcs-card], [data-bcs-est]')) continue;
      if (!/^\d+([,.]\d+)?\s*rum$/i.test(el.textContent.trim())) continue;
      let line = el.parentElement;
      while (line && line !== card) {
        if (line.children.length >= 2 && line.textContent.includes('m²')) return line;
        line = line.parentElement;
      }
    }
    return null;
  }

  // Copy the line's last item ("1 286 m² tomt") so ours matches it.
  function makeCardItem(line) {
    const tpl = [...line.children].filter((ch) => !ch.hasAttribute('data-bcs-card') && !ch.hasAttribute('data-bcs-est') && !ch.hasAttribute('data-bcs-btn')).pop();
    const el = tpl.cloneNode(true);
    el.removeAttribute('id');
    el.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    let n;
    while ((n = w.nextNode())) if (n.nodeValue.trim()) texts.push(n);
    if (!texts.length) return null;
    texts.slice(1).forEach((t) => { t.nodeValue = ''; });
    const extra = document.createElement('span');
    extra.style.cssText = 'display:inline-flex;align-items:center;margin-left:.35em;vertical-align:middle;';
    texts[0].after(extra);
    el._value = texts[0];
    el._extra = extra;
    return el;
  }

  function setCardItem(el, text, extraHtml, title) {
    el._value.nodeValue = text;
    el._extra.innerHTML = extraHtml || '';
    if (title) el.title = title;
  }

  // A listing's card values are saved per listing and settings, so lists can show them later without any lookups.
  function settingsSig(c) {
    const str = JSON.stringify({ ...c, apiKey: '', list: undefined }); // list filters don't change any result
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function summaryOf(st, c) {
    const items = kpiSpecs(c).map((sp) => kpiValue(sp, st, c));
    if (items.some((v) => v.value === '…')) return null; // not complete yet
    return items.map((v) => ({ card: v.card, extra: v.extra || '', title: v.title || '' }));
  }
  const saveSummary = (id, st, c) => {
    const sum = summaryOf(st, c);
    if (sum) cachePut(`sum:${id}:${settingsSig(c)}`, sum);
    if (st.sc) cachePut(`scr:${id}:${settingsSig(c)}`, st.sc.total);
  };
  const savedSummary = (id, c, sig = settingsSig(c)) => cacheGet(`sum:${id}:${sig}`);
  const savedScore = (id, c, sig = settingsSig(c)) => cacheGet(`scr:${id}:${sig}`);

  const cardJobs = new Map(); // listing id -> promise of { r, sc }
  function cardCommute(id, url) {
    if (!cardJobs.has(id)) {
      cardJobs.set(id, (async () => {
        const c = cfg();
        const p = await listingPos(id, url);
        if (!p) throw new Error('Ingen position');
        const r = await evaluate(p, c);
        const needEv = c.kpis.some((k) => ['grocery', 'school', 'car'].includes(k));
        const [ev, today] = await Promise.all([
          needEv ? everydayFor(p, c) : null,
          c.home && c.showTodayDelta && c.kpis.includes('commute') ? todayBase(c) : null,
        ]);
        const res = { r, sc: score(r, c), ev, today };
        saveSummary(id, { status: 'done', ...res }, c);
        return res;
      })().catch((e) => { cardJobs.delete(id); throw e; }));
    }
    return cardJobs.get(id);
  }

  // Put our values into a card's facts line, then fill them in when the calculation is done.
  function fillCard(line, id, url, c) {
    const specs = kpiSpecs(c);
    const items = specs.map((sp) => { const el = makeCardItem(line); if (el) el._spec = sp; return el; });
    if (!items.length || items.some((e) => !e)) return false;
    for (const el of items) {
      el.setAttribute('data-bcs-card', id);
      line.appendChild(el);
    }
    const saved = savedSummary(id, c);
    if (saved && saved.length === items.length) {
      items.forEach((el, i) => setCardItem(el, saved[i].card, saved[i].extra, saved[i].title));
      return true;
    }
    for (const el of items) setCardItem(el, kpiValue(el._spec, { status: 'loading' }, c).card);
    // Until the exact value is ready, show the table's estimate in its place.
    let done = false;
    listingPos(id, url).then((p) => {
      const { e, t } = estimateMain(p, c);
      if (done || !e) return;
      for (const el of items) if (el._spec.key === 'commute' && el.isConnected) setCardItem(el, `ca ${e.mins} min pendling`, '', estTitle(e, t, c));
    });
    cardCommute(id, url).then((res) => {
      done = true;
      for (const el of items) {
        if (!el.isConnected) continue;
        const v = kpiValue(el._spec, { status: 'done', ...res }, c);
        setCardItem(el, v.card, v.extra, v.title);
      }
    }).catch(() => {
      done = true;
      for (const el of items) if (el.isConnected) setCardItem(el, kpiValue(el._spec, { status: 'error' }, c).card);
    });
    return true;
  }

  // Map popups calculate straight away: you opened that one house on purpose. Without a key they show the estimate.
  function decorateCards() {
    const c = cfg();
    const specs = kpiSpecs(c);
    for (const { card, id, url } of findPopupCards()) {
      card.setAttribute('data-bcs-popup', '');
      card.querySelectorAll('[data-bcs-btn]').forEach((b) => b.remove());
      const line = findCardFactsLine(card);
      if (!c.apiKey) {
        const ts = tablesFor(c);
        if (!line || !ts.length) continue;
        if (knownPos(id) === undefined) listingPos(id, url).then(() => onPositions());
        estimateItems(line, id, c, ts, settingsSig(c));
        continue;
      }
      card.querySelectorAll('[data-bcs-est]').forEach((e) => e.remove());
      const existing = [...card.querySelectorAll('[data-bcs-card]')];
      if (existing.length === specs.length && existing.every((e) => e.dataset.bcsCard === id)) continue;
      existing.forEach((e) => e.remove()); // the card switched to another house
      if (line) fillCard(line, id, url, c);
    }
    decorateListCards(c);
    scheduleMap();
  }

  function findListCards() {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(LISTING_HREF);
      if (!m || seen.has(a)) continue;
      const id = m[1];
      if (location.pathname.includes(`/${id}`)) continue; // the listing page's own house
      let el = a;
      for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
        const ids = new Set([...el.querySelectorAll('a[href]')].map((x) => ((x.getAttribute('href') || '').match(LISTING_HREF) || [])[1]).filter(Boolean));
        if (ids.size > 1) break; // climbed into the list itself
        const line = findCardFactsLine(el);
        if (line) {
          el.querySelectorAll('a[href]').forEach((x) => seen.add(x));
          out.push({ card: el, line, id, url: new URL(a.getAttribute('href'), location.href).href });
          break;
        }
      }
    }
    return out;
  }

  const BTN_CSS = 'display:inline-flex;align-items:center;gap:.3em;margin-left:.6em;padding:.15em .7em;border:1px solid #cfcecb;' +
    'border-radius:999px;background:#fff;color:#1b1b1b;font:inherit;font-size:.85em;line-height:1.6;cursor:pointer;vertical-align:middle;white-space:nowrap;';

  // Result lists: every card shows the estimate to each of your resmål that has a table,
  // with the score dot if the exact score is already saved.
  function decorateListCards(c) {
    const cards = findListCards().filter(({ card }) => !card.closest('[data-bcs-popup]') && !card.querySelector('[data-bcs-popup]'));
    const ts = cards.length ? tablesFor(c) : [];
    if (!ts.length) {
      resetList();
      if (c.apiKey) decorateListButtons(cards, c);
      return;
    }
    if (ts.some((x) => x.t !== 'loading')) locateCards(cards);
    const sig = settingsSig(c);
    for (const x of cards) x.est = estimateItems(x.line, x.id, c, ts, sig);
    filterList(cards, c, ts);
  }

  // One "ca 34 min till Göteborg C" item per table in a card's facts line. Only touches the page when something changed.
  // Returns the longest estimate, or null when any of them is unknown.
  function estimateItems(line, id, c, ts, sig) {
    line.querySelectorAll('[data-bcs-card], [data-bcs-btn]').forEach((e) => e.remove());
    const keys = ts.map((x) => `${id}:${x.meta.key}`);
    line.querySelectorAll('[data-bcs-est]').forEach((el) => { if (!keys.includes(el.dataset.bcsEst)) el.remove(); });
    const p = knownPos(id);
    const sc = savedScore(id, c, sig);
    let worst = null, unknown = false;
    ts.forEach((x, i) => {
      let el = line.querySelector(`[data-bcs-est="${keys[i]}"]`);
      if (!el) {
        el = makeCardItem(line);
        if (!el) return;
        el.setAttribute('data-bcs-est', keys[i]);
        line.appendChild(el);
      }
      const ready = x.t !== 'loading' && p !== undefined;
      const e = ready && p ? estimate(p, c, x.t) : null;
      if (!e) unknown = true;
      else if (!worst || e.mins > worst.mins) worst = e;
      const text = ready ? estText(e, x.meta) : `… till ${x.meta.label}`;
      const extra = i === 0 && sc != null ? dotHtml(tone(sc)) : '';
      const title = !ready ? '' : (p ? estTitle(e, x.t, c) : 'Bostadens position hittades inte.') + (i === 0 && sc != null ? ` Pendlingspoäng ${sc} av 100.` : '');
      const key = `${text}|${extra}|${title}`;
      if (el._key !== key) {
        el._key = key;
        setCardItem(el, text, extra);
        el.title = title;
      }
    });
    return unknown ? null : worst;
  }

  // ---------- filter bar ----------
  // A section under Booli's Sökfilter row. Its controls copy the look of Booli's own buttons.
  const CHEVRON_BG = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 20 20"><path d="M5 7.5l5 5 5-5" fill="none" stroke="#1b1b1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}")`;
  const FALLBACK_LOOK = { font: 'inherit', size: '16px', weight: '400', color: '#1b1b1b', bg: '#fff', border: '1px solid #cfcecb', radius: '6px', height: '48px', pad: '16px' };
  let filterBar = null;

  // Booli's Sökfilter button, the "Spara sökning" button next to it, and the row holding both.
  function booliControls() {
    const buttons = [...document.querySelectorAll('button, a')].filter((b) => !b.closest('[data-bcs-filter]'));
    const filter = buttons.find((b) => /^Sökfilter/.test(b.textContent.trim())); // "Sökfilter1": the badge follows without a space
    if (!filter) return null;
    const save = buttons.find((b) => /^Spara sökning/.test(b.textContent.trim()));
    let row = filter.parentElement;
    if (save) while (row && row !== document.body && !row.contains(save)) row = row.parentElement;
    if (!row || row === document.body) row = filter.parentElement;
    return { filter, save, row };
  }
  const lookOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { font: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, color: cs.color, bg: cs.backgroundColor,
      border: cs.borderTopWidth ? `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` : cs.border, radius: cs.borderTopLeftRadius || cs.borderRadius,
      height: parseFloat(cs.height) > 0 ? cs.height : FALLBACK_LOOK.height, pad: parseFloat(cs.paddingLeft) > 0 ? cs.paddingLeft : FALLBACK_LOOK.pad };
  };
  const lookStyle = (l) => ({ 'box-sizing': 'border-box', 'font-family': l.font, 'font-size': l.size, 'font-weight': l.weight, color: l.color,
    'background-color': l.bg, border: l.border, 'border-radius': l.radius, height: l.height, padding: `0 ${l.pad}`, margin: '0', cursor: 'pointer' });
  // One property at a time, skipping empty ones, and only when something changed.
  function applyStyle(el, style) {
    const sig = JSON.stringify(style);
    if (el._bcsStyle === sig) return;
    el._bcsStyle = sig;
    el.removeAttribute('style');
    for (const [k, v] of Object.entries(style)) if (v && !/^\s|\s$|^0 $/.test(String(v))) el.style.setProperty(k, String(v));
  }

  function makeFilterBar() {
    const bar = document.createElement('section');
    bar.setAttribute('data-bcs-filter', '');
    bar.setAttribute('aria-label', 'Pendling');
    const small = 'font-size:14px;line-height:1.3;color:#6b6b69';
    const field = (label, f) => `<label style="display:flex;flex-direction:column;gap:4px;min-width:0"><span style="${small}">${label}</span><select data-f="${f}"></select></label>`;
    bar.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px 16px;align-items:end">
        ${field('Pendling till', 'dest')}${field('Max restid', 'max')}${field('Över gränsen', 'over')}
        <button type="button" data-f="sort" aria-pressed="false"><span aria-hidden="true">↕</span>Sortera efter pendling</button>
      </div>
      <div data-f="info" style="${small};margin-top:8px"></div>`;
    bar.querySelector('[data-f="max"]').innerHTML = `<option value="0">Alla</option>${LIST_MAXES.map((m) => `<option value="${m}">${m} min</option>`).join('')}`;
    bar.querySelector('[data-f="over"]').innerHTML = '<option value="dim">Tona ner</option><option value="hide">Dölj</option>';
    const update = (fn) => {
      const c = cfg();
      c.list = fn({ ...c.list });
      saveCfg(c);
      decorateCards();
    };
    bar.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f === 'dest') update((l) => ({ ...l, dest: e.target.value }));
      if (f === 'max') update((l) => ({ ...l, max: +e.target.value }));
      if (f === 'over') update((l) => ({ ...l, over: e.target.value }));
    });
    bar.addEventListener('click', (e) => {
      if (!e.target.closest('[data-f="sort"]')) return;
      e.preventDefault();
      update((l) => ({ ...l, sort: !l.sort }));
    });
    return bar;
  }

  // Put the bar under Booli's Sökfilter row (or above the list), and keep its controls looking like Booli's.
  function placeFilterBar(c, box) {
    if (!filterBar) filterBar = makeFilterBar();
    const ctl = booliControls();
    if (ctl) {
      if (ctl.row.nextElementSibling !== filterBar) ctl.row.after(filterBar);
    } else if (filterBar.nextElementSibling !== box) box.before(filterBar);
    // Spacing: the parent's own gap if it has one, else the same space as above Booli's row.
    const parent = filterBar.parentElement;
    const pcs = getComputedStyle(parent);
    const gap = /flex|grid/.test(pcs.display) && parseFloat(pcs.rowGap) > 0;
    const prev = ctl && ctl.row.previousElementSibling;
    const above = prev ? ctl.row.getBoundingClientRect().top - prev.getBoundingClientRect().bottom : 0;
    setStyle(filterBar, 'margin', gap ? '0' : `${above > 0 ? Math.round(above) : 24}px 0 ${ctl ? 0 : 16}px`);
    const off = lookOf(ctl && ctl.filter) || FALLBACK_LOOK;
    const on = lookOf(ctl && ctl.save) || { ...off, color: '#fff', bg: '#1b1b1b', border: '1px solid #1b1b1b' };
    const selectStyle = { ...lookStyle(off), width: '100%', appearance: 'none', '-webkit-appearance': 'none', 'padding-right': '44px',
      'background-image': CHEVRON_BG, 'background-repeat': 'no-repeat', 'background-position': 'right 16px center' };
    for (const sel of filterBar.querySelectorAll('select')) applyStyle(sel, selectStyle);
    applyStyle(filterBar.querySelector('[data-f="sort"]'), { ...lookStyle(c.list.sort ? on : off), display: 'inline-flex', 'align-items': 'center',
      'justify-content': 'center', gap: '.4em', width: '100%', 'white-space': 'nowrap' });
  }

  // The list itself: the deepest element holding most of the cards, so a stray card elsewhere on the page
  // (a carousel, a map popup) doesn't move the bar out to some page-wide container.
  function listBox(cards) {
    const need = Math.max(1, Math.ceil(cards.length * 0.6));
    const counts = new Map();
    for (const x of cards) for (let el = x.card.parentElement; el && el !== document.body; el = el.parentElement) counts.set(el, (counts.get(el) || 0) + 1);
    let best = null, bestDepth = -1;
    for (const [el, n] of counts) {
      if (n < need) continue;
      let depth = 0;
      for (let q = el; q; q = q.parentElement) depth++;
      if (depth > bestDepth) { best = el; bestDepth = depth; }
    }
    return best;
  }
  const itemIn = (box, el) => { while (el && el.parentElement !== box) el = el.parentElement; return el; };
  const setStyle = (el, prop, v) => { if (el.style[prop] !== v) el.style[prop] = v; };

  // Hide or dim listings over the limit, and order the loaded cards by commute (Booli's own sort is left alone).
  function filterList(cards, c, ts) {
    const box = listBox(cards);
    if (!box || box === document.body || box === document.documentElement) return;
    placeFilterBar(c, box);
    const max = +c.list.max || 0;
    const q = (f) => filterBar.querySelector(`[data-f="${f}"]`);
    // Destinations: "Mina resmål" when some of yours have a table, then every published table.
    const mine = myTables(c);
    const opts = [...(mine.length ? [['mine', `Mina resmål (${mine.map((m) => m.label).join(', ')})`]] : []), ...tableIndex().map((m) => [m.key, m.label])];
    const optsSig = JSON.stringify(opts);
    if (q('dest')._sig !== optsSig) {
      q('dest')._sig = optsSig;
      q('dest').innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    }
    const dest = opts.some(([v]) => v === c.list.dest) ? c.list.dest : ts.length === 1 ? ts[0].meta.key : opts[0][0];
    if (q('dest').value !== dest) q('dest').value = dest;
    if (q('max').value !== String(max)) q('max').value = String(max);
    if (q('over').value !== c.list.over) q('over').value = c.list.over;
    q('over').disabled = !max;
    q('sort').setAttribute('aria-pressed', String(!!c.list.sort));

    const rows = cards.filter((x) => box.contains(x.card)).map((x, i) => ({ ...x, item: itemIn(box, x.card), i })).filter((r) => r.item);
    let over = 0;
    for (const r of rows) {
      const mode = max && r.est && r.est.mins > max ? c.list.over : '';
      if (mode) over++;
      if ((r.item.dataset.bcsF || '') === mode) continue;
      setStyle(r.item, 'display', mode === 'hide' ? 'none' : '');
      setStyle(r.item, 'opacity', mode === 'dim' ? '0.35' : '');
      if (mode) r.item.dataset.bcsF = mode; else delete r.item.dataset.bcsF;
    }
    const info = !max ? '' : over === 0 ? `Alla ${rows.length} inom ${max} min` : c.list.over === 'hide'
      ? `Visar ${rows.length - over} av ${rows.length}` : `${over} av ${rows.length} över ${max} min`;
    if (q('info').textContent !== info) q('info').textContent = info;
    q('info').hidden = !info;

    if (c.list.sort) {
      if (!box.dataset.bcsSort) {
        const native = /flex|grid/.test(getComputedStyle(box).display);
        box.dataset.bcsSort = native ? 'native' : 'set';
        if (!native) { box.style.display = 'flex'; box.style.flexDirection = 'column'; }
      }
      const ranked = rows.slice().sort((a, b) => (a.est ? a.est.mins : 1e6) - (b.est ? b.est.mins : 1e6) || a.i - b.i);
      ranked.forEach((r, k) => setStyle(r.item, 'order', String(k + 1)));
      const mine = new Set(rows.map((r) => r.item));
      for (const ch of box.children) if (!mine.has(ch)) setStyle(ch, 'order', String(rows.length + 1)); // ads and the like go last
    } else if (box.dataset.bcsSort) unsort(box);
  }

  function unsort(box) {
    if (box.dataset.bcsSort === 'set') { box.style.display = ''; box.style.flexDirection = ''; }
    delete box.dataset.bcsSort;
    for (const ch of box.children) ch.style.order = '';
  }
  function resetList() {
    if (filterBar) filterBar.remove();
    document.querySelectorAll('[data-bcs-f]').forEach((el) => { el.style.display = ''; el.style.opacity = ''; delete el.dataset.bcsF; });
    document.querySelectorAll('[data-bcs-sort]').forEach(unsort);
  }

  // ---------- map dots ----------
  // Booli's map is MapLibre, drawn on a canvas. Dots over the limit are dimmed or hidden by changing the dot layers'
  // opacity for those listings. Each dot's commute comes from its own position, so every dot on the map is covered.
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const raw = (o) => (o && o.wrappedJSObject) || o; // Firefox: see the page's own properties
  const toPage = (v) => (typeof cloneInto === 'function' ? cloneInto(v, pageWin) : v);
  const pageFn = (fn) => (typeof exportFunction === 'function' ? exportFunction(fn, pageWin) : fn);
  const isMap = (m) => !!m && typeof m === 'object' && typeof m.getStyle === 'function' && typeof m.setPaintProperty === 'function' && typeof m.querySourceFeatures === 'function';
  const MAP_OPACITY = { circle: ['circle-opacity', 'circle-stroke-opacity'], symbol: ['icon-opacity', 'text-opacity'] };
  const MAP_ID_KEYS = ['booliId', 'listingId', 'residenceId', 'id'];

  // The map isn't global. React keeps it in the map component's props, state or refs, reachable from the container.
  let mapRef = null;
  function findMap() {
    const el = raw(pageWin.document.querySelector('.maplibregl-map, .mapboxgl-map'));
    if (!el) return null;
    try { if (mapRef && el.contains(mapRef.getContainer())) return mapRef; } catch {}
    const seen = new Set();
    const look = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 3 || seen.has(v)) return null;
      seen.add(v);
      if (isMap(v)) return v;
      try { if (typeof v.getMap === 'function') { const m = v.getMap(); if (isMap(m)) return m; } } catch {}
      for (const k of ['current', 'map', '_map', 'mapRef', 'instance', 'value']) {
        try { const r = look(v[k], depth + 1); if (r) return r; } catch {}
      }
      return null;
    };
    for (let node = el, n = 0; node && n < 6; node = node.parentElement, n++) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!key) continue;
      for (let f = node[key], i = 0; f && i < 60; f = f.return, i++) {
        let r = look(f.stateNode, 0) || look(f.memoizedProps, 0) || look(f.ref, 0);
        for (let h = f.memoizedState, j = 0; !r && h && typeof h === 'object' && j < 40; h = h.next, j++) r = look(h.memoizedState, 0);
        if (r) return (mapRef = r);
      }
    }
    return null;
  }

  // Page objects copied into plain data, so Firefox lets the script work with them.
  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
  const ID_EXPR = '$id'; // the vector-tile feature id rather than a property

  // Features of a source: GeoJSON, or vector tiles (which need the layer inside the tile).
  function sourceFeatures(map, name, sourceLayer) {
    try { return plain(sourceLayer ? map.querySourceFeatures(name, toPage({ sourceLayer })) : map.querySourceFeatures(name)) || []; } catch { return []; }
  }

  // The listings' dots: the source whose points carry the listing ids, and the layers that draw them.
  // The id field is the one whose values match the listing ids on the page, else a likely name.
  function mapListings(map) {
    const style = plain(map.getStyle());
    const known = new Set([...listPos.keys(), ...findListCards().map((x) => x.id)]);
    const groups = new Map(); // "source|source-layer" → layers
    for (const l of style.layers || []) {
      const src = style.sources[l.source];
      if (!src || !MAP_OPACITY[l.type] || (src.type !== 'geojson' && src.type !== 'vector')) continue;
      const k = `${l.source}|${l['source-layer'] || ''}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(l);
    }
    let best = null;
    const ordered = [...groups].sort(([a], [b]) => /listing/i.test(b) - /listing/i.test(a));
    for (const [k, layers] of ordered) {
      if (best) break; // a listing source that works is enough; the base map's label layers are huge
      const [name, sourceLayer] = k.split('|');
      if (/protomaps|openmaptiles|basemap/i.test(name)) continue;
      const points = sourceFeatures(map, name, sourceLayer).filter((f) => f.geometry && f.geometry.type === 'Point'
        && !(f.properties || {}).point_count && !(f.properties || {}).cluster);
      if (!points.length) continue;
      const valueOf = (f, key) => String(key === ID_EXPR ? f.id : (f.properties || {})[key]);
      const keys = [...new Set(points.flatMap((f) => Object.keys(f.properties || {}))), ID_EXPR];
      const scored = keys.map((key) => ({ key, hits: points.filter((f) => known.has(valueOf(f, key))).length }));
      let idKey = scored.sort((a, b) => b.hits - a.hits)[0];
      idKey = idKey && idKey.hits ? idKey.key : null;
      if (!idKey && /listing/i.test(name)) {
        idKey = MAP_ID_KEYS.find((x) => keys.includes(x)) || keys.find((x) => points.every((f) => /^\d{5,9}$/.test(valueOf(f, x)))) || null;
      }
      if (!idKey) continue;
      const score = (/listing/i.test(name) ? 1e6 : 0) + points.length;
      if (best && best.score >= score) continue;
      const byId = new Map();
      for (const f of points) {
        const id = valueOf(f, idKey);
        if (!byId.has(id)) byId.set(id, { id, lon: +f.geometry.coordinates[0], lat: +f.geometry.coordinates[1] });
      }
      best = { score, source: name, sourceLayer, idKey, layers, dots: [...byId.values()] };
    }
    return best;
  }

  // The map is checked a moment after it settles, never on every frame. The dot layer is found once; after that
  // each check only reads that layer's ids and positions, and every house's result is remembered.
  let mapSig = '';
  let mapHooked = null; // the container of the map the idle listener is attached to
  let mapTimer = null;
  let dotSetup = null; // { source, sourceLayer, idKey, layers }
  const mapOriginals = new Map();
  const dotOver = new Map(); // listing id → over the limit?
  let dotOverKey = '';
  const scheduleMap = () => { if (!mapTimer) mapTimer = setTimeout(() => { mapTimer = null; dimMap(cfg()); }, 400); };

  // Only the dot layer's ids and positions, read straight from the page's objects (no copy of everything).
  function currentDots(map, setup) {
    const fs = setup.sourceLayer ? map.querySourceFeatures(setup.source, toPage({ sourceLayer: setup.sourceLayer })) : map.querySourceFeatures(setup.source);
    const out = new Map();
    for (let i = 0, n = fs.length; i < n; i++) {
      const f = fs[i], pr = f.properties || {};
      if (pr.point_count || pr.cluster) continue;
      const g = f.geometry;
      if (!g || g.type !== 'Point') continue;
      const id = String(setup.idKey === ID_EXPR ? f.id : pr[setup.idKey]);
      if (!out.has(id)) out.set(id, { id, lon: +g.coordinates[0], lat: +g.coordinates[1] });
    }
    return out;
  }

  function dimMap(c) {
    let map;
    try { map = findMap(); } catch { return; }
    if (!map) return;
    // The map redraws without touching the page: check again once it settles. One listener per map container,
    // even if the map is reached through a different wrapper object next time.
    let container = null;
    try { container = map.getContainer(); } catch {}
    if (mapHooked !== container) {
      mapHooked = container;
      dotSetup = null;
      mapSig = '';
      shadeSig = '';
      try { map.on('idle', pageFn(scheduleMap)); } catch {}
    }
    const ts = tablesFor(c).filter((x) => x.t !== 'loading');
    const max = +c.list.max || 0;
    try { dimDots(map, c, ts, max); } catch { dotSetup = null; }
    try { shadeMap(map, c, ts, max); } catch { shadeSig = ''; }
  }

  function dimDots(map, c, ts, max) {
    if (dotSetup && !dotSetup.layers.every((l) => map.getLayer(l.id))) dotSetup = null; // the style changed
    if (!dotSetup) {
      const info = mapListings(map);
      if (!info) return;
      dotSetup = { source: info.source, sourceLayer: info.sourceLayer, idKey: info.idKey, layers: info.layers };
    }
    const key = `${settingsSig(c)}|${max}|${ts.map((x) => `${x.meta.key}:${x.t.data.generated}`).join(',')}`;
    if (key !== dotOverKey) { dotOverKey = key; dotOver.clear(); }
    if (ts.length && max) {
      for (const [id, p] of currentDots(map, dotSetup)) {
        if (dotOver.has(id)) continue;
        const es = ts.map((x) => estimate(p, c, x.t));
        dotOver.set(id, es.every(Boolean) && Math.max(...es.map((e) => e.mins)) > max);
      }
    }
    // Every house seen so far stays in the list, so panning back and forth doesn't redraw the layer.
    const over = [...dotOver].filter(([, o]) => o).map(([id]) => id);
    const sig = `${dotSetup.source}|${dotSetup.idKey}|${c.list.over}|${over.length}|${max}`;
    if (sig === mapSig) return;
    mapSig = sig;
    const to = c.list.over === 'hide' ? 0 : 0.25;
    const idOf = dotSetup.idKey === ID_EXPR ? ['id'] : ['get', dotSetup.idKey];
    for (const layer of dotSetup.layers) for (const prop of MAP_OPACITY[layer.type]) {
      const k = `${layer.id}|${prop}`;
      if (!mapOriginals.has(k)) mapOriginals.set(k, plain(map.getPaintProperty(layer.id, prop)));
      const orig = mapOriginals.get(k);
      const value = over.length
        ? ['case', ['in', ['to-string', idOf], ['literal', over]], to, typeof orig === 'number' ? orig : 1]
        : orig;
      map.setPaintProperty(layer.id, prop, toPage(value));
    }
  }

  // ---------- shading the areas over the limit ----------
  // Grouped dots can't be dimmed one by one, so the map itself is shaded: a grid over the visible area, cells over
  // the limit (or with no stop within reach) drawn light grey under the dots, and a dark line along the edge of the
  // area within the limit. Cells have fixed sizes (125 m, 250 m, 500 m …) on fixed lines, so they stay put as you
  // pan and zoom. Along the edge the grid is finer: a cell that is only partly within the limit is split into
  // smaller cells, so small pockets near a station show even when zoomed out.
  const SHADE_ID = 'bcs-commute-shade';
  const SHADE_PX = 32; // base cell size on screen
  const SHADE_SPLIT = 4; // edge cells are split into 4 × 4
  const SHADE_MIN_M = 125; // smallest cell
  const SHADE_REF_LAT = 57.7; // fixed east-west spacing for the grid
  let shadeSig = '';
  const shadeMemo = new Map(); // cell or point → over the limit? Reused across panning and zooming.
  let shadeMemoKey = '';

  // judge.overAt(point, key): is this point over the limit? judge.allOver(rect, key): is every point in it over?
  function shadeCells(bounds, zoom, judge) {
    const [[w0, s0], [e0, n0]] = bounds;
    const mPerPx = (156543.03 * Math.cos((SHADE_REF_LAT * Math.PI) / 180)) / 2 ** zoom;
    let cell = SHADE_MIN_M;
    while (cell / mPerPx < SHADE_PX && cell < 16000) cell *= 2;
    const kmLon = KM_LAT * Math.cos((SHADE_REF_LAT * Math.PI) / 180);
    // A margin around the view, so panning a little doesn't show an unshaded edge.
    const padLat = (n0 - s0) * 0.15, padLon = (e0 - w0) * 0.15;
    const [w, s, e, n] = [w0 - padLon, s0 - padLat, e0 + padLon, n0 + padLat];
    const cellsFor = (m) => ((n - s) * KM_LAT * 1000 / m) * ((e - w) * kmLon * 1000 / m);
    while (cellsFor(cell) > 6000 && cell < 16000) cell *= 2;
    const split = Math.max(1, Math.min(SHADE_SPLIT, cell / SHADE_MIN_M));
    const fine = cell / split;
    const dLat = cell / (KM_LAT * 1000), dLon = cell / (kmLon * 1000);
    const fLat = dLat / split, fLon = dLon / split;
    const I0 = Math.floor(s / dLat), I1 = Math.ceil(n / dLat), J0 = Math.floor(w / dLon), J1 = Math.ceil(e / dLon);
    // The fine grid: rows i from i0, columns j from j0. Whole base cells fill all their fine cells at once.
    const i0 = I0 * split, i1 = I1 * split, j0 = J0 * split, j1 = J1 * split;
    const over = Array.from({ length: i1 - i0 }, () => new Array(j1 - j0));
    const fill = (I, J, v) => { for (let a = 0; a < split; a++) for (let b = 0; b < split; b++) over[I * split + a - i0][J * split + b - j0] = v; };
    const pointKey = (size, i, j) => `p${size}:${i}:${j}`;
    for (let I = I0; I < I1; I++) {
      for (let J = J0; J < J1; J++) {
        const rect = [I * dLat, J * dLon, (I + 1) * dLat, (J + 1) * dLon];
        if (judge.allOver(rect, `r${cell}:${I}:${J}`)) { fill(I, J, true); continue; }
        // Some point is within. If the centre and the corners are too, take the whole cell as within.
        const samples = [[I + 0.5, J + 0.5], [I, J], [I + 1, J], [I, J + 1], [I + 1, J + 1]];
        const someOver = split > 1 && samples.some(([y, x]) => judge.overAt({ lat: y * dLat, lon: x * dLon }, pointKey(cell, y * 2, x * 2)));
        if (!someOver) {
          if (split === 1) fill(I, J, judge.overAt({ lat: (I + 0.5) * dLat, lon: (J + 0.5) * dLon }, pointKey(cell, I * 2 + 1, J * 2 + 1)));
          else fill(I, J, false);
          continue;
        }
        for (let a = 0; a < split; a++) for (let b = 0; b < split; b++) {
          const i = I * split + a, j = J * split + b;
          over[i - i0][j - j0] = judge.overAt({ lat: (i + 0.5) * fLat, lon: (j + 0.5) * fLon }, pointKey(fine, i * 2 + 1, j * 2 + 1));
        }
      }
    }
    const at = (i, j) => over[i - i0][j - j0];
    const features = [];
    const line = (a, b) => features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } });
    for (let i = i0; i < i1; i++) { // grey: runs of cells over the limit in each fine row
      let run = null;
      for (let j = j0; j <= j1; j++) {
        const o = j < j1 && at(i, j);
        if (o && run == null) run = j;
        if (!o && run != null) {
          const [x0, x1, y0, y1] = [run * fLon, j * fLon, i * fLat, (i + 1) * fLat];
          features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
          run = null;
        }
      }
    }
    // The edge between cells over and within the limit, merged into long straight pieces.
    for (let i = i0 + 1; i < i1; i++) { // horizontal edges, below fine row i
      let run = null;
      for (let j = j0; j <= j1; j++) {
        const edge = j < j1 && at(i - 1, j) !== at(i, j);
        if (edge && run == null) run = j;
        if (!edge && run != null) { line([run * fLon, i * fLat], [j * fLon, i * fLat]); run = null; }
      }
    }
    for (let j = j0 + 1; j < j1; j++) { // vertical edges, left of fine column j
      let run = null;
      for (let i = i0; i <= i1; i++) {
        const edge = i < i1 && at(i, j - 1) !== at(i, j);
        if (edge && run == null) run = i;
        if (!edge && run != null) { line([j * fLon, run * fLat], [j * fLon, i * fLat]); run = null; }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  function shadeMap(map, c, ts, max) {
    const on = ts.length && max;
    if (!on) {
      for (const id of [`${SHADE_ID}-edge`, SHADE_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SHADE_ID)) map.removeSource(SHADE_ID);
      shadeSig = '';
      return;
    }
    const b = plain(map.getBounds().toArray());
    const zoom = map.getZoom();
    const r = (v) => v.toFixed(3);
    const memoKey = `${settingsSig(c)}|${max}|${ts.map((x) => `${x.meta.key}:${x.t.data.generated}`).join(',')}`;
    const sig = `${b.flat().map(r).join(',')}|${Math.round(zoom * 2)}|${c.list.over}|${memoKey}`;
    if (sig === shadeSig && map.getLayer(SHADE_ID)) return;
    shadeSig = sig;
    if (memoKey !== shadeMemoKey || shadeMemo.size > 200000) { shadeMemoKey = memoKey; shadeMemo.clear(); }
    const memo = (key, fn) => {
      let v = shadeMemo.get(key);
      if (v === undefined) shadeMemo.set(key, (v = fn()));
      return v;
    };
    const data = shadeCells(b, zoom, {
      // Over the limit for any destination counts as over (the list uses the longest commute).
      overAt: (p, key) => memo(key, () => ts.some((x) => !reachable([p.lat, p.lon, p.lat, p.lon], c, x.t, max))),
      allOver: (rect, key) => memo(key, () => ts.some((x) => !reachable(rect, c, x.t, max))),
    });
    const src = map.getSource(SHADE_ID);
    if (src) src.setData(toPage(data));
    else map.addSource(SHADE_ID, toPage({ type: 'geojson', data }));
    const opacity = c.list.over === 'hide' ? 0.3 : 0.14;
    const below = dotSetup && dotSetup.layers[0] && map.getLayer(dotSetup.layers[0].id) ? dotSetup.layers[0].id : undefined;
    if (!map.getLayer(SHADE_ID)) {
      map.addLayer(toPage({ id: SHADE_ID, type: 'fill', source: SHADE_ID, filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#1b1b1b', 'fill-opacity': opacity, 'fill-antialias': false } }), below);
    } else map.setPaintProperty(SHADE_ID, 'fill-opacity', opacity);
    if (!map.getLayer(`${SHADE_ID}-edge`)) {
      map.addLayer(toPage({ id: `${SHADE_ID}-edge`, type: 'line', source: SHADE_ID, filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'square' }, paint: { 'line-color': '#1b1b1b', 'line-opacity': 0.7, 'line-width': 2 } }), below);
    }
  }

  // Without a table for your destination, each card gets a small "Visa pendling" button, so nothing is fetched
  // until you ask. Houses you've already looked at show their values straight away, from saved results.
  function decorateListButtons(cards, c) {
    const sig = settingsSig(c);
    for (const { line, id, url } of cards) {
      line.querySelectorAll('[data-bcs-est]').forEach((e) => e.remove());
      const existing = [...line.querySelectorAll('[data-bcs-card]')];
      if (existing.length && existing.every((e) => e.dataset.bcsCard === id)) continue; // already filled
      existing.forEach((e) => e.remove());
      const btn = line.querySelector('[data-bcs-btn]');
      if (savedSummary(id, c, sig) || cardJobs.has(id)) { // values already known: show them, no lookups needed
        if (btn) btn.remove();
        fillCard(line, id, url, c);
        continue;
      }
      if (btn && btn.dataset.bcsBtn === id) continue; // button already there
      if (btn) btn.remove();
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-bcs-btn', id);
      b.style.cssText = BTN_CSS;
      b.innerHTML = '<span aria-hidden="true">🚆</span>Visa pendling';
      b.setAttribute('aria-label', 'Visa pendling för den här bostaden');
      b.addEventListener('click', (e) => {
        e.preventDefault(); // the card is usually a link to the listing
        e.stopPropagation();
        b.remove();
        fillCard(line, id, url, c);
      });
      line.appendChild(b);
    }
  }

  // =====================================================================
  // Settings panel ("Pendling")
  // =====================================================================
  const SHEET_CSS = `
    * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); z-index: 2147483600; display: flex; justify-content: center; align-items: flex-end; }
    .sheet { background: #fff; color: #1b1b1b; width: 600px; max-width: 100%; max-height: 94vh; display: flex; flex-direction: column;
      border-radius: 16px 16px 0 0; font-size: 16px; line-height: 1.45; }
    @media (min-width: 700px) { .backdrop { align-items: center; } .sheet { border-radius: 16px; } }
    header { display: flex; align-items: flex-start; gap: 12px; padding: 24px 32px 18px; border-bottom: 1px solid #e6e5e2; }
    header .ttl { flex: 1; }
    h2 { font-size: 24px; font-weight: 700; margin: 0; line-height: 1.2; }
    .subtitle { color: #5c5c5a; margin: 4px 0 0; font-size: 15px; }
    .icon-btn { width: 44px; height: 44px; flex: none; display: grid; place-items: center; border: 0; background: none; border-radius: 10px; cursor: pointer; color: #1b1b1b; font-size: 20px; margin: -8px -10px 0 0; }
    .content { overflow-y: auto; padding: 0 32px; }
    section { padding: 28px 0; border-bottom: 1px solid #e6e5e2; }
    h3 { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
    h4 { font-size: 15px; font-weight: 700; margin: 24px 0 10px; }
    .hint { color: #5c5c5a; font-size: 15px; margin: 0 0 14px; }
    .lbl { display: block; font-size: 14px; color: #3d3d3b; margin: 0 0 6px; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; }
    input[type=text], input[type=number], select { font: inherit; font-size: 16px; height: 44px; padding: 0 12px; border: 1px solid #cfcecb; border-radius: 10px; background: #fff; color: inherit; }
    .time { width: 5.2em; text-align: center; }
    .seg { display: inline-flex; flex-wrap: wrap; background: #f1f0ed; border-radius: 10px; padding: 3px; gap: 2px; }
    .seg button { border: 0; background: none; font: inherit; font-size: 15px; padding: 0 14px; min-height: 38px; border-radius: 8px; cursor: pointer; color: #3d3d3b; }
    .seg button[aria-pressed="true"] { background: #fff; color: #1b1b1b; font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .15); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { height: 42px; padding: 0 16px; border-radius: 21px; border: 1px solid #cfcecb; background: #fff; font: inherit; font-size: 15px; cursor: pointer; color: #1b1b1b; }
    .chip[aria-pressed="true"] { background: #1b1b1b; border-color: #1b1b1b; color: #fff; }
    .chip:disabled { opacity: .45; cursor: not-allowed; }
    .card { border: 1px solid #e6e5e2; border-radius: 12px; padding: 16px; margin: 14px 0 0; }
    .card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .card-head strong { font-size: 16px; }
    .text-btn { border: 0; background: none; font: inherit; font-size: 15px; color: #3d3d3b; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 0 6px; min-height: 44px; }
    .scale { position: relative; margin: 14px 0 4px; }
    .scale.has-marker { margin-top: 34px; }
    .track { position: relative; height: 10px; border-radius: 5px; background: #ecebe8; overflow: hidden; }
    .track .good { position: absolute; left: 0; top: 0; bottom: 0; background: #2e7d4f; }
    .track .ok { position: absolute; top: 0; bottom: 0; background: #f0d9a8; }
    .marker { position: absolute; top: -6px; width: 2px; height: 22px; background: #1b1b1b; margin-left: -1px; }
    .marker span { position: absolute; bottom: 24px; white-space: nowrap; font-size: 13px; font-weight: 600; }
    .scale-ends { display: flex; justify-content: space-between; font-size: 13px; color: #5c5c5a; margin-top: 4px; }
    .steppers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .stepper .ctl { display: flex; align-items: center; border: 1px solid #cfcecb; border-radius: 10px; height: 44px; overflow: hidden; }
    .stepper button { width: 44px; height: 44px; border: 0; background: none; font: inherit; font-size: 22px; cursor: pointer; color: #1b1b1b; }
    .stepper output { flex: 1; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
    .add { display: flex; gap: 8px; margin-top: 14px; }
    .add input { flex: 1; min-width: 0; }
    .btn { min-height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid #1b1b1b; background: #fff; color: #1b1b1b; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .btn.primary { background: #1b1b1b; color: #fff; }
    .suggest { list-style: none; margin: 6px 0 0; padding: 4px; border: 1px solid #e6e5e2; border-radius: 10px; }
    .suggest button { display: block; width: 100%; text-align: left; border: 0; background: none; font: inherit; padding: 0 12px; border-radius: 8px; cursor: pointer; min-height: 44px; color: inherit; }
    .suggest button:hover { background: #f6f5f2; }
    .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
    .live { background: #f6f5f2; border-radius: 12px; padding: 12px 14px; margin: 0 0 14px; font-size: 15px; }
    .presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .preset { text-align: left; border: 1px solid #cfcecb; border-radius: 12px; background: #fff; padding: 14px; font: inherit; cursor: pointer; color: #1b1b1b; min-height: 44px; }
    .preset[aria-pressed="true"] { border: 2px solid #1b1b1b; padding: 13px; }
    .preset strong { display: block; font-size: 15px; }
    .preset small { display: block; color: #5c5c5a; font-size: 13px; margin-top: 2px; }
    .stack { display: flex; gap: 2px; height: 12px; margin: 16px 0 8px; }
    .stack i { display: block; height: 100%; border-radius: 3px; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; color: #3d3d3b; }
    .legend span::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; background: var(--c); }
    .preview { display: flex; flex-wrap: wrap; gap: 14px 28px; background: #f6f5f2; border-radius: 12px; padding: 14px 16px; margin: 0 0 14px; }
    .fact .k { font-size: 14px; color: #5c5c5a; }
    .fact .v { font-size: 19px; font-weight: 500; }
    .fact.faded { opacity: .4; }
    .level { margin-top: 22px; }
    .level-desc { color: #5c5c5a; font-size: 15px; margin: 8px 0 0; }
    .disclosure { display: flex; width: 100%; align-items: center; gap: 12px; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; padding: 24px 0; color: #1b1b1b; }
    .disclosure .t { flex: 1; }
    .disclosure strong { font-size: 18px; display: block; }
    .disclosure small { color: #5c5c5a; font-size: 14px; }
    .chev { flex: none; transition: transform .2s ease; }
    .disclosure[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .adv { padding-bottom: 28px; }
    .adv h4:first-child { margin-top: 0; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .field label { display: block; font-size: 14px; color: #3d3d3b; margin-bottom: 4px; }
    .unit { display: flex; align-items: center; gap: 8px; }
    .unit input { width: 100%; min-width: 0; }
    .unit span { color: #5c5c5a; font-size: 14px; flex: none; }
    .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
    .check { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15px; cursor: pointer; }
    .check input { width: 20px; height: 20px; margin: 0; accent-color: #1b1b1b; flex: none; }
    .keybox { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .ok-text { color: #23633e; font-weight: 600; }
    .welcome { background: #f6f5f2; border-radius: 12px; padding: 20px; margin: 24px 0 0; border: 0; }
    .welcome a { color: #1b1b1b; font-weight: 600; }
    .steps { margin: 10px 0 0; padding-left: 1.4em; font-size: 15px; }
    .steps li { margin: 4px 0; }
    .key-msg { font-size: 15px; margin: 10px 0 0; }
    .key-msg.err { color: #b3261e; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; color: #3d3d3b; }
    .wide { width: 100%; }
    .cache { background: #f6f5f2; border-radius: 12px; padding: 12px 16px; display: flex; align-items: center; gap: 12px; justify-content: space-between; font-size: 15px; }
    footer { display: flex; align-items: center; gap: 10px; padding: 14px 32px calc(14px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid #e6e5e2; }
    .status { flex: 1; font-size: 14px; color: #5c5c5a; }
    .status.err { color: #b3261e; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #1b1b1b; outline-offset: 2px; }
    .legend2 { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; font-size: 14px; color: #3d3d3b; margin-top: 8px; }
    .ring { position: absolute; top: -3px; width: 16px; height: 16px; margin-left: -8px; border: 2px solid #1b1b1b; border-radius: 50%; background: #fff; }
    .marker { width: 4px; height: 20px; top: -5px; margin-left: -2px; border-radius: 1px; }
    .delta { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 14px; font-weight: 600; white-space: nowrap; }
    .delta.worse { background: #f6ead2; color: #6e4700; }
    .delta.better { background: #e3f1e8; color: #1f5a37; }
    .delta.same { background: #f1f0ed; color: #3d3d3b; }
    .home { margin-top: 18px; }
    .note { color: #5c5c5a; font-size: 14px; margin: 8px 0 0; }
    .ev-card { border: 1px solid #e6e5e2; border-radius: 12px; padding: 14px 16px; margin-top: 12px; }
    .ev-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
    .ev-head strong { display: block; font-size: 16px; }
    .ev-head small { display: block; color: #5c5c5a; font-size: 14px; }
    .switch { flex: none; width: 64px; height: 44px; border: 0; background: none; padding: 0; cursor: pointer; display: grid; place-items: center; }
    .switch .track { position: relative; width: 52px; height: 32px; border-radius: 16px; background: #cfcecb; transition: background .15s; }
    .switch .track::after { content: ''; position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: left .15s; }
    .switch[aria-checked="true"] .track { background: #1b1b1b; }
    .switch[aria-checked="true"] .track::after { left: 24px; }
    .ev-body { margin-top: 12px; }
    .ev-vals { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 12px; font-size: 15px; }
    .fact .dl { font-size: 13px; font-weight: 600; }
    .check.solo { margin-top: 10px; }
    @media (max-width: 560px) {
      header { padding: 20px 20px 14px; } .content { padding: 0 20px; } footer { padding-left: 20px; padding-right: 20px; flex-wrap: wrap; }
      .grid2, .grid3, .checks, .steppers, .presets { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { .chev, .switch .track, .switch .track::after { transition: none; } }
  `;

  const EV_CATS = [
    { key: 'grocery', title: 'Matbutik', desc: 'Närmaste livsmedelsbutik', modes: true },
    { key: 'school', title: 'Skola och förskola', desc: 'Närmaste grundskola och förskola', modes: true },
    { key: 'car', title: 'Bil till resmålen', desc: 'Körtid i rusningstrafik, samma ankomsttid', modes: false },
  ];
  const EV_MODES = [{ v: 'walk', label: 'Gång' }, { v: 'bike', label: 'Cykel' }, { v: 'car', label: 'Bil' }];

  // Booli's web font is declared in the page's stylesheets; copy the @font-face rules (with absolute URLs) into the frame.
  function pageFontFaces() {
    let css = '';
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin stylesheet
      const base = sheet.href || location.href;
      for (const r of rules) {
        if (r.type !== CSSRule.FONT_FACE_RULE) continue;
        css += r.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => {
          try { return `url("${new URL(u, base).href}")`; } catch { return m; }
        }) + '\n';
      }
    }
    return css;
  }

  const round5 = (v) => Math.round(v / 5) * 5;
  const maskKey = (k) => (k.length > 8 ? `${k.slice(0, 4)}••••${k.slice(-4)}` : '••••');
  const KPI_SAMPLE = { commute: '31 min', station: '11 min', score: '95', transit: '37 min', bike: '67 min', lastHome: '23:40' };
  const WEIGHT_COLORS = ['#1f4f8a', '#5b95d6', '#e2b55c'];
  const STATION_WAYS = [['walk', 'Gång'], ['bike', 'Cykel'], ['bus', 'Buss']];

  function cachedListingCount() {
    if (!cacheMem) cacheMem = GM_getValue('cache', {});
    return Object.keys(cacheMem).filter((k) => k.startsWith(CACHE_NS + 'st:')).length;
  }

  async function openSettings(opener) {
    const saved = cfg();
    let d = JSON.parse(JSON.stringify(saved)); // the draft; nothing is stored until Spara
    let editingKey = !d.apiKey;
    let advOpen = GM_getValue('advOpen', false);
    let keyState = ''; // '' | 'testing' | 'ok' | 'fail:<message>'
    let addQuery = '';
    let suggestions = [];
    let suggestTimer = null;
    let undo = null;
    let homeLabel = d.home ? d.home.label : '';
    const listing = state.status === 'done' && listingId() ? state : null; // for the markers and the live score
    if (listing) loadExtras(); // so "I vardagen" can show this listing's values
    // "Today" values are only valid while the saved address and the setting they depend on are unchanged.
    const todayOk = () => !!(listing && saved.home && homeLabel.trim() === saved.home.label && listing.today);
    const address = ((document.querySelector('h1') || {}).textContent || '').trim() || 'Den här bostaden';

    // The panel lives in its own frame. Inside a shadow root, page and extension keyboard shortcuts
    // (Booli's own, Imagus …) can't tell that you're typing in a field and swallow letters like "o" or "p".
    // Key presses inside a frame never reach the page's handlers.
    const sheetHost = document.createElement('iframe');
    sheetHost.title = 'Pendlingsinställningar';
    sheetHost.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;z-index:2147483600;background:transparent;color-scheme:light;';
    // The frame gets its whole document through srcdoc: Firefox refuses document.write() from a userscript
    // that runs in the page (needed to reach Booli's map), with "SecurityError: The operation is insecure".
    const pageFont = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    const sheetHead = `<meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <style>${pageFontFaces()}
        html, body { margin: 0; height: 100%; background: transparent; }
        body { font-family: ${pageFont}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
        ${SHEET_CSS}</style>`;
    const sheetBody = `
      <div class="backdrop" lang="sv"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ttl">
        <header>
          <div class="ttl"><h2 id="ttl">Pendling</h2><p class="subtitle">Berätta vart du ska, så räknar vi restiden för varje bostad.</p></div>
          <button class="icon-btn" data-act="close" data-k="x" aria-label="Stäng">✕</button>
        </header>
        <div class="content"></div>
        <footer>
          <button class="text-btn" data-act="reset" data-k="reset">Återställ</button>
          <span class="status" role="status" aria-live="polite"></span>
          <button class="btn" data-act="close" data-k="cancel">Avbryt</button>
          <button class="btn primary" data-act="save" data-k="save">Spara</button>
        </footer>
      </div></div>`;
    sheetHost.srcdoc = `<!doctype html><html lang="sv"><head>${sheetHead}</head><body>${sheetBody}</body></html>`;
    await new Promise((resolve) => {
      sheetHost.addEventListener('load', resolve, { once: true });
      document.body.appendChild(sheetHost);
    });
    const fw = sheetHost.contentWindow;
    const sr = sheetHost.contentDocument;
    if (!sr.querySelector('.sheet')) { // no srcdoc support: fill the blank frame through the DOM instead
      sr.head.innerHTML = sheetHead;
      sr.body.innerHTML = sheetBody;
    }
    const $ = (q) => sr.querySelector(q);
    const content = $('.content');
    const status = (t, err) => { $('.status').textContent = t || ''; $('.status').className = 'status' + (err ? ' err' : ''); };

    // ---------- building blocks ----------
    const seg = (group, options, current, labelledBy) =>
      `<div class="seg" role="group" ${labelledBy ? `aria-labelledby="${labelledBy}"` : ''}>${options.map((o) =>
        `<button data-act="seg" data-g="${group}" data-v="${o.v}" data-k="seg-${group}-${o.v}" aria-pressed="${String(o.v) === String(current)}">${esc(o.label)}</button>`).join('')}</div>`;
    const chip = (act, v, label, on, disabled) =>
      `<button class="chip" data-act="${act}" data-v="${v}" data-k="${act}-${v}" aria-pressed="${on}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
    const stepper = (label, key, value) =>
      `<div class="stepper"><span class="lbl" id="l-${key}">${esc(label)}</span>
        <div class="ctl" role="group" aria-labelledby="l-${key}">
          <button data-act="step" data-s="${key}" data-d="-5" data-k="${key}-dn" aria-label="Kortare">−</button>
          <output aria-live="polite">${value} min</output>
          <button data-act="step" data-s="${key}" data-d="5" data-k="${key}-up" aria-label="Längre">+</button>
        </div></div>`;
    // marks: { here, hereLabel, today, delta }; the bar and markers are decorative, the legend carries the values.
    function scale(ideal, max, top, marks = {}) {
      const pct = (v) => clamp((v / top) * 100, 0, 100);
      const here = marks.here != null ? `<div class="marker" style="left:${pct(marks.here)}%"></div>` : '';
      const today = marks.today != null ? `<div class="ring" style="left:${pct(marks.today)}%"></div>` : '';
      const legend = [
        marks.here != null ? `<span>▮ ${esc(marks.hereLabel || 'Den här bostaden')} ${marks.here} min</span>` : '',
        marks.today != null ? `<span>○ Idag ${marks.today} min</span>` : '',
        marks.delta ? pill(marks.delta) : '',
      ].join('');
      return `<div class="scale" aria-hidden="true">
          <div class="track"><span class="good" style="width:${pct(ideal)}%"></span><span class="ok" style="left:${pct(ideal)}%;width:${pct(max) - pct(ideal)}%"></span></div>
          ${here}${today}<div class="scale-ends"><span>0</span><span>${top} min</span></div></div>
        ${legend.trim() ? `<div class="legend2">${legend}</div>` : ''}`;
    }
    const field = (id, label, value, unit, opts = '') =>
      `<div class="field"><label for="${id}">${esc(label)}</label><div class="unit"><input id="${id}" data-k="${id}" data-f="${id}" ${opts} value="${esc(value)}"><span>${esc(unit)}</span></div></div>`;
    const num = (min, max, step = 1) => `type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}"`;
    const timeAttrs = 'type="text" inputmode="numeric" maxlength="5" placeholder="tt:mm"';

    // ---------- sections ----------
    function secCommute() {
      const cards = d.destinations.map((x, i) => {
        const ev = listing && listing.r.dests.find((y) => y.d.id === x.id);
        const m = ev && ev.route ? ev.route.mins : null;
        const tv = todayOk() && listing.today.r.dests.find((y) => y.d.id === x.id);
        const tm = tv && tv.route ? tv.route.mins : null;
        return `<div class="card">
          <div class="card-head"><strong>${esc(x.name)}</strong><button class="text-btn" data-act="rm" data-i="${i}" data-k="rm-${i}" aria-label="Ta bort ${esc(x.name)}">Ta bort</button></div>
          ${scale(x.ideal, x.max, 90, { here: m, today: tm, delta: deltaMins(m, tm) })}
          <div class="steppers">${stepper('Bra restid, upp till', `ideal-${i}`, x.ideal)}${stepper('Längsta jag accepterar', `max-${i}`, x.max)}</div>
          ${d.destinations.length >= 2 ? `<div style="margin-top:14px"><span class="lbl" id="wl-${i}">Hur viktigt</span>${seg(`w-${i}`, WEIGHT_LEVELS, x.weight, `wl-${i}`)}</div>` : ''}
        </div>`;
      }).join('');
      return `<section><h3>Vart pendlar du?</h3>
        <div class="row">
          <span class="sr" id="when-l">Tid för pendlingen</span>
          ${seg('when', [{ v: 'arrive', label: 'Framme senast' }, { v: 'depart', label: 'Avresa' }], d.timeMode, 'when-l')}
          <label class="sr" for="t">Klockslag</label><input id="t" data-k="t" data-f="time" class="time" ${timeAttrs} value="${esc(d.time)}">
          <span>på vardagar</span>
        </div>
        <div class="home">
          <label class="lbl" for="home">Var bor du idag?</label>
          <p class="hint" style="margin:0 0 8px">Då jämför vi varje bostad med det du har nu.</p>
          <div class="add" style="margin-top:0">
            <input id="home" data-k="home" type="text" autocomplete="off" placeholder="Adress eller område, t.ex. Majorna, Göteborg" value="${esc(homeLabel)}">
            ${homeLabel ? '<button class="text-btn" data-act="homeRm" data-k="homeRm">Ta bort</button>' : ''}
          </div>
          <p class="note">Sparas bara i din webbläsare. När du sparar skickas den en gång till OpenStreetMap för att hitta platsen.</p>
        </div>
        ${cards || '<p class="hint" style="margin-top:14px">Inga resmål än. Lägg till din arbetsplats eller en station.</p>'}
        <div class="add">
          <label class="sr" for="add">Lägg till resmål</label>
          <input id="add" data-k="add" type="text" autocomplete="off" placeholder="Lägg till resmål, t.ex. Lindholmen" value="${esc(addQuery)}">
          <button class="btn" data-act="add" data-k="add-btn">Lägg till</button>
        </div>
        ${suggestions.length ? `<ul class="suggest" aria-label="Förslag">${suggestions.map((x, i) =>
          `<li><button data-act="pick" data-i="${i}" data-k="pick-${i}">${esc(cleanName(x.name))}</button></li>`).join('')}</ul>` : ''}
      </section>`;
    }

    function secStation() {
      const st = listing && listing.r.station;
      return `<section><h3>Till tågstationen</h3>
        <p class="hint">Vi väljer det snabbaste sättet av de du kan tänka dig. Gång och cykel räknas också hela vägen till resmålet, upp till ${esc(d.directMax)} min.</p>
        <div class="chips" role="group" aria-label="Sätt att ta sig till stationen">${STATION_WAYS.map(([k, l]) => chip('way', k, l, !!d.accessModes[k])).join('')}</div>
        ${scale(d.accessIdeal, d.accessMax, 45, st ? { here: st.best.mins, hereLabel: st.name } : {})}
        <div class="steppers">${stepper('Bra, upp till', 'aIdeal', d.accessIdeal)}${stepper('Som längst', 'aMax', d.accessMax)}</div>
      </section>`;
    }

    function secLastHome() {
      const nights = [['weekday', 'vardagskväll'], ['fri', 'fredagkväll'], ['sat', 'lördagkväll'], ['off', '(räkna inte med det)']];
      return `<section><h3>Sista resan hem</h3>
        <div class="sentence">
          <span>Jag vill kunna ta mig hem en</span>
          <label class="sr" for="lh">Vilken kväll</label>
          <select id="lh" data-k="lh" data-f="lastHome">${nights.map(([v, l]) => `<option value="${v}" ${d.lastHome === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span>klockan</span>
          <label class="sr" for="lhi">Klockslag</label><input id="lhi" data-k="lhi" data-f="lastHomeIdeal" class="time" ${timeAttrs} value="${esc(d.lastHomeIdeal)}">
          <span>eller senare.</span>
        </div>
      </section>`;
    }

    function secEveryday() {
      const ev = listing && listing.ev;
      const tev = todayOk() ? listing.todayEv : null;
      const main = listing && mainDest(listing.r);
      const valueOf = (cat, e) => {
        if (!e) return null;
        if (cat === 'grocery') return e.grocery && !e.grocery.none ? e.grocery.mins : null;
        if (cat === 'school') { const t = e.school && (e.school.primary || e.school.preschool); return t ? t.mins : null; }
        return main && e.cars[main.d.id] ? e.cars[main.d.id].mins : null;
      };
      const cards = EV_CATS.map((cat) => {
        const on = d.everyday[cat.key].on;
        // Values were calculated with the saved way of getting there; hide them if the draft differs.
        const fresh = !cat.modes || d.everyday[cat.key].mode === saved.everyday[cat.key].mode;
        const here = on && fresh && saved.everyday[cat.key].on ? valueOf(cat.key, ev) : null;
        const today = on && fresh && saved.everyday[cat.key].on ? valueOf(cat.key, tev) : null;
        const vals = [
          here != null ? `<span>Här <strong>${here} min</strong></span>` : '',
          today != null ? `<span>Idag ${today} min</span>` : '',
          pill(deltaMins(here, today)),
        ].join('');
        return `<div class="ev-card">
          <div class="ev-head"><div id="ev-${cat.key}-t"><strong>${esc(cat.title)}</strong><small>${esc(cat.desc)}</small></div>
            <button class="switch" role="switch" aria-checked="${on}" aria-labelledby="ev-${cat.key}-t" data-act="evOn" data-v="${cat.key}" data-k="ev-${cat.key}"><span class="track"></span></button>
          </div>
          ${on ? `<div class="ev-body">
            ${cat.modes ? `<span class="sr" id="evm-${cat.key}">Hur du tar dig dit</span>${seg(`evm-${cat.key}`, EV_MODES, d.everyday[cat.key].mode, `evm-${cat.key}`)}` : ''}
            ${vals.trim() ? `<div class="ev-vals">${vals}</div>` : ''}
          </div>` : ''}
          ${cat.key === 'school' ? '<p class="note">Närmast betyder inte att ni får plats där. Kolla kommunens placeringsregler.</p>' : ''}
        </div>`;
      }).join('');
      return `<section><h3>I vardagen</h3><p class="hint">Slå på det du vill se. Vi räknar bara ut det du har valt.</p>${cards}</section>`;
    }

    // First-run guide: shown until a key has been saved.
    function secWelcome() {
      if (saved.apiKey) return '';
      const msg = keyState === 'testing' ? '<p class="key-msg">Testar nyckeln…</p>'
        : keyState === 'ok' ? '<p class="key-msg ok-text">✓ Nyckeln fungerar. Tryck på Spara längst ner så är du klar.</p>'
        : keyState.startsWith('fail:') ? `<p class="key-msg err">${esc(keyState.slice(5))}. Kontrollera att du kopierat hela nyckeln och att den hör till ResRobot v2.1.</p>` : '';
      return `<section class="welcome">
        <h3>Kom igång</h3>
        <p class="hint" style="margin:0">Restiderna kommer från Trafiklab, som har öppna data för all kollektivtrafik i Sverige. Nyckeln är gratis och tar ett par minuter att skaffa.</p>
        <ol class="steps">
          <li>Skapa ett konto på <a href="https://developer.trafiklab.se" target="_blank" rel="noopener">developer.trafiklab.se</a>.</li>
          <li>Skapa ett projekt och lägg till API:t <strong>ResRobot v2.1</strong>.</li>
          <li>Kopiera nyckeln och klistra in den här.</li>
        </ol>
        <div class="add">
          <label class="sr" for="k">API-nyckel</label>
          <input id="k" data-k="k" data-f="apiKey" type="text" autocomplete="off" spellcheck="false" placeholder="Klistra in din nyckel" value="${esc(d.apiKey)}">
          <button class="btn" data-act="testkey" data-k="testkey">Testa nyckeln</button>
        </div>${msg}
      </section>`;
    }

    function draftScore() {
      if (!listing) return null;
      const r = listing.r;
      const dests = r.dests.map((x) => {
        const nd = d.destinations.find((y) => y.id === x.d.id);
        if (!nd) return null;
        return { ...x, d: { ...x.d, ...nd }, eff: x.route ? x.route.mins + x.route.changes * (+d.changePenalty || 0) : null };
      }).filter(Boolean);
      return score({ ...r, dests }, d).total;
    }

    function secWeights() {
      const preset = presetOf(d.weights);
      const w = [d.weights.commute, d.weights.access, d.weights.lastHome].map((v) => Math.max(0, +v || 0));
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const pcts = w.map((v) => Math.round((v / sum) * 100));
      const names = ['Pendling', 'Station', 'Sista hem'];
      const live = draftScore();
      return `<section><h3>Vad är viktigast för poängen?</h3>
        ${live != null ? `<p class="live">${esc(address)} skulle få <strong>${live}</strong> med det här valet.</p>` : ''}
        <div class="presets" role="group" aria-label="Viktning">${PRESETS.map((p) =>
          `<button class="preset" data-act="preset" data-v="${p.key}" data-k="preset-${p.key}" aria-pressed="${preset === p.key}"><strong>${esc(p.label)}</strong><small>${esc(p.desc)}</small></button>`).join('')}</div>
        <div class="stack" aria-hidden="true">${pcts.map((v, i) => (v > 0 ? `<i style="flex:${v};background:${WEIGHT_COLORS[i]}"></i>` : '')).join('')}</div>
        <div class="legend">${pcts.map((v, i) => `<span style="--c:${WEIGHT_COLORS[i]}">${names[i]} ${v} %</span>`).join('')}</div>
        ${preset === 'egen' ? '<p class="hint" style="margin:10px 0 0">Egna vikter, ändras under Avancerat.</p>' : ''}
      </section>`;
    }

    function secShow() {
      const specs = kpiSpecs(d);
      const hasHome = !!homeLabel.trim();
      const preview = specs.map((sp) => {
        const kv = listing ? kpiValue(sp, todayOk() ? listing : { ...listing, today: null }, d) : null;
        const v = kv ? kv.value : KPI_SAMPLE[sp.key];
        const dl = sp.key === 'commute' && hasHome && d.showTodayDelta
          ? (kv && kv.delta ? kv.delta : (!listing ? { kind: 'worse', short: '+12 min mot idag' } : null)) : null;
        return `<div class="fact"><div class="k">${esc(sp.label)}</div><div class="v">${esc(v)}</div>${dl ? `<div class="dl" style="color:${DELTA_TEXT[dl.kind]}">${esc(dl.short)}</div>` : ''}</div>`;
      }).join('');
      const full = d.kpis.length >= 3;
      const level = levelOf(d.details);
      return `<section><h3>Visa på bostadssidan</h3>
        <p class="hint">Välj upp till tre värden i faktaraden. Samma visas på kartan.</p>
        <div class="preview" aria-label="Förhandsvisning av faktaraden">
          <div class="fact faded" aria-hidden="true"><div class="k">Byggår</div><div class="v">1941</div></div>
          ${preview || '<div class="fact"><div class="k">Inga värden valda</div></div>'}
        </div>
        <div class="chips" role="group" aria-label="Värden i faktaraden">${KPIS.filter((k) => kpiAvailable(k, d)).map((k) => {
          const on = d.kpis.includes(k.key);
          return chip('kpi', k.key, k.label, on, !on && full);
        }).join('')}</div>
        ${hasHome ? `<label class="check solo"><input type="checkbox" data-act="todayDelta" data-k="todayDelta" ${d.showTodayDelta ? 'checked' : ''}>Visa skillnaden mot idag under Pendling</label>` : ''}
        <div class="level"><span class="lbl" id="lvl-l">När du öppnar detaljerna</span>
          ${seg('level', Object.entries(DETAIL_LEVELS).map(([v, x]) => ({ v, label: x.label })), level, 'lvl-l')}
          <p class="level-desc">${esc(level === 'egen' ? 'Egen kombination, ändras under Avancerat.' : DETAIL_LEVELS[level].desc)}</p>
        </div>
      </section>`;
    }

    function secLists() {
      const on = d.list.dest !== 'off';
      const mine = myTables(d);
      const destOpts = [['mine', mine.length ? `Mina resmål (${mine.map((m) => m.label).join(', ')})` : `Mina resmål (ingen har tidtabell, visar ${tableIndex()[0].label})`],
        ...tableIndex().map((m) => [m.key, m.label]), ['off', 'Visa inte']];
      // Which of your resmål have a published table, and how old it is.
      const status = d.destinations.map((x) => {
        const m = tableMetaFor(x);
        const t = m && tableNow(m.key);
        const what = !m ? 'ingen tidtabell än, visar knappen Visa pendling'
          : t ? `tidtabell från ${fmtDay(t.data.serviceDate)}, framme ${t.data.arriveBy}${t.stale ? `. Tidtabellen är ${t.ageDays} dagar gammal` : ''}`
          : 'tidtabellen hämtas första gången du ser en lista';
        return `<li>${esc(x.name)}: ${esc(what)}</li>`;
      }).join('');
      const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
      return `<section><h3>Listor och kartan</h3>
        <p class="hint">Varje bostad i sökresultaten får en ungefärlig restid, räknad från en tidtabell som uppdateras varje vecka. Välj ett av resmålen med färdiga tidtabeller, eller dina egna om de har en. Det behövs ingen nyckel och inga anrop till Trafiklab. På bostadssidan räknas restiden exakt.</p>
        <div class="grid2">
          <div class="field"><label for="lt">Pendling till, i listorna</label>
            <select id="lt" class="wide" data-k="lt" data-f="listDest">${destOpts.map(([v, l]) => opt(v, l, d.list.dest)).join('')}</select></div>
          ${on ? `<div class="field"><label for="lmax">Max restid</label>
            <select id="lmax" class="wide" data-k="lmax" data-f="listMax">${opt(0, 'Alla', d.list.max)}${LIST_MAXES.map((m) => opt(m, `${m} min`, d.list.max)).join('')}</select></div>` : ''}
        </div>
        ${on ? `<div class="row"><span class="lbl" id="lo-l" style="margin:0">Över gränsen</span>${seg('listOver', [{ v: 'hide', label: 'Dölj' }, { v: 'dim', label: 'Tona ner' }], d.list.over, 'lo-l')}</div>
          <label class="check solo"><input type="checkbox" data-act="listSort" data-k="listSort" ${d.list.sort ? 'checked' : ''}>Sortera efter pendling</label>
          ${status ? `<ul class="note" style="padding-left:1.2em">${status}</ul>` : ''}
          <p class="note">Restidstabell: Trafiklab (Samtrafiken).</p>` : ''}
      </section>`;
    }

    function secAdvanced() {
      const chevron = '<svg class="chev" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      let body = '';
      if (advOpen) {
        const key = !saved.apiKey
          ? '<p class="hint" style="margin:0">Lägg till nyckeln under Kom igång högst upp.</p>'
          : editingKey || !d.apiKey
          ? `<label class="sr" for="k">API-nyckel</label><input id="k" data-k="k" data-f="apiKey" class="wide" type="text" autocomplete="off" spellcheck="false" placeholder="Klistra in din nyckel" value="${esc(d.apiKey)}">
             <p class="hint" style="margin:8px 0 0">Gratis nyckel för ResRobot v2.1 från trafiklab.se. Den täcker kollektivtrafiken i hela Sverige.</p>`
          : `<div class="keybox"><span class="ok-text">✓ Ansluten</span><span class="mono">${esc(maskKey(d.apiKey))}</span><button class="btn" data-act="editkey" data-k="editkey">Byt nyckel</button></div>`;
        const n = cachedListingCount();
        body = `<div class="adv" id="adv">
          <h4>Trafiklab-nyckel</h4>${key}
          <h4>Kollektivtrafik som får användas</h4>
          <div class="chips" role="group" aria-label="Kollektivtrafik som får användas">${MODES.map((m) => chip('mode', m.key, m.label, d.modes.includes(m.key))).join('')}</div>
          <h4>Detaljer för beräkningen</h4>
          <div class="grid2">
            ${field('changePenalty', 'Ett byte räknas som', d.changePenalty, 'min', num(0, 30))}
            ${field('radiusKm', 'Sök stationer inom', d.radius / 1000, 'km', num(1, 10, 0.5))}
            ${field('walkSpeed', 'Gånghastighet', d.walkSpeed, 'km/h', num(2, 8, 0.5))}
            ${field('bikeSpeed', 'Cykelhastighet', d.bikeSpeed, 'km/h', num(8, 35))}
            ${field('stationBuffer', 'Parkera och nå perrongen', d.stationBuffer, 'min', num(0, 30))}
            ${field('directMax', 'Gå eller cykla hela vägen, som längst', d.directMax, 'min', num(0, 120, 5))}
            ${field('lastHomeEarliest', 'Sista resan hem för tidigt före', d.lastHomeEarliest, 'kl.', timeAttrs)}
          </div>
          <h4>Egna vikter för poängen</h4>
          <div class="grid3">
            ${field('wCommute', 'Pendling', d.weights.commute, '', num(0, 100))}
            ${field('wAccess', 'Station', d.weights.access, '', num(0, 100))}
            ${field('wLastHome', 'Sista hem', d.weights.lastHome, '', num(0, 100))}
          </div>
          <h4>Detaljer, en och en</h4>
          <div class="checks">${DETAILS.map((x) =>
            `<label class="check"><input type="checkbox" data-act="detail" data-v="${x.key}" data-k="detail-${x.key}" ${d.details[x.key] ? 'checked' : ''}>${esc(x.label)}</label>`).join('')}</div>
          <h4>Sparade restider</h4>
          <div class="cache">${undo
            ? `<span>Sparade restider rensade.</span><button class="btn" data-act="undo" data-k="undo">Ångra</button>`
            : `<span>${n === 1 ? '1 bostad' : `${n} bostäder`} i minnet. Rensa om tidtabellen har ändrats.</span><button class="btn" data-act="clear" data-k="clear">Rensa</button>`}</div>
        </div>`;
      }
      return `<div>
        <button class="disclosure" data-act="adv" data-k="adv" aria-expanded="${advOpen}" aria-controls="adv">
          <span class="t"><strong>Avancerat</strong><small>API-nyckel, färdsätt, hastigheter och egna vikter</small></span>${chevron}
        </button>${body}</div>`;
    }

    // Re-render the body, keeping scroll position, focus and caret.
    function paint() {
      const active = sr.activeElement;
      const k = active && active.dataset && active.dataset.k;
      const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
      const top = content.scrollTop;
      content.innerHTML = secWelcome() + secCommute() + secStation() + secLastHome() + secEveryday() + secWeights() + secShow() + secLists() + secAdvanced();
      content.scrollTop = top;
      if (k) {
        const el = sr.querySelector(`[data-k="${k}"]`);
        if (el && !el.disabled) {
          el.focus();
          if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch {}
        }
      }
    }

    // ---------- stop search ----------
    const keyNow = () => (d.apiKey || '').trim();
    async function searchStops(q) {
      if (!keyNow()) { status('Lägg till din Trafiklab-nyckel under Avancerat först', true); return []; }
      return stopsOf(await api('location.name', { input: q, maxNo: 6 }, keyNow()));
    }
    function addStop(s) {
      const id = s.extId || s.id;
      if (d.destinations.some((x) => x.id === id)) return status(`${cleanName(s.name)} finns redan`, true);
      d.destinations.push({ name: cleanName(s.name), id, lat: +s.lat, lon: +s.lon, ...DEFAULT_DEST });
      addQuery = '';
      suggestions = [];
      status(`La till ${cleanName(s.name)}`);
      paint();
    }

    // ---------- events ----------
    const numberFields = {
      changePenalty: (v) => { d.changePenalty = Math.max(0, v); },
      radiusKm: (v) => { d.radius = Math.round(clamp(v || 8, 1, 10) * 1000); },
      walkSpeed: (v) => { d.walkSpeed = v || 5; },
      bikeSpeed: (v) => { d.bikeSpeed = v || 16; },
      stationBuffer: (v) => { d.stationBuffer = Math.max(0, v); },
      directMax: (v) => { d.directMax = clamp(v || 0, 0, 120); },
      wCommute: (v) => { d.weights.commute = Math.max(0, v); },
      wAccess: (v) => { d.weights.access = Math.max(0, v); },
      wLastHome: (v) => { d.weights.lastHome = Math.max(0, v); },
    };
    sr.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'home') {
        const had = !!homeLabel.trim();
        homeLabel = t.value;
        if (had !== !!homeLabel.trim()) paint(); // show or hide the parts that need an address
        return;
      }
      if (t.id === 'add') {
        addQuery = t.value;
        clearTimeout(suggestTimer);
        const q = addQuery.trim();
        if (q.length < 2) { if (suggestions.length) { suggestions = []; paint(); } return; }
        suggestTimer = setTimeout(async () => {
          try { suggestions = await searchStops(q); } catch (err) { status(err.message, true); suggestions = []; }
          if (addQuery.trim() === q) paint();
        }, 300);
        return;
      }
      const f = t.dataset.f;
      if (!f) return;
      if (f in numberFields) numberFields[f](Number(t.value));
      else if (['time', 'lastHomeIdeal', 'lastHomeEarliest', 'apiKey'].includes(f)) {
        d[f] = t.value;
        if (f === 'apiKey' && keyState) { keyState = ''; paint(); } // a new key needs a new test
      }
    });
    sr.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.f === 'lastHome') { d.lastHome = t.value; paint(); }
      else if (t.dataset.f === 'listDest') { d.list.dest = t.value; paint(); }
      else if (t.dataset.f === 'listMax') { d.list.max = +t.value; paint(); }
      else if (t.dataset.act === 'listSort') { d.list.sort = t.checked; paint(); }
      else if (t.dataset.f in numberFields) paint(); // weights and the like update presets and bars
      else if (t.dataset.act === 'detail') { d.details[t.dataset.v] = t.checked; paint(); }
      else if (t.dataset.act === 'todayDelta') { d.showTodayDelta = t.checked; paint(); }
    });
    sr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'add') { e.preventDefault(); $('[data-act="add"]').click(); }
    });

    sr.addEventListener('click', async (e) => {
      if (e.target.classList.contains('backdrop')) return close();
      const t = e.target.closest('[data-act]');
      if (!t || t.disabled) return;
      const act = t.dataset.act;
      const v = t.dataset.v;
      if (act === 'detail' || act === 'todayDelta' || act === 'listSort') return; // handled by change
      if (act === 'close') return close();
      if (act === 'save') return save();
      if (act === 'reset') {
        d = { ...JSON.parse(JSON.stringify(DEFAULTS)), apiKey: d.apiKey, home: d.home }; // keeps the key and the address
        status('Standardvärdena är tillbaka. Spara för att använda dem.');
      } else if (act === 'seg') {
        const g = t.dataset.g;
        if (g === 'when') d.timeMode = v;
        else if (g === 'level') d.details = detailsFor(v);
        else if (g.startsWith('w-')) d.destinations[+g.slice(2)].weight = +v;
        else if (g.startsWith('evm-')) d.everyday[g.slice(4)].mode = v;
        else if (g === 'listOver') d.list.over = v;
      } else if (act === 'step') {
        const delta = +t.dataset.d;
        const [kind, idx] = t.dataset.s.split('-');
        if (kind === 'ideal' || kind === 'max') {
          const x = d.destinations[+idx];
          if (kind === 'ideal') {
            x.ideal = clamp(round5(x.ideal + delta), 5, 115);
            if (x.max < x.ideal + 5) x.max = Math.min(120, x.ideal + 5);
          } else x.max = clamp(round5(x.max + delta), x.ideal + 5, 120);
        } else if (kind === 'aIdeal') {
          d.accessIdeal = clamp(round5(d.accessIdeal + delta), 5, 40);
          if (d.accessMax < d.accessIdeal + 5) d.accessMax = Math.min(45, d.accessIdeal + 5);
        } else if (kind === 'aMax') {
          d.accessMax = clamp(round5(d.accessMax + delta), d.accessIdeal + 5, 45);
        }
      } else if (act === 'rm') {
        d.destinations.splice(+t.dataset.i, 1);
      } else if (act === 'pick') {
        return addStop(suggestions[+t.dataset.i]);
      } else if (act === 'add') {
        const q = addQuery.trim();
        if (!q) return;
        if (suggestions.length) return addStop(suggestions[0]);
        status('Söker…');
        try {
          const found = await searchStops(q);
          if (!found.length) return status(`Ingen hållplats hittades för ”${q}”`, true);
          return addStop(found[0]);
        } catch (err) { return status(err.message, true); }
      } else if (act === 'way') {
        const on = Object.values(d.accessModes).filter(Boolean).length;
        if (d.accessModes[v] && on === 1) return status('Minst ett sätt att ta sig till stationen behövs', true);
        d.accessModes[v] = !d.accessModes[v];
      } else if (act === 'kpi') {
        if (d.kpis.includes(v)) d.kpis = d.kpis.filter((k) => k !== v);
        else if (d.kpis.length < 3) d.kpis = KPIS.map((k) => k.key).filter((k) => k === v || d.kpis.includes(k));
      } else if (act === 'preset') {
        const p = PRESETS.find((x) => x.key === v);
        d.weights = { commute: p.w[0], access: p.w[1], lastHome: p.w[2] };
      } else if (act === 'mode') {
        if (d.modes.includes(v) && d.modes.length === 1) return status('Minst ett slags kollektivtrafik behövs', true);
        d.modes = d.modes.includes(v) ? d.modes.filter((k) => k !== v) : MODES.map((m) => m.key).filter((k) => k === v || d.modes.includes(k));
      } else if (act === 'evOn') {
        d.everyday[v].on = !d.everyday[v].on;
        if (!d.everyday[v].on) d.kpis = d.kpis.filter((k) => (KPIS.find((x) => x.key === k) || {}).everyday !== v);
      } else if (act === 'homeRm') {
        homeLabel = '';
        d.home = null;
      } else if (act === 'testkey') {
        const key = (d.apiKey || '').trim();
        if (!key) { keyState = 'fail:Klistra in nyckeln först'; paint(); return; }
        keyState = 'testing';
        paint();
        try {
          await api('location.name', { input: 'Göteborg', maxNo: 1 }, key);
          keyState = 'ok';
        } catch (err) {
          keyState = `fail:${err.message}`;
        }
        paint();
        return;
      } else if (act === 'adv') {
        advOpen = !advOpen;
        GM_setValue('advOpen', advOpen);
      } else if (act === 'editkey') {
        editingKey = true;
        paint();
        const k = $('#k');
        if (k) k.focus();
        return;
      } else if (act === 'clear') {
        undo = { ...(cacheMem || GM_getValue('cache', {})) };
        cacheMem = {};
        GM_setValue('cache', {});
        cardJobs.clear();
      } else if (act === 'undo') {
        cacheMem = { ...undo, ...cacheMem };
        GM_setValue('cache', cacheMem);
        undo = null;
      }
      if (act !== 'reset') status('');
      paint();
    });

    async function save() {
      const time = parseTime(d.time), lhi = parseTime(d.lastHomeIdeal), lhe = parseTime(d.lastHomeEarliest);
      const badTime = !time ? 't' : !lhi ? 'lhi' : !lhe ? 'lastHomeEarliest' : null;
      if (badTime) {
        if (badTime === 'lastHomeEarliest' && !advOpen) { advOpen = true; paint(); }
        const el = $(`#${badTime}`);
        if (el) el.focus();
        return status('Skriv tiden som tt:mm, t.ex. 08:00', true);
      }
      if (!d.kpis.length) return status('Välj minst ett värde att visa på bostadssidan', true);
      const label = homeLabel.trim();
      if (!label) d.home = null;
      else if (!(saved.home && saved.home.label === label && saved.home.lat)) {
        status('Letar upp adressen…');
        try {
          d.home = await geocodeHome(label);
        } catch (err) {
          return status(`Kunde inte söka adressen: ${err.message}`, true);
        }
        if (!d.home) { const el = $('#home'); if (el) el.focus(); return status(`Hittade inte ”${label}”. Prova att lägga till orten.`, true); }
      } else d.home = saved.home;
      saveCfg({ ...d, apiKey: (d.apiKey || '').trim(), time, lastHomeIdeal: lhi, lastHomeEarliest: lhe });
      close();
      cardJobs.clear();
      document.querySelectorAll('[data-bcs-card]').forEach((n) => n.remove());
      decorateCards();
      // Route lookups are cached per setting that affects them, so display-only changes just recalculate the score.
      run();
    }

    // ---------- open / close, focus trap ----------
    const prevOverflow = document.documentElement.style.overflow;
    function close() {
      clearTimeout(suggestTimer);
      sheetHost.remove();
      document.documentElement.style.overflow = prevOverflow;
      const back = opener && opener.isConnected ? opener : factEls.find((e) => e.isConnected);
      if (back) back.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); return close(); }
      if (e.key !== 'Tab') return;
      const items = [...sr.querySelectorAll('button:not([disabled]), input, select')].filter((el) => el.offsetParent !== null || el === sr.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && sr.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && sr.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    sr.addEventListener('keydown', onKey, true); // keys pressed in the frame stay in the frame
    document.documentElement.style.overflow = 'hidden';
    paint();
    fw.focus();
    ($('#k') || $('[data-k="x"]')).focus();
  }

  // =====================================================================
  // Main
  // =====================================================================
  let runToken = 0;
  async function run() {
    const id = listingId();
    mount();
    if (!id) return;
    const token = ++runToken;
    const c = cfg();
    if (!c.apiKey) { state = { status: 'nokey' }; return render(); }
    state = { status: 'loading' };
    render();
    try {
      const p = await getListingCoords(id);
      if (token !== runToken) return;
      if (!p) throw new Error('Bostadens position finns inte i sidans data.');
      state.p = p;
      showPlaceholder();
      const r = await evaluate(p, c);
      if (token !== runToken) return;
      state = { status: 'done', r, sc: score(r, c) };
      const st = state;
      if (c.home && c.home.lat) todayBase(c).then((t) => { st.today = t; if (state === st) render(); });
      if (expanded || c.kpis.some((k) => ['grocery', 'school', 'car'].includes(k))) loadExtras();
    } catch (e) {
      if (token !== runToken) return;
      state = { status: 'error', message: e.message };
    }
    render();
  }

  // While the exact calculation runs, the commute value shows the table's estimate.
  function showPlaceholder() {
    if (state.status !== 'loading' || !state.p) return;
    const c = cfg();
    state.est = estimateMain(state.p, c).e;
    if (state.est) render();
  }

  // Booli re-renders as you navigate: re-attach the panel when it gets dropped, re-run when the URL changes.
  let lastUrl = '';
  let mountTimer = null;
  const soon = () => {
    if (mountTimer) return;
    mountTimer = setTimeout(() => { mountTimer = null; mount(); decorateCards(); }, 300);
  };
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  onPositions = soon;
  onTableLoaded = () => { soon(); showPlaceholder(); };
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; run(); } }, 800);
  decorateCards();

  GM_registerMenuCommand('Pendlingsinställningar', () => openSettings());
  // What the list estimates see on this page: the script version, the table, the destination and the cards found.
  GM_registerMenuCommand('Kopiera listdata för felsökning', () => {
    const c = cfg();
    const storedAt = (name) => { const x = GM_getValue(`table:${name}`, null); return x ? new Date(x.t).toISOString() : null; };
    const cards = findListCards();
    const anchors = [...document.querySelectorAll('a[href]')].filter((a) => LISTING_HREF.test(a.getAttribute('href') || ''));
    const sample = anchors[0] && (anchors[0].closest('li, article') || anchors[0].parentElement);
    const debug = {
      url: location.href,
      version: typeof GM_info !== 'undefined' ? GM_info.script.version : null,
      hasKey: !!c.apiKey,
      list: c.list,
      destinations: c.destinations.map((d) => ({ name: d.name, lat: d.lat, lon: d.lon, weight: d.weight })),
      index: { fetched: storedAt('index'), failed: tablesFailed.has('index'), tables: (tableNow('index') || TABLES).map((m) => m.key) },
      tables: c.destinations.map((d) => {
        const m = tableMetaFor(d);
        const t = m && tableNow(m.key);
        return { destination: d.name, table: m ? m.key : null, fetched: m ? storedAt(m.key) : null, failed: m ? tablesFailed.has(m.key) : null,
          serviceDate: t ? t.data.serviceDate : null, rows: t ? t.stops.length : null };
      }),
      listingLinks: anchors.length,
      cardsFound: cards.length,
      positionsKnown: cards.filter((x) => knownPos(x.id)).length,
      estimates: cards.slice(0, 5).map((x) => ({ id: x.id, pos: knownPos(x.id), text: [...x.line.querySelectorAll('[data-bcs-est]')].map((e) => e.textContent).join(' · ') || null })),
      filterBar: (() => {
        const bar = document.querySelector('[data-bcs-filter]');
        if (!bar) return null;
        const desc = (el) => (el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}` : null);
        const r = bar.getBoundingClientRect();
        return { before: desc(bar.nextElementSibling), parent: desc(bar.parentElement), rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
          visible: !!(r.width && r.height), cardsInList: bar.nextElementSibling ? cards.filter((x) => bar.nextElementSibling.contains(x.card)).length : 0 };
      })(),
      sampleCardHtml: sample ? sample.outerHTML.slice(0, 3000) : null,
    };
    GM_setClipboard(JSON.stringify(debug, null, 2));
    alert('Listdata kopierad. Klistra in den i chatten.');
  });
  // How Booli's map is built: whether the script can reach it and which layer draws the dots.
  GM_registerMenuCommand('Kopiera kartdata för felsökning', () => {
    const el = pageWin.document.querySelector('.maplibregl-map, .mapboxgl-map');
    const markers = document.querySelectorAll('.maplibregl-marker, .mapboxgl-marker');
    const debug = { url: location.href, version: typeof GM_info !== 'undefined' ? GM_info.script.version : null, mapElement: !!el,
      reactKeys: el ? Object.keys(raw(el)).filter((k) => k.startsWith('__react')) : [], domMarkers: markers.length,
      sampleMarker: markers[0] ? markers[0].outerHTML.slice(0, 800) : null };
    try {
      const map = findMap();
      debug.mapInstance = !!map;
      if (map) {
        const style = plain(map.getStyle());
        debug.sources = Object.entries(style.sources || {}).map(([k, v]) => ({ name: k, type: v.type }));
        debug.layers = (style.layers || []).filter((l) => style.sources[l.source] && /listing|project/i.test(l.source))
          .map((l) => ({ id: l.id, type: l.type, source: l.source, sourceLayer: l['source-layer'] || null, filter: l.filter || null }));
        const groups = [...new Set(debug.layers.map((l) => `${l.source}|${l.sourceLayer || ''}`))];
        debug.sampleFeatures = groups.map((g) => {
          const [name, sl] = g.split('|');
          const fs = sourceFeatures(map, name, sl);
          return { source: name, sourceLayer: sl || null, count: fs.length, sample: fs.slice(0, 2).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties })) };
        });
        const info = mapListings(map);
        debug.dots = info ? { source: info.source, sourceLayer: info.sourceLayer, idKey: info.idKey, layers: info.layers.map((l) => l.id), count: info.dots.length, sample: info.dots.slice(0, 3) } : null;
        debug.knownIds = listPos.size;
      }
    } catch (e) { debug.error = String(e && e.message); }
    GM_setClipboard(JSON.stringify(debug, null, 2));
    alert('Kartdata kopierad. Klistra in den i chatten.');
  });
  if (window.__BCS_TEST__) Object.assign(window.__BCS_TEST__, { estimate, reachable, shadeCells, indexTable, positionsIn, cfg, DEFAULTS });
  GM_registerMenuCommand('Kopiera positionsdata för felsökning', async () => {
    const id = listingId();
    if (!id) return alert('Öppna en bostad på Booli först.');
    const debug = { url: location.href, id };
    try { debug.result = await getListingCoords(id, debug); } catch (e) { debug.error = e.message; }
    GM_setClipboard(JSON.stringify(debug, null, 2));
    alert('Positionsdata kopierad. Klistra in den i chatten.');
  });
})();
