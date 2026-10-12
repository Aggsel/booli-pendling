#!/usr/bin/env node
// Monthly job: driving times from a grid around Göteborg to each destination, from a local OSRM server.
// Usage: node car.js --bbox            prints the area OSRM needs roads for
//        node car.js [--osrm <url>] [--out <dir>]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carBbox, carMinutes, carTable, NO_ROAD } from './src/car.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const car = config.car;
const outDir = args.out || join(here, '..', '..', 'data');
const osrm = args.osrm || 'http://localhost:5000';
const log = (...m) => console.log(...m);

if ('bbox' in args) {
  console.log(carBbox(car));
  process.exit(0);
}

const sameContent = (a, b) => JSON.stringify({ ...a, generated: '' }) === JSON.stringify({ ...b, generated: '' });

async function main() {
  const started = Date.now();
  mkdirSync(outDir, { recursive: true });
  const built = {};
  for (const d of config.destinations) {
    const dest = { lat: d.lat, lon: d.lon };
    const res = await carMinutes(osrm, car, dest);
    const roads = res.minutes.filter((v) => v !== NO_ROAD).length;
    if (roads < res.points * 0.5) throw new Error(`${d.name}: bara ${roads} av ${res.points} punkter nådde en väg`);
    const table = carTable(dest, d, res, car);
    const file = join(outDir, `car-times-${d.key}.json`);
    const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const keep = old && sameContent(old, table) ? old : table;
    if (keep === table) writeFileSync(file, JSON.stringify(table) + '\n');
    built[d.key] = keep.generated;
    const mins = [...res.minutes].filter((v) => v !== NO_ROAD).sort((a, b) => a - b);
    log(`${d.name}: ${roads} punkter med väg, median ${mins[mins.length >> 1]} min, ${keep === table ? `${(JSON.stringify(table).length / 1024).toFixed(0)} kB` : 'oförändrad'}`);
  }
  // Tell the userscript which destinations have driving times, in the index the transit job writes.
  const indexFile = join(outDir, 'tables.json');
  if (existsSync(indexFile)) {
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    for (const t of index.tables) if (built[t.key]) t.carGenerated = built[t.key];
    writeFileSync(indexFile, JSON.stringify(index) + '\n');
  }
  log(`Klart på ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(`Fel: ${e.message}`);
  process.exit(1);
});
