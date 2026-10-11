import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// GTFS files are plain CSV. Fields only need the quote handling when a line has quotes in it.
export function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export const hasFile = (dir, name) => existsSync(join(dir, name));

// Streams a GTFS file row by row. fn(cols, col) gets the split row and a name → index map.
export async function eachRow(dir, name, fn) {
  const rl = createInterface({ input: createReadStream(join(dir, name), 'utf8'), crlfDelay: Infinity });
  let col = null;
  for await (const raw of rl) {
    if (!raw) continue;
    if (!col) {
      col = Object.fromEntries(splitCsv(raw.replace(/^﻿/, '')).map((h, i) => [h.trim(), i]));
      continue;
    }
    fn(splitCsv(raw), col);
  }
}

// "25:10:00" → 90600. GTFS times may pass 24:00 for trips running after midnight.
export function secs(t) {
  if (!t) return -1;
  const a = t.trim().split(':');
  return a.length < 2 ? -1 : +a[0] * 3600 + +a[1] * 60 + +(a[2] || 0);
}
