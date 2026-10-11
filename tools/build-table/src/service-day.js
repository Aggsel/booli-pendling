// Dates are handled as "YYYY-MM-DD" strings and UTC dates, so the runner's time zone doesn't matter.
const DAY = 86400000;
export const toDate = (s) => new Date(`${s}T00:00:00Z`);
export const ymd = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => ymd(new Date(toDate(s).getTime() + n * DAY));
const gtfsDate = (s) => s.replace(/-/g, '');

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// The first date from `from` (inclusive) that falls on weekday `wd` (0 = Sunday).
function weekdayFrom(from, wd) {
  let s = from;
  while (toDate(s).getUTCDay() !== wd) s = addDays(s, 1);
  return s;
}

// Swedish public holidays, plus the eves that run a holiday timetable.
export function swedishHolidays(y) {
  const e = easter(y);
  return new Set([
    `${y}-01-01`, `${y}-01-06`, addDays(e, -2), e, addDays(e, 1), `${y}-05-01`, addDays(e, 39),
    `${y}-06-06`, weekdayFrom(`${y}-06-19`, 5), weekdayFrom(`${y}-06-20`, 6), weekdayFrom(`${y}-10-31`, 6),
    `${y}-12-24`, `${y}-12-25`, `${y}-12-26`, `${y}-12-31`,
  ]);
}

// A Tuesday is a normal commuting day unless it, or the day on either side, is a holiday,
// or it falls in the Christmas and New Year break.
export function isNormalTuesday(s) {
  const hol = (x) => swedishHolidays(+x.slice(0, 4)).has(x);
  if (hol(s) || hol(addDays(s, -1)) || hol(addDays(s, 1))) return false;
  const md = s.slice(5);
  return !(md >= '12-20' || md <= '01-07');
}

// Next suitable Tuesday at least 7 days after `today`.
export function candidateTuesdays(today, count = 10) {
  const out = [];
  let s = weekdayFrom(addDays(today, 7), 2);
  while (out.length < count) {
    if (isNormalTuesday(s)) out.push(s);
    s = addDays(s, 7);
  }
  return out;
}

// calendar = Map(service_id → { days: [mon..sun], start, end }), dates = Map(service_id → Map(date → 1 added | 2 removed))
export function activeServices(calendar, dates, s) {
  const gd = gtfsDate(s);
  const wd = (toDate(s).getUTCDay() + 6) % 7; // Monday = 0
  const out = new Set();
  for (const [id, c] of calendar) if (c.days[wd] && c.start <= gd && gd <= c.end) out.add(id);
  for (const [id, m] of dates) {
    const t = m.get(gd);
    if (t === 1) out.add(id);
    else if (t === 2) out.delete(id);
  }
  return out;
}
