// Loads the userscript into jsdom with stubbed GM_* functions.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../booli-pendling.user.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Is the point inside any of the shading's polygons? (Ray casting; the polygons have no holes.)
const shaded = (features, p) => features.filter((f) => f.geometry.type === 'Polygon').some((f) => {
  const ring = f.geometry.coordinates[0];
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > p.lat) !== (yb > p.lat) && p.lon < ((xb - xa) * (p.lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
});
const opened = [];
afterEach(() => { while (opened.length) opened.pop().close(); }); // jsdom timers would keep the runner alive

// Five stops around Göteborg. P is ~0.6 km from "Nära station" and ~2.4 km from "Snabb buss".
const TABLE = {
  version: 1,
  destination: { key: 'gbg-c', name: 'Göteborg Centralstation', lat: 57.7089, lon: 11.9735 },
  serviceDate: '2026-10-20', arriveBy: '08:00', generated: new Date().toISOString(), source: 'test',
  fields: ['lat', 'lon', 'min', 'chg', 'modes', 'last', 'name'],
  stops: [
    [57.65, 12.01, 20, 0, 't', '00:10', 'Nära station'],
    [57.65, 12.04, 5, 0, 'b', null, 'Snabb buss'],
    [57.695, 11.9735, 15, 1, 'sb', '23:50', 'Centrumnära'],
    [57.55, 12.0, 60, 1, 'tb', null, 'Långsam'],
    [57.4, 11.9, 50, 0, 't', '22:00', 'Söderut'],
  ],
};
const P = { lat: 57.65, lon: 12.0 };
const meta = (t) => ({ ...t.destination, label: t.destination.label || 'Göteborg C', generated: t.generated });
const INDEX = (...tables) => ({ t: Date.now(), v: '9.9.9', data: { version: 1, tables: tables.map(meta) } });
// A second destination at Lindholmen, with every stop 10 min further away.
const LINDHOLMEN = { ...TABLE, destination: { key: 'lindholmen', name: 'Lindholmen', label: 'Lindholmen', lat: 57.70675, lon: 11.93835 },
  stops: TABLE.stops.map((r) => [r[0], r[1], r[2] + 10, ...r.slice(3)]) };
const STORE = { 'table:index': INDEX(TABLE), 'table:gbg-c': { t: Date.now(), data: TABLE } };

function load({ url = 'https://www.booli.se/', body = '', store = {}, before } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const values = new Map(Object.entries(store));
  const requests = [];
  w.GM_getValue = (k, d) => (values.has(k) ? JSON.parse(JSON.stringify(values.get(k))) : d);
  w.GM_setValue = (k, v) => values.set(k, JSON.parse(JSON.stringify(v)));
  w.GM_xmlhttpRequest = (o) => { requests.push(o.url); setTimeout(() => o.onerror && o.onerror(), 0); };
  const menu = {};
  w.GM_registerMenuCommand = (name, fn) => { menu[name] = fn; };
  w.GM_setClipboard = () => {};
  w.GM_info = { script: { version: '9.9.9' } };
  w.fetch = async (u) => { requests.push(String(u)); return { text: async () => '' }; };
  w.__BCS_TEST__ = {};
  if (before) before(w);
  w.eval(SRC);
  opened.push(w);
  return { w, api: w.__BCS_TEST__, values, requests, menu, close: () => {} };
}

test('estimate(): walking, cycling, Som längst, direct bike, no stop nearby', () => {
  const { api, close } = load();
  const t = api.indexTable(TABLE);
  const base = api.cfg(); // walk 5 km/h, bike 16 km/h, Som längst 30 min, 3 min to park, whole way up to 45 min
  const walkOnly = { ...base, accessModes: { walk: true, bike: false, bus: true } };

  const walk = api.estimate(P, walkOnly, t);
  assert.equal(walk.via, 'Nära station');
  assert.equal(walk.access.how, 'walk');
  assert.equal(walk.access.mins, 9);
  assert.equal(walk.mins, 29);
  assert.equal(walk.last, '00:10');

  // Snabb buss is 37 min on foot (over Som längst) but 12 min by bike: 12 + 3 + 5 = 20.
  const bike = api.estimate(P, base, t);
  assert.equal(bike.via, 'Snabb buss');
  assert.equal(bike.access.how, 'bike');
  assert.equal(bike.mins, 20);

  assert.equal(api.estimate(P, { ...walkOnly, accessMax: 5 }, t), null);

  const near = api.estimate({ lat: 57.69, lon: 11.9735 }, base, t);
  assert.equal(near.direct, true);
  assert.equal(near.access.how, 'bike');
  assert.equal(near.mins, 10);

  assert.equal(api.estimate({ lat: 58.5, lon: 13.5 }, base, t), null);
  close();
});

test('the map\'s commute minutes agree with estimate() at the grid points', () => {
  const { api } = load();
  const t = api.indexTable(TABLE);
  const ts = [{ meta: { key: 'gbg-c' }, t }];
  for (const c of [api.cfg(), { ...api.cfg(), accessModes: { walk: true, bike: false, bus: true } }]) {
    const m = 250, view = api.fieldView([[11.85, 57.5], [12.2, 57.75]], m);
    const value = api.fieldNow(view, m, c, ts);
    let n = 0, off = 0;
    for (let i = view.i0; i < view.i1; i += 3) for (let j = view.j0; j < view.j1; j += 3) {
      const p = { lat: (i * m) / 111200, lon: (j * m) / (111200 * Math.cos((57.7 * Math.PI) / 180)) };
      const e = api.estimate(p, c, t), v = value(i, j);
      n++;
      // Right at a cut-off (45 min whole way, 30 min to a stop) flat and round-earth distances can round apart.
      if (!e ? v < 200 : Math.abs(v - e.mins) > 1.5) off++;
    }
    assert.ok(n > 300 && off / n < 0.02, `${off} of ${n} differ by more than 1.5 min`);
  }
});

test('the background worker gives exactly the same minutes as working them out on the page', () => {
  const { api } = load();
  const t = api.indexTable(TABLE), c = api.cfg();
  const m = 250, view = api.fieldView([[11.85, 57.5], [12.2, 57.75]], m);
  const here = api.fieldNow(view, m, c, [{ meta: { key: 'gbg-c' }, t }]);
  // Run the worker's own code in a sandbox, with the messages the page sends it.
  const posted = [];
  const self = { postMessage: (msg) => posted.push(msg) };
  vm.runInNewContext(api.fieldWorkerSource(), { self, Math, Map, Float32Array, Int32Array });
  self.onmessage({ data: { type: 'table', key: 'k', stops: t.stops.map((s) => ({ lat: s.lat, lon: s.lon, min: s.min })),
    dest: { lat: t.dest.lat, lon: t.dest.lon }, kmLon: t.kmLon } });
  self.onmessage({ data: { type: 'field', id: 7, keys: ['k'], view, m, c: { walkSpeed: c.walkSpeed, bikeSpeed: c.bikeSpeed,
    accessMax: c.accessMax, directMax: c.directMax, stationBuffer: c.stationBuffer, accessModes: c.accessModes } } });
  assert.equal(posted[0].id, 7);
  const vw = view.j1 - view.j0 + 1;
  let same = 0;
  for (let i = view.i0; i <= view.i1; i++) for (let j = view.j0; j <= view.j1; j++) {
    assert.equal(posted[0].grid[(i - view.i0) * vw + (j - view.j0)], here(i, j));
    same++;
  }
  assert.ok(same > 1000);
});

test('on the map, the minutes come from the background worker and the shading is drawn from its answer', async () => {
  const sources = new Map();
  let workerMessages = 0;
  const before = (w) => {
    // A worker that runs the script's worker code in a sandbox and answers a moment later, as a real one would.
    w.Blob = class { constructor(parts) { this.src = parts.join(''); } };
    w.URL.createObjectURL = (blob) => { w.__src = blob.src; return 'blob:test'; };
    w.Worker = class {
      constructor() {
        this.self = { postMessage: (msg) => setTimeout(() => this.onmessage({ data: msg }), 5) };
        vm.runInNewContext(w.__src, { self: this.self, Math, Map, Float32Array, Int32Array });
      }
      postMessage(data) { workerMessages++; setTimeout(() => this.self.onmessage({ data }), 5); }
    };
    const el = w.document.getElementById('map');
    const fake = {
      getContainer: () => el, getStyle: () => ({ sources: {}, layers: [] }), querySourceFeatures: () => [],
      getPaintProperty: () => 1, setPaintProperty: () => {}, on: () => {}, getLayer: () => undefined,
      getBounds: () => ({ toArray: () => [[11.85, 57.5], [12.15, 57.72]] }), getZoom: () => 11,
      getSource: (id) => sources.get(id),
      addSource: (id, src) => sources.set(id, { data: src.data, setData(d) { this.data = d; } }),
      addLayer: () => {}, removeLayer: () => {}, removeSource: () => {},
    };
    el.__reactFiber$test = { stateNode: el, memoizedProps: { map: fake }, memoizedState: null, return: null };
  };
  const store = { ...STORE, config: { list: { dest: 'mine', max: 30, over: 'dim' } } };
  load({ url: 'https://www.booli.se/sok/till-salu', body: '<div class="maplibregl-map" id="map"></div>', store, before });
  await sleep(600);
  assert.ok(workerMessages >= 2, 'the table and the request went to the worker');
  const feats = sources.get('bcs-commute-shade').data.features;
  assert.equal(shaded(feats, { lat: 57.55, lon: 12.0 }), true);
  assert.equal(shaded(feats, { lat: 57.65, lon: 12.035 }), false);
});

// Driving minutes around the test area: 1.5 min per km to Göteborg C plus 3 to park; west of 11.9 is sea.
function carTableFixture() {
  const g = { lat0: 57.45, lon0: 11.7, dLat: 0.009, dLon: 0.0168, rows: 40, cols: 40 };
  const bytes = new Uint8Array(g.rows * g.cols);
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const lat = g.lat0 + r * g.dLat, lon = g.lon0 + c * g.dLon;
    const km = Math.hypot((lat - 57.7089) * 111.2, (lon - 11.9735) * 59.5);
    bytes[r * g.cols + c] = lon < 11.9 ? 255 : Math.round(km * 1.5 + 3);
  }
  return { version: 1, destination: { ...TABLE.destination, label: 'Göteborg C' }, generated: new Date().toISOString(),
    source: 'test', parkMinutes: 3, grid: g, minutes: Buffer.from(bytes).toString('base64') };
}

test('by car: Färdsätt appears once driving times exist, and Bil switches every card to them', () => {
  const CAR = carTableFixture();
  const carIndex = { t: Date.now(), v: '9.9.9', data: { version: 1, tables: [{ ...meta(TABLE), carGenerated: CAR.generated }] } };
  const plain = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml, store: STORE });
  assert.equal(plain.w.document.querySelector('[data-bcs-row="mode"]').hidden, true, 'no driving times yet');

  const { w, values } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml,
    store: { ...STORE, 'table:index': carIndex, 'table:car:gbg-c': { t: Date.now(), data: CAR } } });
  const doc = w.document;
  assert.equal(doc.querySelector('[data-bcs-row="mode"]').hidden, false);
  assert.deepEqual([...doc.querySelectorAll('[data-bcs-panel] [data-f="mode"]')].map((x) => x.textContent.trim()), ['🚆Kollektivt', '🚗Bil']);
  doc.querySelector('[data-bcs-panel] [data-f="mode"][data-v="car"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(values.get('config').list.mode, 'car');
  assert.equal(doc.querySelector('[data-bcs-panel] [data-f="mode"][data-v="car"]').className, 'tile tile-on');
  for (const l of listings) {
    const want = Math.round(Math.hypot((l.lat - 57.7089) * 111.2, (l.lon - 11.9735) * 59.5) * 1.5 + 3);
    const m = /^ca (\d+) min med bil till Göteborg C$/.exec(est(doc, l.id).textContent.trim());
    assert.ok(m, est(doc, l.id).textContent);
    assert.ok(Math.abs(+m[1] - want) <= 1, `${l.id}: ${m[1]} vs ${want}`);
  }
});

test('by car: a house with no road nearby says "körtid okänd", and the map shades from the car minutes', async () => {
  const CAR = carTableFixture();
  const carIndex = { t: Date.now(), v: '9.9.9', data: { version: 1, tables: [{ ...meta(TABLE), carGenerated: CAR.generated }] } };
  const sources = new Map();
  let workers = 0;
  const before = (w) => {
    w.Worker = class { constructor() { workers++; } postMessage() {} };
    const el = w.document.getElementById('map');
    const fake = {
      getContainer: () => el, getStyle: () => ({ sources: {}, layers: [] }), querySourceFeatures: () => [],
      getPaintProperty: () => 1, setPaintProperty: () => {}, on: () => {}, getLayer: () => undefined,
      getBounds: () => ({ toArray: () => [[11.92, 57.55], [12.15, 57.72]] }), getZoom: () => 11,
      getSource: (id) => sources.get(id),
      addSource: (id, src) => sources.set(id, { data: src.data, setData(d) { this.data = d; } }),
      addLayer: () => {}, removeLayer: () => {}, removeSource: () => {},
    };
    el.__reactFiber$test = { stateNode: el, memoizedProps: { map: fake }, memoizedState: null, return: null };
  };
  const sea = `<li><a href="/annons/777001"><h3>Ön</h3><div class="facts"><span>90 m²</span><span>3 rum</span><span>500 m² tomt</span></div></a></li>`;
  const body = `<div class="maplibregl-map" id="map"></div><main><ul id="list">${sea}${listings.map(card).join('')}</ul></main>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { r: [{ booliId: 777001, location: { position: { latitude: 57.62, longitude: 11.8 } } },
      ...listings.map((l) => ({ booliId: l.id, location: { position: { latitude: l.lat, longitude: l.lon } } }))] } })}</script>`;
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body, before,
    store: { ...STORE, 'table:index': carIndex, 'table:car:gbg-c': { t: Date.now(), data: CAR },
      config: { list: { dest: 'mine', mode: 'car', max: 20, over: 'dim' } } } });
  assert.equal(est(w.document, 777001).textContent.trim(), 'körtid okänd med bil till Göteborg C');
  await sleep(500);
  assert.equal(workers, 0, 'driving minutes need no background worker');
  const feats = sources.get('bcs-commute-shade').data.features;
  // 20 min by car: 1.5 min/km + 3 → about 11 km from Göteborg C.
  assert.equal(shaded(feats, { lat: 57.66, lon: 11.99 }), false); // ~5.5 km: within
  assert.equal(shaded(feats, { lat: 57.57, lon: 12.0 }), true); // ~15.5 km: over
});

test('estimate() runs in well under 1 ms per listing', () => {
  const { api, close } = load();
  const t = api.indexTable({ ...TABLE, stops: Array.from({ length: 5000 }, (_, i) => [57.3 + (i % 100) / 100, 11.6 + Math.floor(i / 100) / 50, 30, 0, 't', null, `S${i}`]) });
  const c = api.cfg();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) api.estimate({ lat: 57.5 + (i % 37) / 100, lon: 11.8 + (i % 23) / 50 }, c, t);
  assert.ok((performance.now() - t0) / 1000 < 1);
  close();
});

test('unknown table versions are ignored', () => {
  const { api, close } = load();
  assert.equal(api.indexTable({ ...TABLE, version: 2 }), null);
  close();
});

// A result page with 32 listings along a line south of Göteborg C, with the map data embedded like Next.js does.
const N = 32;
const listings = Array.from({ length: N }, (_, i) => ({ id: 500000 + i, lat: 57.53 + (i % 8) * 0.018, lon: 11.99 + Math.floor(i / 8) * 0.012 }));
const card = (l) => `<li><a href="/annons/${l.id}"><h3>Gatan ${l.id}</h3><div class="facts"><span>117 m²</span><span>4 rum</span><span>1 286 m² tomt</span></div></a></li>`;
const listHtml = () => `<ul id="list">${listings.map(card).join('')}</ul>`;
const pageHtml = `<main>${listHtml()}</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { search: { result: listings.map((l) => ({ booliId: l.id, location: { position: { latitude: l.lat, longitude: l.lon } } })) } } },
})}</script>`;
// Booli's Sökfilter panel, roughly as it looks: sections with a heading; tiles for Bostadstyp (Villa chosen);
// Antal rum with two labelled selects side by side.
const PANEL = `<div id="sokfilter"><h2>Sökfilter</h2><div class="sections">
  <section class="sec"><h3 class="sec-h">Utöka sökområde</h3><div class="w"><select class="sel"><option>0 km</option></select></div></section>
  <section class="sec"><h3 class="sec-h">Bostadstyp</h3><div class="tiles">
    <button class="tile" aria-pressed="false"><svg class="ico"></svg><span>Lägenhet</span></button>
    <button class="tile tile-on" aria-pressed="true"><svg class="ico"></svg><span>Villa</span></button>
    <button class="tile" aria-pressed="false"><svg class="ico"></svg><span>Gård</span></button></div></section>
  <section class="sec"><h3 class="sec-h">Antal rum</h3><div class="pair">
    <div class="f"><label class="lab">Minst</label><div class="w"><select class="sel" name="minRooms"><option>Visa allt</option></select><svg></svg></div></div>
    <div class="f"><label class="lab">Upp till</label><div class="w"><select class="sel" name="maxRooms"><option>Visa allt</option></select><svg></svg></div></div>
  </div></section>
  <section class="sec"><div class="cols"><div><h3 class="sec-h">Nyproduktion</h3><label><input type="radio" name="np">Visa allt</label></div>
    <div><h3 class="sec-h">Snart till salu</h3><label><input type="radio" name="sts">Visa allt</label></div></div></section>
</div></div>`;
// Like the real panel: the Bostadstyp heading and its tiles share one wrapper inside the section.
const PANEL_WRAPPED = PANEL.replace('<section class="sec"><h3 class="sec-h">Bostadstyp</h3><div class="tiles">', '<section class="sec"><div class="stack"><h3 class="sec-h">Bostadstyp</h3><div class="tiles">')
  .replace('<span>Gård</span></button></div></section>', '<span>Gård</span></button></div></div></section>');
// Booli's sort button and its open menu (the script leaves it alone).
const SORT_MENU = `<div id="sorting"><button id="sortbtn" aria-haspopup="listbox" aria-expanded="true"><span>Nyast</span><svg class="chev"></svg></button>
  <ul class="menu" role="listbox"><li class="mi mi-on"><span>Nyast</span><svg class="check"></svg></li><li class="mi"><span>Äldst</span></li>
  <li class="mi"><span>Pris (Lägst)</span></li></ul></div>`;
const ctl = (doc, f) => doc.querySelector(`[data-bcs-panel] [data-f="${f}"]`);
const est = (doc, id, key = 'gbg-c') => doc.querySelector(`[data-bcs-est="${id}:${key}"]`);
const item = (doc, id) => est(doc, id).closest('li');

test('result list: every card shows an estimate at once, without a key and without Trafiklab calls', async () => {
  const t0 = performance.now();
  const { w, api, requests, close } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body: pageHtml, store: STORE });
  const doc = w.document;
  const t = api.indexTable(TABLE), c = api.cfg();
  for (const l of listings) {
    const el = est(doc, l.id);
    assert.ok(el, `card ${l.id} has an estimate`);
    const e = api.estimate(l, c, t);
    assert.equal(el.textContent.trim(), e ? `ca ${e.mins} min till Göteborg C` : 'pendling okänd till Göteborg C');
  }
  assert.ok(performance.now() - t0 < 1000);
  assert.deepEqual(requests, []); // no fetches at all: positions came from the page, the table from storage
  assert.ok(doc.querySelector('[data-bcs-filter]'));
  close();
});

test('filter hides or dims exactly the cards over the limit, and survives a redraw', async () => {
  const { w, api, values, close } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body: PANEL + SORT_MENU + pageHtml, store: STORE });
  const doc = w.document;
  const t = api.indexTable(TABLE), c = api.cfg();
  const mins = Object.fromEntries(listings.map((l) => [l.id, (api.estimate(l, c, t) || {}).mins]));
  const over = listings.filter((l) => mins[l.id] > 40).map((l) => l.id);
  assert.ok(over.length > 0 && over.length < N, 'the test data has listings on both sides of 40 min');

  const sel = (f) => ctl(doc, f);
  sel('over').value = 'hide';
  sel('over').dispatchEvent(new w.Event('change', { bubbles: true }));
  sel('max').value = '40';
  sel('max').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(values.get('config').list.max, 40);
  const hidden = () => listings.filter((l) => item(doc, l.id).style.display === 'none').map((l) => l.id);
  assert.deepEqual(hidden(), over);

  sel('over').value = 'dim';
  sel('over').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.deepEqual(hidden(), []);
  assert.deepEqual(listings.filter((l) => item(doc, l.id).style.opacity === '0.35').map((l) => l.id), over);

  assert.equal(doc.querySelector('[data-bcs-sort-item]'), null, 'no sorting by commute: Booli sorts its results first');
  assert.ok(listings.every((l) => item(doc, l.id).style.order === ''), 'Booli\'s order is left alone');

  // Booli redraws the list: everything is applied again.
  doc.getElementById('list').outerHTML = listHtml();
  await sleep(450);
  assert.deepEqual(listings.filter((l) => item(doc, l.id).style.opacity === '0.35').map((l) => l.id), over);
  assert.equal(doc.querySelectorAll('[data-bcs-filter]').length, 1);
  close();
});

test('a stray card elsewhere on the page does not move the filter bar away from the list', () => {
  const body = `<header><div class="carousel">${card({ id: 999100 })}</div></header>${pageHtml}`;
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body, store: STORE });
  assert.equal(w.document.querySelector('[data-bcs-filter]').nextElementSibling.id, 'list');
});

test('map dots over the limit are dimmed through the map layer', async () => {
  const calls = [];
  let fake;
  const before = (w) => {
    const el = w.document.getElementById('map');
    fake = {
      getContainer: () => el,
      getStyle: () => ({ sources: { listings: { type: 'geojson' }, osm: { type: 'vector' } },
        layers: [{ id: 'roads', type: 'line', source: 'osm' }, { id: 'dots', type: 'circle', source: 'listings' }] }),
      querySourceFeatures: (name) => (name === 'listings'
        ? listings.map((l) => ({ geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: { booliId: l.id, price: 1 } })) : []),
      getPaintProperty: () => 0.9,
      setPaintProperty: (...a) => calls.push(a),
      getLayer: () => ({}),
      on: () => {},
    };
    // React keeps the map in a hook's ref on the map component, reachable from the container element.
    el.__reactFiber$test = { stateNode: el, memoizedProps: {}, memoizedState: null,
      return: { stateNode: null, memoizedProps: {}, memoizedState: { memoizedState: { current: fake }, next: null }, return: null } };
  };
  const store = { ...STORE, config: { list: { dest: 'mine', max: 40, over: 'dim' } } };
  const { api } = load({ url: 'https://www.booli.se/sok/till-salu', body: `<div class="maplibregl-map" id="map"></div>${pageHtml}`, store, before });
  await sleep(500); // the map is checked a moment after it settles
  const t = api.indexTable(TABLE), c = api.cfg();
  const over = listings.filter((l) => { const e = api.estimate(l, c, t); return e && e.mins > 40; }).map((l) => String(l.id));
  assert.ok(over.length);
  const opacity = calls.filter(([id, prop]) => id === 'dots' && prop === 'circle-opacity').pop();
  assert.deepEqual(JSON.parse(JSON.stringify(opacity[2])), ['case', ['in', ['to-string', ['get', 'booliId']], ['literal', over]], 0.25, 0.9]);
  assert.ok(!calls.some(([id]) => id === 'roads'));
});

test('map dots in vector tiles (like Booli\'s listingSource) are dimmed by feature id', async () => {
  const calls = [], queried = [];
  const before = (w) => {
    const el = w.document.getElementById('map');
    const fake = {
      getContainer: () => el,
      getStyle: () => ({ sources: { protomaps: { type: 'vector' }, listingSource: { type: 'vector' }, projectSource: { type: 'vector' } },
        layers: [{ id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water' },
          { id: 'listing-dots', type: 'circle', source: 'listingSource', 'source-layer': 'listings' },
          { id: 'project-dots', type: 'circle', source: 'projectSource', 'source-layer': 'projects' }] }),
      // Vector tiles only answer with a source layer.
      querySourceFeatures: (name, o) => (queried.push(name), name === 'listingSource' && o && o.sourceLayer === 'listings'
        ? listings.map((l) => ({ id: l.id, geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: { type: 'villa', status: 1 } }))
        : name === 'projectSource' && o && o.sourceLayer === 'projects' ? [{ id: 77, geometry: { type: 'Point', coordinates: [12, 57.6] }, properties: {} }] : []),
      getPaintProperty: () => undefined,
      setPaintProperty: (...a) => calls.push(a),
      getLayer: () => ({}),
      on: () => {},
    };
    el.__reactFiber$test = { stateNode: el, memoizedProps: {}, memoizedState: null,
      return: { stateNode: null, memoizedProps: { mapRef: { current: fake } }, memoizedState: null, return: null } };
  };
  const store = { ...STORE, config: { list: { dest: 'mine', max: 40, over: 'hide' } } };
  const { api } = load({ url: 'https://www.booli.se/sok/till-salu', body: `<div class="maplibregl-map" id="map"></div>${pageHtml}`, store, before });
  await sleep(500);
  const t = api.indexTable(TABLE), c = api.cfg();
  const over = listings.filter((l) => { const e = api.estimate(l, c, t); return e && e.mins > 40; }).map((l) => String(l.id));
  assert.ok(!queried.includes('protomaps'), 'the base map is never queried');
  const opacity = calls.filter(([id, prop]) => id === 'listing-dots' && prop === 'circle-opacity').pop();
  assert.deepEqual(JSON.parse(JSON.stringify(opacity[2])), ['case', ['in', ['to-string', ['id']], ['literal', over]], 0, 1]);
  assert.ok(!calls.some(([id]) => id !== 'listing-dots'));
});

test('areas over the limit are shaded under the dots, so grouped dots are covered too', async () => {
  const sources = new Map(), layers = [];
  let view = [[11.85, 57.5], [12.15, 57.72]], fake;
  const before = (w) => {
    const el = w.document.getElementById('map');
    fake = {
      getContainer: () => el,
      getStyle: () => ({ sources: { listingSource: { type: 'vector' } }, layers: [{ id: 'listing-dots', type: 'circle', source: 'listingSource', 'source-layer': 'l' }] }),
      querySourceFeatures: () => listings.map((l) => ({ id: l.id, geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: {} })),
      getPaintProperty: () => 1, setPaintProperty: () => {}, on: () => {},
      getLayer: (id) => (id === 'listing-dots' || layers.some((l) => l.id === id) ? {} : undefined),
      getBounds: () => ({ toArray: () => view }),
      getZoom: () => 11,
      getSource: (id) => sources.get(id),
      addSource: (id, src) => sources.set(id, { data: src.data, setData(d) { this.data = d; } }),
      addLayer: (layer, beforeId) => layers.push({ ...layer, beforeId }),
      removeLayer: () => {}, removeSource: () => {},
    };
    fake = { ...fake, idleCount: 0, on: (ev, fn) => { if (ev === 'idle') { fake.idle = fn; fake.idleCount++; } } };
    el.__reactFiber$test = { stateNode: el, memoizedProps: { map: fake }, memoizedState: null, return: null };
  };
  const store = { ...STORE, config: { list: { dest: 'mine', max: 30, over: 'dim' } } };
  const { api } = load({ url: 'https://www.booli.se/sok/till-salu', body: `<div class="maplibregl-map" id="map"></div>${pageHtml}`, store, before });
  await sleep(500);
  const shade = layers.find((l) => l.id === 'bcs-commute-shade');
  assert.equal(shade.type, 'fill');
  assert.equal(shade.beforeId, 'listing-dots'); // under the dots
  assert.equal(layers.find((l) => l.id === 'bcs-commute-shade-edge').type, 'line'); // the limit's edge
  const feats = () => sources.get('bcs-commute-shade').data.features;
  assert.ok(feats().some((f) => f.geometry.type === 'LineString'));
  const t = api.indexTable(TABLE), c = api.cfg();
  const near = { lat: 57.65, lon: 12.035 }; // by Snabb buss: well under 30 min
  const far = { lat: 57.55, lon: 12.0 }; // by Långsam: over 30 min
  assert.ok(api.estimate(near, c, t).mins < 25 && api.estimate(far, c, t).mins > 35);
  assert.equal(shaded(feats(), near), false);
  assert.equal(shaded(feats(), far), true);

  // Panning keeps the grid on the same lines: the same area gives exactly the same shapes.
  const box = (f) => f.geometry.coordinates.flat(f.geometry.type === 'Polygon' ? 1 : 0)
    .every(([x, y]) => x > 11.95 && x < 12.05 && y > 57.58 && y < 57.66);
  const shapes = () => feats().filter(box).map((f) => JSON.stringify(f.geometry)).sort();
  const first = shapes();
  assert.ok(first.length > 3);
  view = [[11.873, 57.513], [12.173, 57.733]];
  fake.idle();
  await sleep(500);
  assert.deepEqual(shapes(), first, 'cells stay on the same grid lines');
  assert.equal(shaded(feats(), far), true);
  assert.equal(fake.idleCount, 1, 'one idle listener, however often the map is checked');
});

test('zoomed out, a small pocket within the limit near a stop is not lost in a big square', async () => {
  // One stop, 5 min from the destination, far from it: only a walk of about a kilometre around it is within 20 min.
  const POCKET = { ...TABLE, generated: new Date().toISOString(), stops: [[57.6205, 11.8012, 5, 0, 't', null, 'Fickan']] };
  const sources = new Map();
  const before = (w) => {
    const el = w.document.getElementById('map');
    const fake = {
      getContainer: () => el, getStyle: () => ({ sources: {}, layers: [] }), querySourceFeatures: () => [],
      getPaintProperty: () => 1, setPaintProperty: () => {}, on: () => {}, getLayer: () => undefined,
      getBounds: () => ({ toArray: () => [[11.4, 57.4], [12.3, 57.85]] }), getZoom: () => 9.5,
      getSource: (id) => sources.get(id),
      addSource: (id, src) => sources.set(id, { data: src.data, setData(d) { this.data = d; } }),
      addLayer: () => {}, removeLayer: () => {}, removeSource: () => {},
    };
    el.__reactFiber$test = { stateNode: el, memoizedProps: { map: fake }, memoizedState: null, return: null };
  };
  const store = { 'table:index': INDEX(POCKET), 'table:gbg-c': { t: Date.now(), data: POCKET },
    config: { accessModes: { walk: true, bike: false, bus: true }, list: { dest: 'mine', max: 20, over: 'dim' } } };
  load({ url: 'https://www.booli.se/sok/till-salu', body: '<div class="maplibregl-map" id="map"></div>', store, before });
  await sleep(500);
  const feats = sources.get('bcs-commute-shade').data.features;
  assert.equal(shaded(feats, { lat: 57.6205, lon: 11.8012 }), false, 'the stop itself is within the limit');
  assert.equal(shaded(feats, { lat: 57.6205, lon: 11.9 }), true, '6 km away is over');
});

test('the shading lies under Booli\'s search-area layers, in violet, and continues smoothly under them', async () => {
  const sources = new Map(), layers = [];
  const before = (w) => {
    const el = w.document.getElementById('map');
    const fake = {
      getContainer: () => el,
      getStyle: () => ({ sources: { polygonSource: { type: 'geojson' }, maskSource: { type: 'geojson' } },
        layers: [{ id: 'booli-mask', type: 'fill', source: 'maskSource' }, { id: 'booli-outline', type: 'line', source: 'polygonSource' }] }),
      querySourceFeatures: () => [], getPaintProperty: () => 1, setPaintProperty: () => {}, on: () => {},
      getLayer: (id) => (['booli-mask', 'booli-outline'].includes(id) || layers.some((l) => l.id === id) ? {} : undefined),
      getBounds: () => ({ toArray: () => [[11.8, 57.45], [12.2, 57.68]] }), getZoom: () => 11,
      getSource: (id) => sources.get(id),
      addSource: (id, src) => sources.set(id, { data: src.data, setData(d) { this.data = d; } }),
      addLayer: (layer, beforeId) => layers.push({ ...layer, beforeId }), removeLayer: () => {}, removeSource: () => {},
    };
    el.__reactFiber$test = { stateNode: el, memoizedProps: { map: fake }, memoizedState: null, return: null };
  };
  const store = { ...STORE, config: { list: { dest: 'mine', max: 20, over: 'dim' } } };
  load({ url: 'https://www.booli.se/sok/till-salu', body: '<div class="maplibregl-map" id="map"></div>', store, before });
  await sleep(500);
  const fill = layers.find((l) => l.id === 'bcs-commute-shade'), edge = layers.find((l) => l.id === 'bcs-commute-shade-edge');
  assert.equal(fill.beforeId, 'booli-mask', 'under Booli\'s grey and outline');
  assert.equal(edge.beforeId, 'booli-mask');
  assert.equal(fill.paint['fill-color'], '#5b3a9e');
  const feats = sources.get('bcs-commute-shade').data.features;
  assert.equal(shaded(feats, { lat: 57.47, lon: 11.85 }), true, 'not cut at the search area: Booli\'s grey covers it');
});

test('listings without a position stay visible and say "pendling okänd"', async () => {
  const body = `<main><ul id="list">${card({ id: 999001 })}${card({ id: 999002 })}</ul></main>`;
  const { w, close } = load({ url: 'https://www.booli.se/sok/till-salu', body, store: {
    ...STORE,
    config: { list: { dest: 'mine', max: 20, over: 'hide' } },
  } });
  await sleep(50); // per-listing fetches fail in the stub
  await sleep(400);
  for (const id of [999001, 999002]) {
    assert.equal(est(w.document, id).textContent.trim(), 'pendling okänd till Göteborg C');
    assert.notEqual(item(w.document, id).style.display, 'none');
  }
  close();
});

test('resmål without a table: the list shows the first published destination instead of the button', () => {
  const store = { ...STORE, config: { apiKey: 'k', destinations: [{ name: 'Partille station', id: '1', lat: 57.74107, lon: 12.10366 }] } };
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml, store });
  assert.equal(w.document.querySelectorAll('[data-bcs-est$=":gbg-c"]').length, N);
  assert.equal(w.document.querySelectorAll('[data-bcs-btn]').length, 0);
  assert.equal(ctl(w.document, 'dest').value, 'gbg-c');
});

test('list estimates switched off: the old button comes back (with a key)', () => {
  const store = { ...STORE, config: { apiKey: 'k', list: { dest: 'off' } } };
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  assert.equal(w.document.querySelectorAll('[data-bcs-est]').length, 0);
  assert.equal(w.document.querySelectorAll('[data-bcs-btn]').length, N);
  assert.equal(w.document.querySelector('[data-bcs-filter]'), null);
});

test('choosing a destination in Sökfilter switches every card to that table', () => {
  const store = { ...STORE, 'table:index': INDEX(TABLE, LINDHOLMEN), 'table:lindholmen': { t: Date.now(), data: LINDHOLMEN } };
  const { w, api, values } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml, store });
  const doc = w.document, sel = ctl(doc, 'dest');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['Mina resmål (Göteborg C)', 'Göteborg C', 'Lindholmen']);
  sel.value = 'lindholmen';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(values.get('config').list.dest, 'lindholmen');
  const t = api.indexTable(LINDHOLMEN), c = api.cfg(), l = listings[0], e = api.estimate(l, c, t);
  assert.equal(est(doc, l.id, 'lindholmen').textContent.trim(), e ? `ca ${e.mins} min till Lindholmen` : 'pendling okänd till Lindholmen');
  assert.equal(doc.querySelectorAll('[data-bcs-est$=":gbg-c"]').length, 0);
});

test('the controls are a section in Booli\'s Sökfilter panel, built from its own parts', async () => {
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml, store: STORE });
  const doc = w.document, section = doc.querySelector('[data-bcs-panel]');
  // Last, after "Nyproduktion / Snart till salu", with Booli's own classes.
  assert.match(section.previousElementSibling.textContent, /Nyproduktion[\s\S]*Snart till salu/);
  assert.equal(section.nextElementSibling, null);
  assert.equal(section.className, 'sec');
  assert.equal(section.querySelector('h3.sec-h').textContent, 'Pendling');
  const labels = [...section.querySelectorAll('label.lab')].map((l) => l.textContent);
  assert.deepEqual(labels, ['Pendling till', 'Max restid', 'Över gränsen']);
  assert.ok([...section.querySelectorAll('select')].every((s) => s.className === 'sel' && !s.name));
  assert.equal(section.querySelector('.pair').children.length, 3);
  assert.equal(ctl(doc, 'sort'), null);
  // Booli redraws and adds a part at the end: the section moves back after Snart till salu.
  const extra = doc.createElement('section');
  extra.className = 'sec';
  extra.textContent = 'Något nytt';
  doc.querySelector('.sections').appendChild(extra);
  await sleep(400);
  assert.match(doc.querySelector('[data-bcs-panel]').previousElementSibling.textContent, /Snart till salu/);
  // Booli's own parts are untouched.
  assert.equal(doc.querySelectorAll('[data-bcs-panel]').length, 1);
  assert.equal(doc.querySelector('.sec:not([data-bcs-panel]) button.tile-on span').textContent, 'Villa');
});

test('when heading and tiles share a wrapper, the section copies the wrapper with our tiles instead of Booli\'s', () => {
  assert.ok(PANEL_WRAPPED.includes('class="stack"'));
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL_WRAPPED + pageHtml, store: STORE });
  const section = w.document.querySelector('[data-bcs-panel]');
  const stack = section.querySelector('.stack');
  assert.equal(stack.querySelector('h3').textContent, 'Pendling');
  assert.equal(stack.querySelector('[data-bcs-row="mode"]').className, 'tiles');
  assert.deepEqual([...section.querySelectorAll('span')].map((x) => x.textContent).filter((x) => /Lägenhet|Villa|Gård/.test(x)), [],
    'none of Booli\'s Bostadstyp tiles came along');
  assert.equal(w.document.querySelectorAll('button.tile').length, 3 + 2, 'Booli\'s three, and our Kollektivt and Bil');
});

test('on the page, one line under Sökfilter says what is active and opens Sökfilter', () => {
  const head = `<div id="head"><div id="row"><button id="sf"><svg></svg><span>Sökfilter</span><span>1</span></button>
    <button>Spara sökning</button></div><p>Villor till salu</p></div>`;
  const store = { ...STORE, config: { list: { dest: 'mine', max: 40, over: 'dim' } } };
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: head + pageHtml, store });
  const doc = w.document, line = doc.querySelector('[data-bcs-filter]');
  assert.equal(line.previousElementSibling.id, 'row');
  assert.match(line.textContent, /^Pendling: högst 40 min kollektivt till Göteborg C · \d+ av 32 över gränsen\. Ändra under Sökfilter$/);
  assert.equal(doc.querySelectorAll('select[data-f]').length, 0, 'no controls on the page itself');
  let opened = 0;
  doc.getElementById('sf').addEventListener('click', () => opened++);
  line.querySelector('[data-act="open"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(opened, 1);
});

test('two resmål with tables: one estimate each, and the filter uses the longest', () => {
  const store = {
    'table:index': INDEX(TABLE, LINDHOLMEN), 'table:gbg-c': { t: Date.now(), data: TABLE }, 'table:lindholmen': { t: Date.now(), data: LINDHOLMEN },
    config: {
      destinations: [{ name: 'Göteborg Centralstation', id: '740000002', lat: 57.708895, lon: 11.973479 }, { name: 'Göteborg Lindholmen', id: '2', lat: 57.70814, lon: 11.938088 }],
      list: { dest: 'mine', max: 40, over: 'hide' },
    },
  };
  const { w, api, requests } = load({ url: 'https://www.booli.se/sok/till-salu', body: PANEL + pageHtml, store });
  const doc = w.document, c = api.cfg();
  const [tc, tl] = [api.indexTable(TABLE), api.indexTable(LINDHOLMEN)];
  for (const l of listings) {
    const [a, b] = [api.estimate(l, c, tc), api.estimate(l, c, tl)];
    assert.equal(est(doc, l.id).textContent.trim(), a ? `ca ${a.mins} min till Göteborg C` : 'pendling okänd till Göteborg C');
    assert.equal(est(doc, l.id, 'lindholmen').textContent.trim(), b ? `ca ${b.mins} min till Lindholmen` : 'pendling okänd till Lindholmen');
    const over = a && b && Math.max(a.mins, b.mins) > 40;
    assert.equal(item(doc, l.id).style.display === 'none', !!over, `listing ${l.id}`);
  }
  assert.equal(ctl(doc, 'dest').value, 'mine');
  assert.equal(ctl(doc, 'dest').selectedOptions[0].textContent, 'Mina resmål (Göteborg C, Lindholmen)');
  assert.deepEqual(requests, []);
});

test('an index older than 6 hours is fetched again, and so is a table the index says was rebuilt', () => {
  const old = Date.now() - 7 * 3600 * 1000;
  const rebuilt = { ...TABLE.destination, label: 'Göteborg C', generated: '2099-01-01T00:00:00Z' };
  const { requests } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store: {
    'table:index': { t: old, data: { version: 1, tables: [rebuilt] } }, 'table:gbg-c': { t: Date.now(), data: TABLE } } });
  assert.ok(requests.includes('https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/tables.json'));
  assert.ok(requests.includes('https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/travel-times-gbg-c.json'));
});

test('an index saved by an earlier version of the script is fetched again at once', () => {
  const { requests } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store: { ...STORE, 'table:index': { ...INDEX(TABLE), v: '1.11.0' } } });
  assert.ok(requests.includes('https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/tables.json'));
});

test('the table is fetched on first use when nothing is stored', async () => {
  const { requests, close } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml });
  assert.ok(requests.includes('https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/travel-times-gbg-c.json'));
  close();
});

test('settings open without document.write, which Firefox refuses to a userscript running in the page', async () => {
  const before = (w) => {
    w.focus = () => {};
    const refuse = () => { throw new w.DOMException('The operation is insecure.', 'SecurityError'); };
    // Frames have their own Document class, so refuse on every frame's document as it is handed out.
    const desc = Object.getOwnPropertyDescriptor(w.HTMLIFrameElement.prototype, 'contentDocument');
    Object.defineProperty(w.HTMLIFrameElement.prototype, 'contentDocument', { configurable: true, get() {
      const d = desc.get.call(this);
      if (d) { d.open = refuse; d.write = refuse; }
      return d;
    } });
  };
  const { w, menu } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store: STORE, before });
  await menu['Pendlingsinställningar']();
  const frame = w.document.querySelector('iframe[title="Pendlingsinställningar"]');
  const doc = frame.contentDocument;
  assert.ok(doc.querySelector('.sheet') && doc.querySelector('style'));
  const headings = [...doc.querySelectorAll('h3')].map((h) => h.textContent);
  assert.ok(headings.includes('Vart pendlar du?') && headings.includes('Listor och kartan'), headings.join(', '));
  doc.querySelector('[data-act="close"]').click();
  assert.equal(w.document.querySelector('iframe[title="Pendlingsinställningar"]'), null);
});

test('the listing page without a key asks for it and makes no calls', async () => {
  const { w, requests, close } = load({ url: 'https://www.booli.se/annons/123456', body: '<h1>Gatan 1</h1>' });
  await sleep(900); // the URL watcher runs every 800 ms
  const host = w.document.getElementById('booli-commute-score');
  assert.match(host.shadowRoot.innerHTML, /Lägg till en gratis API-nyckel/);
  assert.deepEqual(requests, []);
  close();
});
