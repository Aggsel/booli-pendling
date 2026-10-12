// Driving times to each destination from a grid of points, from a local OSRM server (the job starts one).
// OSRM gives free-flowing traffic (no queues); times get a few minutes for parking. A flat rush-hour factor was
// dropped: it penalised long motorway trips the most, while real queues sit at a few bottlenecks.
const KM_LAT = 111.2;
export const NO_ROAD = 255;

// The grid of points: fixed spacing, a square around the centre; points further than the radius are left out.
export function carGrid({ center: [lat, lon], radiusKm, spacingM }) {
  const kmLon = KM_LAT * Math.cos((lat * Math.PI) / 180);
  const dLat = spacingM / 1000 / KM_LAT, dLon = spacingM / 1000 / kmLon;
  const n = Math.ceil((radiusKm * 1000) / spacingM);
  const r5 = (v) => Math.round(v * 1e6) / 1e6;
  return { lat0: r5(lat - n * dLat), lon0: r5(lon - n * dLon), dLat: r5(dLat), dLon: r5(dLon), rows: 2 * n + 1, cols: 2 * n + 1, kmLon, radiusKm, center: [lat, lon] };
}

// The area OSRM needs roads for: the grid plus a margin, as minLon,minLat,maxLon,maxLat.
export function carBbox(car) {
  const g = carGrid(car);
  const mLat = car.marginKm / KM_LAT, mLon = car.marginKm / g.kmLon;
  const f = (v) => v.toFixed(4);
  return [f(g.lon0 - mLon), f(g.lat0 - mLat), f(g.lon0 + (g.cols - 1) * g.dLon + mLon), f(g.lat0 + (g.rows - 1) * g.dLat + mLat)].join(',');
}

// Minutes from every grid point to one destination, as a Uint8Array row by row (south first).
export async function carMinutes(osrm, car, dest, { batch = 250, fetchFn = fetch } = {}) {
  const g = carGrid(car);
  const out = new Uint8Array(g.rows * g.cols).fill(NO_ROAD);
  const points = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const lat = g.lat0 + r * g.dLat, lon = g.lon0 + c * g.dLon;
    const dy = (lat - g.center[0]) * KM_LAT, dx = (lon - g.center[1]) * g.kmLon;
    if (Math.sqrt(dx * dx + dy * dy) <= g.radiusKm) points.push({ k: r * g.cols + c, lat, lon });
  }
  for (let i = 0; i < points.length; i += batch) {
    const part = points.slice(i, i + batch);
    const coords = [dest, ...part].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const sources = part.map((_, n) => n + 1).join(';');
    const res = await fetchFn(`${osrm}/table/v1/driving/${coords}?sources=${sources}&destinations=0&annotations=duration`);
    if (!res.ok) throw new Error(`OSRM svarade ${res.status}`);
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(`OSRM: ${body.code} ${body.message || ''}`);
    part.forEach((p, n) => {
      const secs = body.durations[n][0];
      const snap = body.sources[n].distance; // metres from the point to the nearest road
      if (secs == null || snap > car.maxSnapM) return; // the sea, a forest, no road nearby
      // Driving, then the walk from the point to the road and a few minutes to park.
      const mins = secs / 60 + ((snap / 1000) / 5) * 60 + car.parkMinutes;
      out[p.k] = Math.min(NO_ROAD - 1, Math.round(mins));
    });
  }
  return { grid: g, minutes: out, points: points.length };
}

export function carTable(dest, d, { grid: g, minutes }, car) {
  return {
    version: 1,
    destination: { key: d.key, name: d.name, label: d.label || d.name, lat: dest.lat, lon: dest.lon },
    generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    source: 'OpenStreetMap (OSRM)',
    parkMinutes: car.parkMinutes,
    grid: { lat0: g.lat0, lon0: g.lon0, dLat: g.dLat, dLon: g.dLon, rows: g.rows, cols: g.cols },
    minutes: Buffer.from(minutes).toString('base64'), // one byte per point, row by row from the south; 255 = no road
  };
}
