import type { Db } from './db.js';
import { ACTIVE_STATUSES } from './model.js';
import { materialize } from './schedule.js';
import {
  activeBlocksStartedBetween,
  addNote,
  type Block,
  claimFiring,
  type EventRow,
  getBlock,
  insertBlock,
  lastFiring,
  listBlocks,
  listEvents,
  listPlaces,
  listRules,
  type Rule,
  updateBlock,
} from './store.js';
import { atLondon, formatLondon, londonDate, MIN, startOfDay } from './time.js';

const isActive = (b: Block) => (ACTIVE_STATUSES as readonly string[]).includes(b.status);

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

/** Distraction app events: kind game/social, or no kind given (Shortcuts are only set up for distraction apps). */
export function isDistraction(e: EventRow, kinds: string[] = ['game', 'social']): boolean {
  const kind = e.payload?.kind;
  return kind === undefined || kind === null || kinds.includes(String(kind));
}

/**
 * Immediate state changes caused by a single event (check-ins, arriving at the right place).
 * Returns human-readable descriptions of what changed.
 */
export async function applyEvent(db: Db, now: Date, e: EventRow): Promise<string[]> {
  const changes: string[] = [];
  if (e.type === 'checkin' && e.block_id) {
    const block = await getBlock(db, e.block_id);
    if (!block) return changes;
    const action = String(e.payload?.action ?? '');
    if ((action === 'on_it' || action === 'done') && block.status !== 'done') {
      await updateBlock(db, now, block.id, { status: 'done' });
      changes.push(`"${block.title}" marked done (${action})`);
    } else if (action === 'skip' && block.status !== 'skipped') {
      await updateBlock(db, now, block.id, { status: 'skipped' });
      const reason = e.payload?.reason ? `: ${e.payload.reason}` : '';
      await addNote(db, now, 'me', `Skipped "${block.title}" (${block.start_local})${reason}`);
      changes.push(`"${block.title}" skipped`);
    }
  }
  if (e.type === 'place_enter' && e.payload?.place) {
    const place = String(e.payload.place);
    const ts = new Date(e.ts);
    // Arriving at the required place counts as attending, from 30 min before start to the end.
    const blocks = await listBlocks(db, new Date(ts.getTime() - 12 * 60 * MIN), new Date(ts.getTime() + 30 * MIN));
    for (const b of blocks) {
      if (!isActive(b) || !b.required_place || b.required_place !== place) continue;
      const start = new Date(b.start_at).getTime();
      if (ts.getTime() >= start - 30 * MIN && ts.getTime() <= new Date(b.end_at).getTime()) {
        await updateBlock(db, now, b.id, { status: 'done' });
        changes.push(`"${b.title}" marked done (arrived at ${place})`);
      }
    }
  }
  return changes;
}

/** Minutes spent in distraction apps between from and until, from app_open/app_close pairs. */
export function distractionMinutes(events: EventRow[], until: Date, kinds?: string[], exclude: (readonly [number, number])[] = []): number {
  const relevant = events
    .filter((e) => (e.type === 'app_open' || e.type === 'app_close') && isDistraction(e, kinds))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let total = 0;
  for (let i = 0; i < relevant.length; i++) {
    const e = relevant[i];
    if (e.type !== 'app_open') continue;
    const start = new Date(e.ts).getTime();
    if (exclude.some(([s, x]) => start >= s && start < x)) continue;
    let end = Math.min(start + 30 * MIN, until.getTime()); // no close seen: assume 30 min
    for (let j = i + 1; j < relevant.length; j++) {
      const n = relevant[j];
      const sameApp = n.payload?.app === e.payload?.app;
      if (n.type === 'app_close' && sameApp) {
        end = new Date(n.ts).getTime();
        break;
      }
      if (n.type === 'app_open' && !sameApp) {
        end = Math.min(end, new Date(n.ts).getTime());
        break;
      }
      if (n.type === 'app_open' && sameApp) {
        end = Math.min(end, new Date(n.ts).getTime());
        break;
      }
    }
    total += Math.max(0, Math.min(end - start, 60 * MIN));
  }
  return Math.round(total / MIN);
}

async function ruleAlarm(db: Db, now: Date, rule: Rule, label: string, note: string, blockId?: string) {
  const inMin = Number(rule.action.alarm_in_min ?? 2);
  const start = new Date(now.getTime() + inMin * MIN);
  const block = await insertBlock(db, now, {
    title: label,
    category: 'other',
    start_at: start,
    end_at: new Date(start.getTime() + 5 * MIN),
    alarm_offsets_min: [0],
    alarm_label: label.slice(0, 80),
    alert: rule.action.alert === 'notification' ? 'notification' : 'alarm',
    source: 'rule',
    notes: blockId ? `rule ${rule.name} for block ${blockId}` : `rule ${rule.name}`,
  });
  await addNote(db, now, 'system', `[${rule.name}] ${note} → alarm "${label}" at ${formatLondon(start)}`);
  return block;
}

export interface TickResult {
  materialized: number;
  actions: string[];
}

/** The rules engine. Safe to run as often as you like: every firing is recorded once. */
export async function tick(db: Db, now: Date): Promise<TickResult> {
  const actions: string[] = [];
  const materialized = await materialize(db, now);
  const rules = new Map((await listRules(db)).filter((r) => r.enabled).map((r) => [r.name, r]));
  const places = new Map((await listPlaces(db)).map((p) => [p.id, p]));

  // 1. Started, needs a place, not there after grace period.
  const late = rules.get('late_for_place');
  if (late) {
    const grace = Number(late.condition.grace_min ?? 20);
    const candidates = await activeBlocksStartedBetween(db, new Date(now.getTime() - 6 * 60 * MIN), new Date(now.getTime() - grace * MIN));
    for (const b of candidates) {
      if (!b.required_place || new Date(b.end_at) <= now) continue;
      const placeEvents = await listEvents(db, {
        since: new Date(new Date(b.start_at).getTime() - 12 * 60 * MIN),
        until: now,
        types: ['place_enter', 'place_exit'],
      });
      const atPlace = placeEvents.filter((e) => e.payload?.place === b.required_place).at(-1);
      if (atPlace?.type === 'place_enter') continue;
      if (!(await claimFiring(db, now, late.name, b.id))) continue;
      const placeName = places.get(b.required_place)?.name ?? b.required_place;
      const label = fill(String(late.action.label ?? 'LATE — GET TO {place}'), { place: placeName.toUpperCase(), title: b.title });
      await ruleAlarm(db, now, late, label, `Not at ${placeName} ${grace} min after "${b.title}" started`, b.id);
      actions.push(`late: ${b.title}`);
    }
  }

  // 2. Distraction app opened during a focus block.
  const distraction = rules.get('distraction_during_focus');
  if (distraction) {
    const cats: string[] = distraction.condition.categories ?? ['work', 'uni'];
    const kinds: string[] = distraction.condition.kinds ?? ['game', 'social'];
    const cooldown = Number(distraction.condition.cooldown_min ?? 10);
    const maxAge = Number(distraction.condition.max_age_min ?? 60);
    const opens = await listEvents(db, { since: new Date(now.getTime() - maxAge * MIN), until: new Date(now.getTime() + MIN), types: ['app_open'] });
    for (const e of opens.filter((e) => isDistraction(e, kinds))) {
      const ts = new Date(e.ts);
      const focus = (await listBlocks(db, ts, new Date(ts.getTime() + 1))).find(
        (b) => cats.includes(b.category) && b.status !== 'skipped',
      );
      if (!focus) continue;
      const last = await lastFiring(db, distraction.name, `${focus.id}:`);
      if (last && now.getTime() - last.getTime() < cooldown * MIN) {
        await claimFiring(db, now, distraction.name, `${focus.id}:${e.id}:suppressed`);
        continue;
      }
      if (!(await claimFiring(db, now, distraction.name, `${focus.id}:${e.id}`))) continue;
      const app = String(e.payload?.app ?? 'a distraction app');
      const label = fill(String(distraction.action.label ?? 'BACK TO WORK'), { title: focus.title.toUpperCase(), app });
      await ruleAlarm(db, now, distraction, label, `Opened ${app} during "${focus.title}"`, focus.id);
      actions.push(`distraction: ${app} during ${focus.title}`);
    }
  }

  // 2b. Games outside a play block (friend time) → stop.
  const solo = rules.get('solo_gaming');
  if (solo) {
    const kinds: string[] = solo.condition.kinds ?? ['game'];
    const cooldown = Number(solo.condition.cooldown_min ?? 15);
    const maxAge = Number(solo.condition.max_age_min ?? 60);
    const focusCats: string[] = distraction?.condition.categories ?? ['work', 'uni'];
    const opens = await listEvents(db, { since: new Date(now.getTime() - maxAge * MIN), until: new Date(now.getTime() + MIN), types: ['app_open'] });
    for (const e of opens.filter((e) => isDistraction(e, kinds))) {
      const ts = new Date(e.ts);
      const covering = (await listBlocks(db, ts, new Date(ts.getTime() + 1))).filter((b) => b.status !== 'skipped');
      if (covering.some((b) => b.category === 'play')) continue; // friend time: allowed
      if (distraction && covering.some((b) => focusCats.includes(b.category))) continue; // distraction rule covers it
      const day = londonDate(ts);
      const last = await lastFiring(db, solo.name, `${day}:`);
      if (last && now.getTime() - last.getTime() < cooldown * MIN) {
        await claimFiring(db, now, solo.name, `${day}:${e.id}:suppressed`);
        continue;
      }
      if (!(await claimFiring(db, now, solo.name, `${day}:${e.id}`))) continue;
      const app = String(e.payload?.app ?? 'a game');
      const label = fill(String(solo.action.label ?? 'STOP — NO SOLO GAMING'), { app });
      await ruleAlarm(db, now, solo, label, `Opened ${app} outside friend time`);
      actions.push(`solo gaming: ${app}`);
    }
  }

  // 3. No check-in after the alarm → missed.
  const missed = rules.get('no_checkin_missed');
  if (missed) {
    const after = Number(missed.condition.after_min ?? 30);
    const snoozeMin = Number(missed.condition.snooze_min ?? 15);
    const candidates = await activeBlocksStartedBetween(db, new Date(now.getTime() - 7 * 24 * 60 * MIN), new Date(now.getTime() - after * MIN));
    for (const b of candidates) {
      if (b.alarm_offsets_min.length === 0 || b.category === 'sleep' || b.source === 'rule') continue;
      const checkins = await listEvents(db, { since: new Date(0), types: ['checkin'], blockId: b.id });
      const snoozes = checkins.filter((c) => c.payload?.action === 'snooze').length;
      const deadline = new Date(b.start_at).getTime() + (after + snoozes * snoozeMin) * MIN;
      if (now.getTime() < deadline) continue;
      await updateBlock(db, now, b.id, { status: 'missed' });
      await addNote(db, now, 'system', `[no_checkin_missed] "${b.title}" (${b.start_local}) marked missed — no check-in`);
      actions.push(`missed: ${b.title}`);
    }
    // Rule-generated nags just expire quietly.
    await db.query(
      `UPDATE blocks SET status = 'done', version = version + 1, updated_at = $1::timestamptz
       WHERE source = 'rule' AND status IN ('planned','moved') AND end_at < $1::timestamptz`,
      [now.toISOString()],
    );
  }

  // 4. Daily play limit.
  const play = rules.get('play_limit');
  if (play) {
    const limit = Number(play.condition.limit_min ?? 120);
    const day = londonDate(now);
    const events = await listEvents(db, { since: startOfDay(day), until: new Date(now.getTime() + 1000), types: ['app_open', 'app_close'] });
    const exclude = play.condition.exclude_play_blocks
      ? (await listBlocks(db, startOfDay(day), now))
          .filter((b) => b.category === 'play' && b.status !== 'skipped')
          .map((b) => [new Date(b.start_at).getTime(), new Date(b.end_at).getTime()] as const)
      : [];
    const used = distractionMinutes(events, now, play.condition.kinds, exclude);
    if (used > limit && (await claimFiring(db, now, play.name, day))) {
      const label = String(play.action.label ?? 'PLAY LIMIT HIT');
      await ruleAlarm(db, now, play, label, `${used} min of games/social today (limit ${limit})`);
      actions.push(`play limit: ${used}/${limit} min`);
    }
  }

  // 5. Daily steps goal, checked in the evening from the latest 'steps' event.
  const steps = rules.get('steps_goal');
  if (steps) {
    const goal = Number(steps.condition.goal ?? 10000);
    const day = londonDate(now);
    const after = atLondon(day, String(steps.condition.after ?? '20:30'));
    if (now >= after) {
      const today = await listEvents(db, { since: startOfDay(day), until: new Date(now.getTime() + 1000), types: ['steps'] });
      const count = Math.max(0, ...today.map((e) => Number(e.payload?.count ?? 0)).filter(Number.isFinite));
      if (today.length > 0 && count < goal && (await claimFiring(db, now, steps.name, day))) {
        const short = (goal - count).toLocaleString('en-GB');
        const label = fill(String(steps.action.label ?? 'WALK — {short} STEPS TO GO'), { short });
        await ruleAlarm(db, now, steps, label, `${count} steps today (goal ${goal})`);
        actions.push(`steps: ${count}/${goal}`);
      }
    }
  }

  return { materialized, actions };
}
