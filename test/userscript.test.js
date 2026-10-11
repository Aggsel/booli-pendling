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

function load({ url = 'https://www.booli.se/', body = '', store = {} } = {}) {
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
const est = (doc, id) => doc.querySelector(`[data-bcs-est="${id}"]`);
const item = (doc, id) => est(doc, id).closest('li');

test('result list: every card shows an estimate at once, without a key and without Trafiklab calls', async () => {
  const t0 = performance.now();
  const { w, api, requests, close } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body: pageHtml, store: { [`table:gbg-c`]: { t: Date.now(), data: TABLE } } });
  const doc = w.document;
  const t = api.indexTable(TABLE), c = api.cfg();
  for (const l of listings) {
    const el = est(doc, l.id);
    assert.ok(el, `card ${l.id} has an estimate`);
    const e = api.estimate(l, c, t);
    assert.equal(el.textContent.trim(), e ? `ca ${e.mins} min till Göteborg C` : 'pendling okänd');
  }
  assert.ok(performance.now() - t0 < 1000);
  assert.deepEqual(requests, []); // no fetches at all: positions came from the page, the table from storage
  assert.ok(doc.querySelector('[data-bcs-filter]'));
  close();
});

test('filter hides or dims exactly the cards over the limit, sorting reorders them, and both survive a redraw', async () => {
  const { w, api, values, close } = load({ url: 'https://www.booli.se/sok/till-salu?areaIds=22', body: pageHtml, store: { [`table:gbg-c`]: { t: Date.now(), data: TABLE } } });
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

test('listings without a position stay visible and say "pendling okänd"', async () => {
  const body = `<main><ul id="list">${card({ id: 999001 })}${card({ id: 999002 })}</ul></main>`;
  const { w, close } = load({ url: 'https://www.booli.se/sok/till-salu', body, store: {
    'table:gbg-c': { t: Date.now(), data: TABLE },
    config: { list: { table: 'gbg-c', max: 20, over: 'hide', sort: false } },
  } });
  await sleep(50); // per-listing fetches fail in the stub
  await sleep(400);
  for (const id of [999001, 999002]) {
    assert.equal(est(w.document, id).textContent.trim(), 'pendling okänd');
    assert.notEqual(item(w.document, id).style.display, 'none');
  }
  close();
});

test('a destination without a table keeps the old button (with a key) and shows no estimates', () => {
  const store = {
    'table:gbg-c': { t: Date.now(), data: TABLE },
    config: { apiKey: 'k', destinations: [{ name: 'Lindholmen', id: '1', lat: 57.7069, lon: 11.9385 }] },
  };
  const { w, close } = load({ url: 'https://www.booli.se/sok/till-salu', body: pageHtml, store });
  assert.equal(w.document.querySelectorAll('[data-bcs-est]').length, 0);
  assert.equal(w.document.querySelectorAll('[data-bcs-btn]').length, N);
  assert.equal(w.document.querySelector('[data-bcs-filter]'), null);
  close();
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
