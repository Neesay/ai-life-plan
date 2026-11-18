import { z } from 'zod';
import { HttpError, type Ctx } from './http.js';
import { alertSchema, CATEGORIES, EVENT_TYPES, offsetsSchema, quietSchema, STATUSES, templateItem, timeString } from './model.js';
import { tick } from './rules.js';
import { getWeekTemplate, materialize, scheduleSnapshot, setWeekTemplate } from './schedule.js';
import {
  addNote,
  type BlockPatch,
  deleteBlock,
  deletePlace,
  getBlock,
  insertBlock,
  listEvents,
  listNotes,
  listPlaces,
  listRules,
  setRule,
  updateBlock,
  upsertPlace,
} from './store.js';
import { summary, today } from './summary.js';
import { addDays, londonDate, MIN, parseTime, startOfDay } from './time.js';

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  readOnly?: boolean;
  run: (args: z.infer<S>, ctx: Ctx) => Promise<unknown>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool;

const blockFields = {
  title: z.string().min(1).max(120),
  category: z.enum(CATEGORIES),
  alarm_offsets_min: offsetsSchema.optional(),
  alarm_label: z.string().min(1).max(80).optional().describe('Text shown full-screen on the alarm, e.g. "GO GYM". Defaults to the title in caps.'),
  required_place: z.string().max(60).nullish().describe('Place id (see list_places). If set, arriving there marks the block done; not arriving triggers the late rule.'),
  notes: z.string().max(1000).nullish(),
  alert: alertSchema.optional(),
  quiet: quietSchema.optional(),
};

async function maybeTime(s: string | undefined) {
  return s === undefined ? undefined : parseTime(s);
}

export const TOOLS: Tool[] = [
  tool({
    name: 'get_today',
    description:
      "Today's plan vs reality (Europe/London): every block with its status, the current and next block, distraction minutes, when the phone last synced, and today's notes (including rule firings). Start every check-in with this.",
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => {
      await materialize(ctx.db, ctx.now());
      return today(ctx.db, ctx.now());
    },
  }),
  tool({
    name: 'get_schedule',
    description: 'Blocks overlapping a time range, plus the exact alarms the phone will book. Defaults to the next 48 hours.',
    input: z.object({ from: timeString.optional(), to: timeString.optional() }),
    readOnly: true,
    run: async (a, ctx) => {
      const now = ctx.now();
      await materialize(ctx.db, now);
      const from = a.from ? parseTime(a.from) : now;
      const to = a.to ? parseTime(a.to) : new Date(from.getTime() + 48 * 60 * MIN);
      return scheduleSnapshot(ctx.db, now, from, to);
    },
  }),
  tool({
    name: 'add_block',
    description:
      'Add a block to the schedule. Each alarm offset becomes a full-screen AlarmKit alarm on the phone after its next sync. Avoid overlapping blocks unless intended.',
    input: z.object({ ...blockFields, start: timeString, end: timeString }),
    run: async (a, ctx) =>
      insertBlock(ctx.db, ctx.now(), {
        title: a.title,
        category: a.category,
        start_at: parseTime(a.start),
        end_at: parseTime(a.end),
        alarm_offsets_min: a.alarm_offsets_min ?? [-10, 0],
        alarm_label: a.alarm_label,
        required_place: a.required_place ?? null,
        notes: a.notes ?? null,
        alert: a.alert,
        quiet: a.quiet,
        source: 'claude',
      }),
  }),
  tool({
    name: 'update_block',
    description: 'Change any fields of a block, including its status (planned/done/missed/skipped/moved). Only the fields you pass change.',
    input: z.object({
      id: z.string(),
      title: blockFields.title.optional(),
      category: blockFields.category.optional(),
      start: timeString.optional(),
      end: timeString.optional(),
      alarm_offsets_min: blockFields.alarm_offsets_min,
      alarm_label: blockFields.alarm_label,
      required_place: blockFields.required_place,
      status: z.enum(STATUSES).optional(),
      notes: blockFields.notes,
      alert: blockFields.alert,
      quiet: blockFields.quiet,
    }),
    run: async (a, ctx) => {
      const patch: BlockPatch = {
        title: a.title,
        category: a.category,
        start_at: await maybeTime(a.start),
        end_at: await maybeTime(a.end),
        alarm_offsets_min: a.alarm_offsets_min,
        alarm_label: a.alarm_label,
        required_place: a.required_place,
        status: a.status,
        notes: a.notes,
        alert: a.alert,
        quiet: a.quiet,
      };
      for (const k of Object.keys(patch) as (keyof BlockPatch)[]) if (patch[k] === undefined) delete patch[k];
      return updateBlock(ctx.db, ctx.now(), a.id, patch);
    },
  }),
  tool({
    name: 'move_block',
    description: 'Move a block to a new start time. Keeps its duration unless `end` is given. Re-arms it (status → moved) so it rings again.',
    input: z.object({ id: z.string(), start: timeString, end: timeString.optional() }),
    run: async (a, ctx) => {
      const b = await getBlock(ctx.db, a.id);
      if (!b) throw new HttpError(404, `block ${a.id} not found`);
      const start = parseTime(a.start);
      const end = a.end ? parseTime(a.end) : new Date(start.getTime() + (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()));
      return updateBlock(ctx.db, ctx.now(), a.id, { start_at: start, end_at: end, status: 'moved' });
    },
  }),
  tool({
    name: 'delete_block',
    description: "Delete a block. Its alarms are cancelled on the phone's next sync. Prefer update_block status=skipped to keep history.",
    input: z.object({ id: z.string() }),
    run: async (a, ctx) => ({ deleted: await deleteBlock(ctx.db, a.id) }),
  }),
  tool({
    name: 'get_week_template',
    description: 'The recurring default week that blocks are generated from (14 days ahead).',
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => getWeekTemplate(ctx.db),
  }),
  tool({
    name: 'set_week_template',
    description:
      'Replace the whole recurring default week. Days you omit become empty. Future untouched template blocks are regenerated; blocks Claude added or edited by hand are kept. Times are London HH:MM.',
    input: z.object({
      days: z.object({
        mon: z.array(templateItem).optional(),
        tue: z.array(templateItem).optional(),
        wed: z.array(templateItem).optional(),
        thu: z.array(templateItem).optional(),
        fri: z.array(templateItem).optional(),
        sat: z.array(templateItem).optional(),
        sun: z.array(templateItem).optional(),
      }),
    }),
    run: async (a, ctx) => setWeekTemplate(ctx.db, ctx.now(), a.days),
  }),
  tool({
    name: 'get_events',
    description:
      'What actually happened: check-ins (payload.action on_it/snooze/skip), place_enter/exit (payload.place), app_open/close (payload.app, kind), alarm_fired, sync. Oldest first.',
    input: z.object({
      since: timeString.describe('Start of range (London time if no offset).'),
      until: timeString.optional(),
      type: z.enum(EVENT_TYPES).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    readOnly: true,
    run: async (a, ctx) =>
      listEvents(ctx.db, {
        since: parseTime(a.since),
        until: a.until ? parseTime(a.until) : undefined,
        types: a.type ? [a.type] : undefined,
        limit: a.limit ?? 300,
      }),
  }),
  tool({
    name: 'get_summary',
    description: 'Totals for a range: planned vs done hours per category, gym sessions, missed/skipped blocks, distraction minutes per app, place visits, check-in counts. Defaults to the last 7 days.',
    input: z.object({ from: timeString.optional(), to: timeString.optional() }),
    readOnly: true,
    run: async (a, ctx) => {
      const now = ctx.now();
      const to = a.to ? parseTime(a.to) : startOfDay(addDays(londonDate(now), 1));
      const from = a.from ? parseTime(a.from) : startOfDay(addDays(londonDate(now), -6));
      return summary(ctx.db, now, from, to);
    },
  }),
  tool({
    name: 'add_note',
    description: "Leave a note for future check-ins (your reasoning, what you changed and why, what to watch for). Use author 'me' only to record something the user told you.",
    input: z.object({ text: z.string().min(1).max(4000), author: z.enum(['claude', 'me']).optional() }),
    run: async (a, ctx) => addNote(ctx.db, ctx.now(), a.author ?? 'claude', a.text),
  }),
  tool({
    name: 'get_notes',
    description: 'Notes from Claude, the user and the rules engine, oldest first. Defaults to the last 3 days.',
    input: z.object({ since: timeString.optional(), limit: z.number().int().min(1).max(500).optional() }),
    readOnly: true,
    run: async (a, ctx) =>
      listNotes(ctx.db, a.since ? parseTime(a.since) : new Date(ctx.now().getTime() - 3 * 24 * 60 * MIN), a.limit ?? 100),
  }),
  tool({
    name: 'list_places',
    description: 'Geofenced places (the phone monitors these; max 20).',
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => listPlaces(ctx.db),
  }),
  tool({
    name: 'upsert_place',
    description: 'Create or update a geofenced place. id defaults to a slug of the name (e.g. "KCL Strand" → kcl_strand). Radius 100–300 m works best.',
    input: z.object({
      id: z.string().max(40).optional(),
      name: z.string().min(1).max(60),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radius_m: z.number().int().min(50).max(2000).optional(),
    }),
    run: async (a, ctx) => {
      const existing = await listPlaces(ctx.db);
      if (existing.length >= 20 && !existing.some((p) => p.id === a.id || p.name === a.name))
        throw new HttpError(400, 'iOS can only monitor 20 regions; delete one first');
      return upsertPlace(ctx.db, { ...a, radius_m: a.radius_m ?? 150 });
    },
  }),
  tool({
    name: 'delete_place',
    description: 'Remove a geofenced place.',
    input: z.object({ id: z.string() }),
    run: async (a, ctx) => ({ deleted: await deletePlace(ctx.db, a.id) }),
  }),
  tool({
    name: 'list_rules',
    description:
      'Server rules and their parameters. Built-in rule names: late_for_place {grace_min}, distraction_during_focus {categories, kinds, cooldown_min}, solo_gaming {kinds, cooldown_min} (games outside a play block), no_checkin_missed {after_min, snooze_min}, play_limit {limit_min, exclude_play_blocks}, steps_goal {goal, after: "HH:MM"}. Actions take {alarm_in_min, label, alert: "alarm" | "notification"} with {place}/{title}/{app}/{short} placeholders.',
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => listRules(ctx.db),
  }),
  tool({
    name: 'set_rule',
    description: 'Tune or toggle a rule (see list_rules for names and parameters). condition/action replace the stored JSON when given.',
    input: z.object({
      name: z.enum(['late_for_place', 'distraction_during_focus', 'solo_gaming', 'no_checkin_missed', 'play_limit', 'steps_goal']),
      condition: z.record(z.string(), z.unknown()).optional(),
      action: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }),
    run: async (a, ctx) => setRule(ctx.db, a),
  }),
  tool({
    name: 'run_rules',
    description: 'Run the rules engine now (normally runs on every phone sync/event and every ~10 min).',
    input: z.object({}),
    run: async (_a, ctx) => tick(ctx.db, ctx.now()),
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
