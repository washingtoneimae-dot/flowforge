/** Minimal 5-field cron matcher (minute hour dom month dow) for the cron trigger.
 *  Supports *, *\/step, ranges, lists, and month/dow names. No dependencies.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOWS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parsePart(part: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>();
  const word = (t: string): number => {
    const l = t.toLowerCase();
    if (names && l in names) return names[l];
    const n = Number(t);
    if (!Number.isInteger(n)) throw new Error(`bad cron field "${part}"`);
    return n;
  };
  for (const seg of part.split(',')) {
    const m = seg.match(/^(.*?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${part}"`);
    const range = m[1];
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '' || range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = word(a); hi = word(b);
      if (lo > hi) throw new Error(`bad cron range in "${part}"`);
    } else { lo = word(range); hi = word(range); }
    if (lo < min || hi > max) throw new Error(`cron value out of range in "${part}" (want ${min}–${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty cron field "${part}"`);
  return out;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour dom month dow), got ${parts.length}`);
  const [mi, h, dom, mon, dow] = parts;
  return {
    minutes: parsePart(mi, 0, 59),
    hours: parsePart(h, 0, 23),
    dom: parsePart(dom, 1, 31),
    months: parsePart(mon, 1, 12, MONTHS),
    dows: parsePart(dow, 0, 7, DOWS),
    domStar: dom === '*',
    dowStar: dow === '*',
  };
}

/** Standard cron day semantics: when both dom and dow are restricted, either may match. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  const min = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  // Normalize Sunday 7 → 0 for matching.
  const dow = date.getDay();
  if (!fields.minutes.has(min)) return false;
  if (!fields.hours.has(hour)) return false;
  if (!fields.months.has(month)) return false;
  const domOk = fields.dom.has(day);
  const dowOk = fields.dows.has(dow) || (dow === 0 && fields.dows.has(7));
  const dayOk = fields.domStar && fields.dowStar
    ? true
    : fields.domStar ? dowOk
    : fields.dowStar ? domOk
    : domOk || dowOk;
  return dayOk;
}

/** True when expr is valid and matches `now`. Invalid expressions never fire. */
export function cronMatchesNow(expr: string, now: Date): boolean {
  try {
    return cronMatches(parseCron(expr), now);
  } catch {
    return false;
  }
}

/** Minute key for fire-once guards: `cron:2026-05-04T09:30`. */
export function cronMinuteKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `cron:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Decide whether a cron-scheduled workflow fires now (and hasn't fired this minute). */
export function shouldFireCron(expr: string, lastFireKey: string | undefined, now: Date): boolean {
  if (!expr.trim()) return false;
  const key = cronMinuteKey(now);
  if (lastFireKey === key) return false;
  return cronMatchesNow(expr, now);
}
