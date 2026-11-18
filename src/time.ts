// All storage is UTC. Everything human-facing is Europe/London.
export const TZ = 'Europe/London';

const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface LondonParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

export function londonParts(date: Date): LondonParts {
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
}

/** Offset of London from UTC at the given instant, in ms (0 in winter, 3_600_000 in BST). */
function offsetMs(utcMs: number): number {
  const p = londonParts(new Date(utcMs));
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a London wall-clock time to a UTC instant. */
export function londonToUtc(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  const off1 = offsetMs(guess);
  let t = guess - off1;
  const off2 = offsetMs(t);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a user/Claude supplied time. Strings with an explicit offset ("Z", "+01:00")
 * are absolute; strings without are read as Europe/London wall-clock time.
 */
export function parseTime(input: string): Date {
  const s = input.trim();
  if (HAS_ZONE_RE.test(s) && s.includes('T')) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid time: ${input}`);
    return d;
  }
  const m = LOCAL_RE.exec(s);
  if (!m) throw new Error(`Invalid time "${input}". Use ISO 8601, e.g. 2026-11-19T09:00 (London time).`);
  return londonToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of the London calendar day containing `date`. */
export function londonDate(date: Date): string {
  const p = londonParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "YYYY-MM-DD HH:mm" in London time, for humans and Claude. */
export function formatLondon(date: Date): string {
  const p = londonParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO weekday, Monday = 1 … Sunday = 7. */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return ((js + 6) % 7) + 1;
}

/** UTC instant of London midnight starting `day`. */
export function startOfDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return londonToUtc(y, m, d);
}

/** Combine a London day and "HH:MM" into a UTC instant. */
export function atLondon(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return londonToUtc(y, m, d, h, min);
}

export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

export const MIN = 60_000;
