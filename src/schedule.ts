import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { ACTIVE_STATUSES, WEEKDAYS, type TemplateItem } from './model.js';
import { type Block, getTemplate, insertBlock, listBlocks, replaceTemplate, type WeekTemplate } from './store.js';
import { addDays, atLondon, formatLondon, isoWeekday, londonDate, MIN } from './time.js';

export const MATERIALIZE_DAYS = 14;

export interface AlarmSpec {
  /** Deterministic UUID: changes whenever the block's time, offset or label changes. */
  id: string;
  key: string;
  block_id: string;
  offset_min: number;
  fire_at: string;
  fire_local: string;
  label: string;
  category: string;
  /** 'alarm' = AlarmKit full-screen; 'notification' = ordinary notification that obeys Silent. */
  alert: 'alarm' | 'notification';
  /** True when a quiet block (lecture, meeting) turned this alarm into a notification. */
  quieted: boolean;
}

/** Hash a string into an RFC-4122-shaped UUID (v5-style bits) so the phone can use it as an AlarmKit id. */
export function stableUuid(input: string): string {
  const h = createHash('sha256').update(input).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function alarmLabel(block: Pick<Block, 'alarm_label'>, offset: number): string {
  if (offset < 0) return `${block.alarm_label} · in ${-offset} min`;
  if (offset > 0) return `${block.alarm_label} · ${offset} min ago`;
  return block.alarm_label;
}

/** Every future alarm for active blocks, fire_at in (now, until]. */
export function computeAlarms(blocks: Block[], now: Date, until: Date): AlarmSpec[] {
  const out: AlarmSpec[] = [];
  const quietWindows = blocks
    .filter((b) => b.quiet && b.status !== 'skipped')
    .map((b) => [new Date(b.start_at).getTime(), new Date(b.end_at).getTime()] as const);
  const inQuiet = (t: number) => quietWindows.some(([s, e]) => t >= s && t < e);
  for (const b of blocks) {
    if (!(ACTIVE_STATUSES as readonly string[]).includes(b.status)) continue;
    if (b.alert === 'none') continue;
    const start = new Date(b.start_at).getTime();
    for (const off of new Set(b.alarm_offsets_min)) {
      const fire = new Date(start + off * MIN);
      if (fire <= now || fire > until) continue;
      const label = alarmLabel(b, off);
      const key = `${b.id}:${off}`;
      const quieted = b.alert === 'alarm' && inQuiet(fire.getTime());
      const alert = b.alert === 'alarm' && !quieted ? 'alarm' : 'notification';
      out.push({
        id: stableUuid(`${key}|${fire.toISOString()}|${label}|${alert}`),
        key,
        block_id: b.id,
        offset_min: off,
        fire_at: fire.toISOString(),
        fire_local: formatLondon(fire),
        label,
        category: b.category,
        alert,
        quieted,
      });
    }
  }
  return out.sort((a, b) => a.fire_at.localeCompare(b.fire_at) || a.id.localeCompare(b.id));
}

export function versionHash(blocks: Block[], alarms: AlarmSpec[]): string {
  const h = createHash('sha256');
  for (const b of blocks) h.update(`${b.id}:${b.version}:${b.status};`);
  for (const a of alarms) h.update(`${a.id};`);
  return h.digest('hex').slice(0, 16);
}

// ---------- week template ----------

function itemTimes(day: string, item: TemplateItem): { start: Date; end: Date } {
  const start = atLondon(day, item.start);
  let end = atLondon(day, item.end);
  if (end <= start) end = atLondon(addDays(day, 1), item.end);
  return { start, end };
}

/**
 * Turn the week template into concrete blocks for the next MATERIALIZE_DAYS days.
 * Each day is materialised once; after that Claude's edits to those blocks stick.
 */
export async function materialize(db: Db, now: Date, days = MATERIALIZE_DAYS): Promise<number> {
  const template = await getTemplate(db);
  const today = londonDate(now);
  let created = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i);
    const claimed = await db.query(`INSERT INTO materialized_days (day) VALUES ($1) ON CONFLICT DO NOTHING RETURNING day`, [day]);
    if (claimed.length === 0) continue;
    for (const item of template[isoWeekday(day)] ?? []) {
      const { start, end } = itemTimes(day, item);
      if (start <= now) continue;
      await insertBlock(db, now, {
        title: item.title,
        category: item.category,
        start_at: start,
        end_at: end,
        alarm_offsets_min: item.alarm_offsets_min ?? [-10, 0],
        alarm_label: item.alarm_label,
        required_place: item.required_place ?? null,
        alert: item.alert,
        quiet: item.quiet,
        source: 'template',
      });
      created++;
    }
  }
  // Keep the bookkeeping table small.
  await db.query(`DELETE FROM materialized_days WHERE day < $1`, [addDays(today, -7)]);
  return created;
}

export type TemplateInput = Partial<Record<(typeof WEEKDAYS)[number], TemplateItem[]>>;

/** Replace the whole default week, and regenerate future template blocks from it. */
export async function setWeekTemplate(db: Db, now: Date, days: TemplateInput): Promise<{ created: number; removed: number }> {
  const t: WeekTemplate = {};
  WEEKDAYS.forEach((name, i) => {
    if (days[name]?.length) t[i + 1] = days[name]!;
  });
  await replaceTemplate(db, t);
  const removed = await db.query(
    `DELETE FROM blocks WHERE source = 'template' AND status = 'planned' AND start_at > $1::timestamptz RETURNING id`,
    [now.toISOString()],
  );
  await db.query(`DELETE FROM materialized_days WHERE day >= $1`, [londonDate(now)]);
  const created = await materialize(db, now);
  return { created, removed: removed.length };
}

export async function getWeekTemplate(db: Db): Promise<TemplateInput> {
  const t = await getTemplate(db);
  const out: TemplateInput = {};
  WEEKDAYS.forEach((name, i) => (out[name] = t[i + 1] ?? []));
  return out;
}

export async function scheduleSnapshot(db: Db, now: Date, from: Date, to: Date) {
  // Look 12h past `to` so pre-alarms (negative offsets) for blocks just after the window are included.
  const all = await listBlocks(db, from, new Date(to.getTime() + 12 * 60 * MIN));
  const blocks = all.filter((b) => new Date(b.start_at) < to);
  const alarms = computeAlarms(all, now, to);
  return { version: versionHash(blocks, alarms), generated_at: now.toISOString(), from: from.toISOString(), to: to.toISOString(), blocks, alarms };
}
