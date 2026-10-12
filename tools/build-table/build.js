#!/usr/bin/env node
// Weekly job: download the GTFS feed, compute a travel-time table per destination, write data/travel-times-<key>.json.
// Env: GTFS_KEY (required unless --feed-dir is given), RESROBOT_KEY (optional, for the spot check).
// Usage: node build.js [--feed-dir <unzipped feed>] [--today YYYY-MM-DD] [--out <dir>]
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { buildTables } from './src/table.js';
import { spotCheck } from './src/spotcheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const outDir = args.out || join(here, '..', '..', 'data');
const log = (...m) => console.log(...m);

const FEEDS = {
  vt: { url: 'https://opendata.samtrafiken.se/gtfs/vt/vt.zip', source: 'Trafiklab GTFS Regional (vt)' },
  sweden: { url: 'https://api.resrobot.se/gtfs/sweden.zip', source: 'Trafiklab GTFS Sverige 2' },
};

async function download(feed, key, dir) {
  const file = join(dir, 'feed.zip');
  log(`Hämtar ${feed.url}`); // never log the key
  let res;
  try {
    res = await fetch(`${feed.url}?key=${encodeURIComponent(key)}`, { headers: { 'Accept-Encoding': 'gzip' } });
  } catch {
    throw new Error('Kunde inte hämta tidtabellen: nätverksfel'); // the original error may contain the URL with the key
  }
  if (!res.ok || !res.body) throw new Error(`Kunde inte hämta tidtabellen: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const out = join(dir, 'feed');
  execFileSync('unzip', ['-q', '-o', file, '-d', out], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

// Same content apart from the generation time: no need to commit.
const sameContent = (a, b) => JSON.stringify({ ...a, generated: '' }) === JSON.stringify({ ...b, generated: '' });
function writeIfChanged(file, data, what = '') {
  const text = JSON.stringify(data);
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (old && sameContent(old, data)) log(`${file}: oförändrad`);
  else { writeFileSync(file, text + '\n'); log(`${file}: ${(text.length / 1024).toFixed(0)} kB${what ? `, ${what}` : ''}`); }
  return text;
}

async function main() {
  const started = Date.now();
  const feed = FEEDS[config.includeSweden ? 'sweden' : config.feed];
  if (!feed) throw new Error(`Okänt flöde: ${config.feed}`);
  let dir = args['feed-dir'], tmp = null;
  if (!dir) {
    const key = process.env.GTFS_KEY;
    if (!key) throw new Error('GTFS_KEY saknas');
    tmp = mkdtempSync(join(tmpdir(), 'gtfs-'));
    dir = await download(feed, key, tmp);
  }
  try {
    const today = args.today || new Date().toISOString().slice(0, 10);
    const tables = await buildTables(dir, config, { today, source: feed.source, log });
    mkdirSync(outDir, { recursive: true });
    // The index tells the userscript which destinations have a table.
    const index = { version: 1, tables: tables.map(({ table: t }) => t.destination) };
    writeIfChanged(join(outDir, 'tables.json'), index);
    for (const [n, { key, table }] of tables.entries()) {
      const text = writeIfChanged(join(outDir, `travel-times-${key}.json`), table, `${table.stops.length} hållplatser`);
      if (text.length > 300 * 1024) log(`Varning: ${key} är större än 300 kB`);
      // Only the first destination is compared, to keep ResRobot calls down (about 21 per run).
      if (n === 0 && process.env.RESROBOT_KEY && config.spotCheck) await spotCheck(table, config.spotCheck, process.env.RESROBOT_KEY, log);
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  log(`Klart på ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(`Fel: ${e.message}`);
  process.exit(1);
});
