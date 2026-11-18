import type { Db } from './db.js';
import { CATEGORIES } from './model.js';
import { distractionMinutes } from './rules.js';
import { lastEvent, listBlocks, listEvents, listNotes } from './store.js';
import { addDays, formatLondon, londonDate, MIN, startOfDay } from './time.js';

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export async function summary(db: Db, now: Date, from: Date, to: Date) {
  const blocks = (await listBlocks(db, from, to)).filter((b) => b.source !== 'rule');
  const events = await listEvents(db, { since: from, until: to, limit: 2000 });

  const byCategory: Record<string, { planned_h: number; done_h: number; blocks: number; done: number; missed: number; skipped: number }> = {};
  for (const c of CATEGORIES) byCategory[c] = { planned_h: 0, done_h: 0, blocks: 0, done: 0, missed: 0, skipped: 0 };
  for (const b of blocks) {
    const dur = new Date(b.end_at).getTime() - new Date(b.start_at).getTime();
    const s = byCategory[b.category];
    s.blocks++;
    s.planned_h += dur;
    if (b.status === 'done') {
      s.done++;
      s.done_h += dur;
    }
    if (b.status === 'missed') s.missed++;
    if (b.status === 'skipped') s.skipped++;
  }
  for (const s of Object.values(byCategory)) {
    s.planned_h = hours(s.planned_h);
    s.done_h = hours(s.done_h);
  }

  const visits: Record<string, number> = {};
  for (const e of events) if (e.type === 'place_enter') visits[String(e.payload?.place)] = (visits[String(e.payload?.place)] ?? 0) + 1;

  const appMinutes: Record<string, number> = {};
  for (const app of new Set(events.filter((e) => e.type === 'app_open').map((e) => String(e.payload?.app ?? 'unknown')))) {
    appMinutes[app] = distractionMinutes(
      events.filter((e) => String(e.payload?.app ?? 'unknown') === app),
      to < now ? to : now,
    );
  }

  const checkins = events.filter((e) => e.type === 'checkin');
  const stepsByDay: Record<string, number> = {};
  for (const e of events.filter((e) => e.type === 'steps')) {
    const d = londonDate(new Date(e.ts));
    stepsByDay[d] = Math.max(stepsByDay[d] ?? 0, Number(e.payload?.count ?? 0) || 0);
  }
  return {
    from_local: formatLondon(from),
    to_local: formatLondon(to),
    by_category: byCategory,
    gym_sessions: byCategory.gym.done,
    missed_blocks: blocks.filter((b) => b.status === 'missed').map((b) => ({ id: b.id, title: b.title, start_local: b.start_local })),
    skipped_blocks: blocks.filter((b) => b.status === 'skipped').map((b) => ({ id: b.id, title: b.title, start_local: b.start_local })),
    distraction_minutes_total: distractionMinutes(events, to < now ? to : now),
    distraction_minutes_by_app: appMinutes,
    place_visits: visits,
    steps_by_day: stepsByDay,
    checkins: {
      total: checkins.length,
      on_it: checkins.filter((c) => c.payload?.action === 'on_it').length,
      snooze: checkins.filter((c) => c.payload?.action === 'snooze').length,
      skip: checkins.filter((c) => c.payload?.action === 'skip').length,
    },
    rule_alarms: (await listBlocks(db, from, to)).filter((b) => b.source === 'rule').length,
  };
}

/** Today's plan vs reality: used by GET /api/status and the get_today MCP tool. */
export async function today(db: Db, now: Date) {
  const day = londonDate(now);
  const from = startOfDay(day);
  const to = startOfDay(addDays(day, 1));
  const blocks = await listBlocks(db, from, to);
  const real = blocks.filter((b) => b.source !== 'rule');
  const current = real.find((b) => new Date(b.start_at) <= now && new Date(b.end_at) > now) ?? null;
  const next = real.find((b) => new Date(b.start_at) > now) ?? null;
  const events = await listEvents(db, { since: from, until: to, types: ['app_open', 'app_close'] });
  const lastSync = await lastEvent(db, 'sync');
  const stepEvents = await listEvents(db, { since: from, until: to, types: ['steps'] });
  const counts: Record<string, number> = {};
  for (const b of real) counts[b.status] = (counts[b.status] ?? 0) + 1;
  return {
    date: day,
    now_local: formatLondon(now),
    current_block: current,
    next_block: next,
    blocks,
    counts,
    distraction_minutes_today: distractionMinutes(events, now),
    steps_today: stepEvents.length ? Math.max(...stepEvents.map((e) => Number(e.payload?.count ?? 0) || 0)) : null,
    last_phone_sync: lastSync ? { ts_local: lastSync.ts_local, minutes_ago: Math.round((now.getTime() - new Date(lastSync.ts).getTime()) / MIN) } : null,
    notes_today: await listNotes(db, from),
  };
}
