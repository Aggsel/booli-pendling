// Loads the userscript into jsdom with stubbed GM_* functions.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../booli-pendling.user.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const meta = (t) => ({ ...t.destination, label: t.destination.label || 'Göteborg C' });
const INDEX = (...tables) => ({ t: Date.now(), data: { version: 1, tables: tables.map(meta) } });
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
  w.GM_registerMenuCommand = () => {};
  w.GM_setClipboard = () => {};
  w.fetch = async (u) => { requests.push(String(u)); return { text: async () => '' }; };
  w.__BCS_TEST__ = {};
  if (before) before(w);
  w.eval(SRC);
  opened.push(w);
  return { w, api: w.__BCS_TEST__, values, requests, close: () => {} };
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

test('filter hides or dims exactly the cards over the limit, sorting reorders them, and both survive a redraw', async () => {
  const { w, api, values, close } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body: pageHtml, store: STORE });
  const doc = w.document;
  const t = api.indexTable(TABLE), c = api.cfg();
  const mins = Object.fromEntries(listings.map((l) => [l.id, (api.estimate(l, c, t) || {}).mins]));
  const over = listings.filter((l) => mins[l.id] > 40).map((l) => l.id);
  assert.ok(over.length > 0 && over.length < N, 'the test data has listings on both sides of 40 min');

  const bar = doc.querySelector('[data-bcs-filter]');
  const sel = (f) => bar.querySelector(`[data-f="${f}"]`);
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

  sel('sort').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const shown = () => listings.map((l) => ({ id: l.id, order: +item(doc, l.id).style.order })).sort((a, b) => a.order - b.order).map((x) => mins[x.id] ?? 1e6);
  assert.deepEqual(shown(), [...shown()].sort((a, b) => a - b));

  // Booli redraws the list: everything is applied again.
  doc.getElementById('list').outerHTML = listHtml();
  await sleep(450);
  assert.deepEqual(listings.filter((l) => item(doc, l.id).style.opacity === '0.35').map((l) => l.id), over);
  assert.deepEqual(shown(), [...shown()].sort((a, b) => a - b));
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
  const store = { ...STORE, config: { list: { dest: 'mine', max: 40, over: 'dim', sort: false } } };
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
  const store = { ...STORE, config: { list: { dest: 'mine', max: 40, over: 'hide', sort: false } } };
  const { api } = load({ url: 'https://www.booli.se/sok/till-salu', body: `<div class="maplibregl-map" id="map"></div>${pageHtml}`, store, before });
  await sleep(500);
  const t = api.indexTable(TABLE), c = api.cfg();
  const over = listings.filter((l) => { const e = api.estimate(l, c, t); return e && e.mins > 40; }).map((l) => String(l.id));
  assert.ok(!queried.includes('protomaps'), 'the base map is never queried');
  const opacity = calls.filter(([id, prop]) => id === 'listing-dots' && prop === 'circle-opacity').pop();
  assert.deepEqual(JSON.parse(JSON.stringify(opacity[2])), ['case', ['in', ['to-string', ['id']], ['literal', over]], 0, 1]);
  assert.ok(!calls.some(([id]) => id !== 'listing-dots'));
});

test('listings without a position stay visible and say "pendling okänd"', async () => {
  const body = `<main><ul id="list">${card({ id: 999001 })}${card({ id: 999002 })}</ul></main>`;
  const { w, close } = load({ url: 'https://www.booli.se/sok/till-salu', body, store: {
    ...STORE,
    config: { list: { dest: 'mine', max: 20, over: 'hide', sort: false } },
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
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  assert.equal(w.document.querySelectorAll('[data-bcs-est$=":gbg-c"]').length, N);
  assert.equal(w.document.querySelectorAll('[data-bcs-btn]').length, 0);
  assert.equal(w.document.querySelector('[data-f="dest"]').value, 'gbg-c');
});

test('list estimates switched off: the old button comes back (with a key)', () => {
  const store = { ...STORE, config: { apiKey: 'k', list: { dest: 'off' } } };
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  assert.equal(w.document.querySelectorAll('[data-bcs-est]').length, 0);
  assert.equal(w.document.querySelectorAll('[data-bcs-btn]').length, N);
  assert.equal(w.document.querySelector('[data-bcs-filter]'), null);
});

test('choosing a destination in the bar switches every card to that table', () => {
  const store = { ...STORE, 'table:index': INDEX(TABLE, LINDHOLMEN), 'table:lindholmen': { t: Date.now(), data: LINDHOLMEN } };
  const { w, api, values } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  const doc = w.document, sel = doc.querySelector('[data-f="dest"]');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['Mina resmål (Göteborg C)', 'Göteborg C', 'Lindholmen']);
  sel.value = 'lindholmen';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(values.get('config').list.dest, 'lindholmen');
  const t = api.indexTable(LINDHOLMEN), c = api.cfg(), l = listings[0], e = api.estimate(l, c, t);
  assert.equal(est(doc, l.id, 'lindholmen').textContent.trim(), e ? `ca ${e.mins} min till Lindholmen` : 'pendling okänd till Lindholmen');
  assert.equal(doc.querySelectorAll('[data-bcs-est$=":gbg-c"]').length, 0);
});

test('the bar sits under Booli\'s Sökfilter row and copies its buttons\' look', () => {
  const head = `<div id="head"><div id="search"></div><div id="row"><button style="height:56px;border:1px solid rgb(10, 20, 30);border-radius:6px;font-size:18px">Sökfilter</button>
    <button style="background-color:rgb(27, 27, 27);color:rgb(255, 255, 255)">Spara sökning</button></div><p>Villor till salu</p></div>`;
  const { w } = load({ url: 'https://www.booli.se/sok/till-salu', body: head + pageHtml, store: STORE });
  const doc = w.document, bar = doc.querySelector('[data-bcs-filter]');
  assert.equal(bar.previousElementSibling.id, 'row');
  const sel = bar.querySelector('select');
  assert.equal(sel.style.height, '56px');
  assert.equal(sel.style.borderRadius, '6px');
  assert.equal(sel.style.fontSize, '18px');
  bar.querySelector('[data-f="sort"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(bar.querySelector('[data-f="sort"]').style.backgroundColor, 'rgb(27, 27, 27)'); // "on" looks like Spara sökning
});

test('two resmål with tables: one estimate each, and the filter uses the longest', () => {
  const store = {
    'table:index': INDEX(TABLE, LINDHOLMEN), 'table:gbg-c': { t: Date.now(), data: TABLE }, 'table:lindholmen': { t: Date.now(), data: LINDHOLMEN },
    config: {
      destinations: [{ name: 'Göteborg Centralstation', id: '740000002', lat: 57.708895, lon: 11.973479 }, { name: 'Göteborg Lindholmen', id: '2', lat: 57.70814, lon: 11.938088 }],
      list: { dest: 'mine', max: 40, over: 'hide', sort: false },
    },
  };
  const { w, api, requests } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  const doc = w.document, c = api.cfg();
  const [tc, tl] = [api.indexTable(TABLE), api.indexTable(LINDHOLMEN)];
  for (const l of listings) {
    const [a, b] = [api.estimate(l, c, tc), api.estimate(l, c, tl)];
    assert.equal(est(doc, l.id).textContent.trim(), a ? `ca ${a.mins} min till Göteborg C` : 'pendling okänd till Göteborg C');
    assert.equal(est(doc, l.id, 'lindholmen').textContent.trim(), b ? `ca ${b.mins} min till Lindholmen` : 'pendling okänd till Lindholmen');
    const over = a && b && Math.max(a.mins, b.mins) > 40;
    assert.equal(item(doc, l.id).style.display === 'none', !!over, `listing ${l.id}`);
  }
  assert.equal(doc.querySelector('[data-f="dest"]').value, 'mine');
  assert.equal(doc.querySelector('[data-f="dest"]').selectedOptions[0].textContent, 'Mina resmål (Göteborg C, Lindholmen)');
  assert.deepEqual(requests, []);
});

test('the table is fetched on first use when nothing is stored', async () => {
  const { requests, close } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml });
  assert.ok(requests.includes('https://raw.githubusercontent.com/Aggsel/booli-pendling/main/data/travel-times-gbg-c.json'));
  close();
});

test('the listing page without a key asks for it and makes no calls', async () => {
  const { w, requests, close } = load({ url: 'https://www.booli.se/annons/123456', body: '<h1>Gatan 1</h1>' });
  await sleep(900); // the URL watcher runs every 800 ms
  const host = w.document.getElementById('booli-commute-score');
  assert.match(host.shadowRoot.innerHTML, /Lägg till en gratis API-nyckel/);
  assert.deepEqual(requests, []);
  close();
});
