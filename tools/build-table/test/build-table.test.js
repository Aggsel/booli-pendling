import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTables } from '../src/table.js';
import { candidateTuesdays, isNormalTuesday, swedishHolidays } from '../src/service-day.js';
import { splitCsv, secs } from '../src/csv.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const config = {
  arriveBy: '08:00', maxMinutes: 120,
  destinations: [{ key: 'gbg-c', name: 'Göteborg Centralstation', stopNamePattern: '^Göteborg Centralstation' }],
};
const [{ table }] = await buildTables(fixture, config, { today: '2026-10-11', source: 'test' });
const row = (name) => {
  const r = table.stops.find((x) => x[6] === name);
  return r && Object.fromEntries(table.fields.map((f, i) => [f, r[i]]));
};

test('picks the next normal Tuesday at least a week ahead', () => {
  assert.equal(table.serviceDate, '2026-10-20');
  assert.deepEqual(table.destination, { key: 'gbg-c', name: 'Göteborg Centralstation', lat: 57.7089, lon: 11.9735 });
});

test('direct trip', () => {
  assert.deepEqual(row('Alfa station'), { lat: 57.65, lon: 12.01, min: 30, chg: 0, modes: 't', last: null, name: 'Alfa station' });
});

test('trip with one change keeps both modes', () => {
  const x = row('Xen');
  assert.equal(x.min, 60);
  assert.equal(x.chg, 1);
  assert.equal(x.modes, 'sb');
  assert.equal(row('Beta station').min, 40);
});

test('missed connection falls back to an earlier trip', () => {
  const m = row('Miss');
  assert.equal(m.min, 90); // 07:19 + 2 min change misses 07:20, so 06:30 → 06:45 → 06:50 → 07:10
  assert.equal(m.chg, 1);
});

test('last trip home after midnight (hours ≥ 24)', () => {
  const n = row('Nattby');
  assert.equal(n.last, '00:30');
  assert.equal(n.min, 60);
});

test('calendar_dates exceptions add and remove service', () => {
  assert.equal(row('Helgby').min, 60); // T14 (removed) would have given 20
});

test('the destination itself is not a row', () => {
  assert.equal(row('Göteborg Centralstation'), undefined);
});

test('destination found by coordinates when no name matches', async () => {
  const [{ table: t }] = await buildTables(fixture, { ...config, destinations: [{ key: 'gbg-c', name: 'Göteborg C', stopNamePattern: '^Finns inte',
    lat: 57.7089, lon: 11.9735, radius: 200 }] }, { today: '2026-10-11', source: 'test' });
  assert.equal(t.stops.find((r) => r[6] === 'Alfa station')[2], 30);
});

test('unknown destination fails loudly', async () => {
  await assert.rejects(buildTables(fixture, { ...config, destinations: [{ key: 'x', name: 'X', stopNamePattern: '^Finns inte' }] },
    { today: '2026-10-11', source: 'test' }), /Hittade ingen hållplats/);
});

test('Swedish holidays and normal Tuesdays', () => {
  assert.ok(swedishHolidays(2026).has('2026-04-03')); // Good Friday
  assert.ok(swedishHolidays(2026).has('2026-06-19')); // Midsummer Eve
  assert.equal(isNormalTuesday('2027-03-30'), false); // the day after Easter Monday
  assert.equal(isNormalTuesday('2026-12-22'), false);
  assert.equal(candidateTuesdays('2026-12-10')[0], '2027-01-12');
});

test('CSV and time parsing', () => {
  assert.deepEqual(splitCsv('a,"b, c","d ""e"""'), ['a', 'b, c', 'd "e"']);
  assert.equal(secs('25:10:00'), 90600);
});
