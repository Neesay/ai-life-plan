import { z } from 'zod';

export const CATEGORIES = ['uni', 'work', 'gym', 'play', 'sleep', 'other'] as const;
export const STATUSES = ['planned', 'done', 'missed', 'skipped', 'moved'] as const;
/** Blocks in these states still ring. */
export const ACTIVE_STATUSES = ['planned', 'moved'] as const;
export const EVENT_TYPES = [
  'checkin',
  'place_enter',
  'place_exit',
  'app_open',
  'app_close',
  'alarm_fired',
  'sync',
  'steps',
] as const;
export const ALERTS = ['alarm', 'notification', 'none'] as const;
export type Alert = (typeof ALERTS)[number];
export const alertSchema = z
  .enum(ALERTS)
  .describe("How this block's reminders arrive: 'alarm' = full-screen AlarmKit alarm (breaks Silent), 'notification' = normal notification (obeys Silent), 'none'.");
export const quietSchema = z
  .boolean()
  .describe('While this block runs, every alarm that would ring is downgraded to a silent-mode notification (lectures, meetings, events).');

export const SOURCES = ['app', 'shortcut', 'server', 'claude'] as const;
export const CHECKIN_ACTIONS = ['on_it', 'snooze', 'skip', 'done'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Status = (typeof STATUSES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export const timeString = z
  .string()
  .min(10)
  .describe('ISO 8601. Without an offset it is read as Europe/London local time, e.g. "2026-11-19T09:00".');

export const offsetsSchema = z
  .array(z.number().int().min(-720).max(240))
  .max(6)
  .describe('Minutes relative to block start at which alarms ring, e.g. [-15, 0]. [] = no alarm.');

export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24h)');

export const eventInput = z.object({
  type: z.enum(EVENT_TYPES),
  ts: timeString.optional().describe('When it happened. Omit to use the time the server receives it.'),
  block_id: z.string().max(100).nullish(),
  payload: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(SOURCES).optional(),
  client_id: z.string().max(100).nullish().describe('Idempotency key: an event with a repeated client_id is ignored.'),
});
export type EventInput = z.infer<typeof eventInput>;

export const templateItem = z.object({
  title: z.string().min(1).max(120),
  category: z.enum(CATEGORIES),
  start: hhmm,
  end: hhmm.describe('If end <= start the block runs past midnight (e.g. sleep 23:30–07:30).'),
  alarm_offsets_min: offsetsSchema.optional(),
  alarm_label: z.string().max(80).optional(),
  required_place: z.string().max(60).nullish(),
  alert: alertSchema.optional(),
  quiet: quietSchema.optional(),
});
export type TemplateItem = z.infer<typeof templateItem>;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
