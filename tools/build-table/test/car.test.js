import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carGrid, carBbox, carMinutes, carTable, NO_ROAD } from '../src/car.js';

const car = { center: [57.7089, 11.9735], radiusKm: 5, spacingM: 1000, marginKm: 2, rushFactor: 1.3, parkMinutes: 3, maxSnapM: 800 };
const dest = { lat: 57.7089, lon: 11.9735 };

// A stand-in for OSRM's table service: 1 min per km in free flow; west of 11.93 is sea (nearest road 2 km away).
function fakeOsrm(calls) {
  return async (url) => {
    calls.push(url);
    const coords = url.split('/driving/')[1].split('?')[0].split(';').map((p) => p.split(',').map(Number));
    const [d, ...pts] = coords;
    const km = ([lon, lat]) => Math.hypot((lat - d[1]) * 111.2, (lon - d[0]) * 59.5);
    return { ok: true, json: async () => ({
      code: 'Ok',
      durations: pts.map((p) => [km(p) * 60]),
      sources: pts.map(([lon]) => ({ distance: lon < 11.93 ? 2000 : 50 })),
    }) };
  };
}

test('the car grid: a circle of points on fixed spacing, and the area OSRM needs roads for', () => {
  const g = carGrid(car);
  assert.equal(g.rows, 11);
  assert.equal(g.cols, 11);
  assert.ok(Math.abs(g.lat0 + 5 * g.dLat - dest.lat) < 1e-5);
  const [w, s, e, n] = carBbox(car).split(',').map(Number);
  assert.ok(w < g.lon0 && s < g.lat0 && e > g.lon0 + 10 * g.dLon && n > g.lat0 + 10 * g.dLat);
});

test('driving minutes: rush-hour factor, parking, walk to the road, and no road at sea', async () => {
  const calls = [];
  const res = await carMinutes('http://osrm', car, dest, { batch: 20, fetchFn: fakeOsrm(calls) });
  assert.ok(calls.length > 1 && calls.every((u) => u.includes('destinations=0')));
  const g = res.grid, at = (r, c) => res.minutes[r * g.cols + c];
  assert.equal(at(5, 5), Math.round((0.05 / 5) * 60 + 3)); // the destination itself: 50 m to the road and parking
  // 3 km east: 3 min free flow × 1.3 + 50 m walk + 3 min parking
  assert.equal(at(5, 8), Math.round(3 * 1.3 + (0.05 / 5) * 60 + 3));
  assert.equal(at(5, 1), NO_ROAD); // west of 11.93: the nearest road is 2 km away
  assert.equal(at(0, 0), NO_ROAD); // a corner outside the circle is never asked
  const table = carTable(dest, { key: 'gbg-c', name: 'Göteborg Centralstation', label: 'Göteborg C' }, res, car);
  assert.equal(Buffer.from(table.minutes, 'base64').length, g.rows * g.cols);
  assert.equal(table.destination.label, 'Göteborg C');
});
