// Connection Scan over typed arrays.
// A connection set is { n, dep, arr, from, to, trip, mode } (Int32Array / Uint8Array, length n).
// foot[s] = [[neighbour, seconds], ...], changeTime[s] = minimum seconds to change vehicle at s.

const NEG = -2147483648;
export const MODE_BITS = { t: 1, s: 2, b: 4, f: 8 };
export const modeLetters = (bits) => Object.entries(MODE_BITS).filter(([, b]) => bits & b).map(([k]) => k).join('');

// Order of a connection set: by arrival, latest first. Within one trip, later stops first (zero-length hops).
export function byArrivalDesc(cs, seq) {
  const idx = Array.from({ length: cs.n }, (_, i) => i);
  idx.sort((a, b) => cs.arr[b] - cs.arr[a] || cs.trip[a] - cs.trip[b] || seq[b] - seq[a]);
  return Int32Array.from(idx);
}
export function byDepartureAsc(cs, seq) {
  const idx = Array.from({ length: cs.n }, (_, i) => i);
  idx.sort((a, b) => cs.dep[a] - cs.dep[b] || cs.trip[a] - cs.trip[b] || seq[a] - seq[b]);
  return Int32Array.from(idx);
}

// Reverse scan: for every stop, the latest time you can board there and still reach a destination stop by `target`.
// Returns { latest, chg, modes } per stop. modes = 0 means the stop only reaches the destination on foot.
export function latestDepartures({ nStops, nTrips, cs, order, target, destStops, foot, changeTime, maxSecs }) {
  const latest = new Int32Array(nStops).fill(NEG);
  const chg = new Int16Array(nStops);
  const modes = new Uint8Array(nStops);
  const isDest = new Uint8Array(nStops);
  const tripChg = new Int16Array(nTrips).fill(-1);
  const tripModes = new Uint8Array(nTrips);
  const floor = target - maxSecs;

  const set = (s, t, c, m) => {
    if (t > latest[s] || (t === latest[s] && m && (!modes[s] || c < chg[s]))) {
      latest[s] = t; chg[s] = c; modes[s] = m;
      return true;
    }
    return false;
  };
  for (const d of destStops) { isDest[d] = 1; latest[d] = target; }
  for (const d of destStops) for (const [nb, w] of foot[d] || []) if (!isDest[nb]) set(nb, target - w, 0, 0);

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const a = cs.arr[i];
    if (a > target || cs.dep[i] < floor) continue;
    const t = cs.trip[i], s = cs.to[i];
    let best = -1, bm = 0;
    if (tripChg[t] >= 0) { best = tripChg[t]; bm = tripModes[t]; }
    if (isDest[s]) { best = 0; bm = 0; }
    else if (latest[s] !== NEG) {
      const walkOnly = !modes[s];
      if (a + (walkOnly ? 0 : changeTime[s]) <= latest[s]) {
        const c = walkOnly ? 0 : chg[s] + 1;
        if (best < 0 || c < best) { best = c; bm = modes[s]; }
      }
    }
    if (best < 0) continue;
    bm |= cs.mode[i];
    tripChg[t] = best; tripModes[t] = bm;
    const f = cs.from[i], dp = cs.dep[i];
    if (set(f, dp, best, bm)) for (const [nb, w] of foot[f] || []) set(nb, dp - w, best, bm);
  }
  return { latest, chg, modes };
}

// Forward scans from the destination, one per evening departure time, latest first.
// last[s] = the latest departure from the destination (from `from`, before `until`) that still reaches s
// within `maxTrip` seconds and by `arriveBy` (so waiting for the next morning's first trips doesn't count), or -1.
export function lastDepartures({ nStops, nTrips, cs, order, destStops, foot, changeTime, from, until, maxTrip, arriveBy = Infinity }) {
  const origin = new Uint8Array(nStops);
  for (const d of destStops) { origin[d] = 1; for (const [nb] of foot[d] || []) origin[nb] = 1; }
  const dep = new Int32Array(order.length);
  for (let k = 0; k < order.length; k++) dep[k] = cs.dep[order[k]];

  const taus = new Set();
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (origin[cs.from[i]] && dep[k] >= from && dep[k] < until) taus.add(dep[k]);
  }
  const last = new Int32Array(nStops).fill(-1);
  const ready = new Int32Array(nStops), readyRun = new Int32Array(nStops);
  const tripRun = new Int32Array(nTrips);
  const originStops = [...origin.keys()].filter((s) => origin[s]);
  let run = 0;

  for (const tau of [...taus].sort((a, b) => b - a)) {
    run++;
    for (const s of originStops) { ready[s] = tau; readyRun[s] = run; }
    const end = Math.min(tau + maxTrip, arriveBy);
    let lo = 0, hi = dep.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dep[mid] < tau) lo = mid + 1; else hi = mid; }
    for (let k = lo; k < order.length && dep[k] <= end; k++) {
      const i = order[k];
      if (cs.arr[i] > end) continue;
      const t = cs.trip[i], f = cs.from[i];
      if (tripRun[t] !== run) {
        if (readyRun[f] !== run || ready[f] > dep[k]) continue;
        tripRun[t] = run;
      }
      const s = cs.to[i], a = cs.arr[i];
      if (last[s] < 0 && !origin[s]) last[s] = tau;
      const rc = a + changeTime[s];
      if (readyRun[s] !== run || rc < ready[s]) { ready[s] = rc; readyRun[s] = run; }
      for (const [nb, w] of foot[s] || []) {
        const rn = a + Math.max(w, changeTime[nb]);
        if (readyRun[nb] !== run || rn < ready[nb]) { ready[nb] = rn; readyRun[nb] = run; }
      }
    }
  }
  return last;
}
