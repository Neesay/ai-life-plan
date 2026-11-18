import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import type { Category, EventInput, Status, TemplateItem } from './model.js';
import { formatLondon, parseTime, toIso } from './time.js';

// ---------- blocks ----------

export interface Block {
  id: string;
  title: string;
  category: Category;
  start_at: string;
  end_at: string;
  start_local: string;
  end_local: string;
  alarm_offsets_min: number[];
  alarm_label: string;
  required_place: string | null;
  status: Status;
  source: string;
  notes: string | null;
  version: number;
  updated_at: string;
}

function mapBlock(r: any): Block {
  const start = new Date(toIso(r.start_at));
  const end = new Date(toIso(r.end_at));
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    start_local: formatLondon(start),
    end_local: formatLondon(end),
    alarm_offsets_min: Array.isArray(r.alarm_offsets_min) ? r.alarm_offsets_min : JSON.parse(r.alarm_offsets_min ?? '[]'),
    alarm_label: r.alarm_label,
    required_place: r.required_place ?? null,
    status: r.status,
    source: r.source,
    notes: r.notes ?? null,
    version: Number(r.version),
    updated_at: toIso(r.updated_at),
  };
}

export interface NewBlock {
  title: string;
  category: Category;
  start_at: Date;
  end_at: Date;
  alarm_offsets_min?: number[];
  alarm_label?: string;
  required_place?: string | null;
  status?: Status;
  source?: string;
  notes?: string | null;
}

export function defaultLabel(title: string): string {
  return title.toUpperCase().slice(0, 80);
}

export async function insertBlock(db: Db, now: Date, b: NewBlock): Promise<Block> {
  if (b.end_at <= b.start_at) throw new HttpError(400, 'end must be after start');
  const rows = await db.query(
    `INSERT INTO blocks (id, title, category, start_at, end_at, alarm_offsets_min, alarm_label, required_place, status, source, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb,$7,$8,$9,$10,$11,$12::timestamptz,$12::timestamptz)
     RETURNING *`,
    [
      randomUUID(),
      b.title,
      b.category,
      b.start_at.toISOString(),
      b.end_at.toISOString(),
      JSON.stringify(b.alarm_offsets_min ?? [0]),
      b.alarm_label ?? defaultLabel(b.title),
      b.required_place ?? null,
      b.status ?? 'planned',
      b.source ?? 'claude',
      b.notes ?? null,
      now.toISOString(),
    ],
  );
  return mapBlock(rows[0]);
}

export async function getBlock(db: Db, id: string): Promise<Block | null> {
  const rows = await db.query(`SELECT * FROM blocks WHERE id = $1`, [id]);
  return rows[0] ? mapBlock(rows[0]) : null;
}

/** Blocks overlapping [from, to). */
export async function listBlocks(db: Db, from: Date, to: Date): Promise<Block[]> {
  const rows = await db.query(
    `SELECT * FROM blocks WHERE start_at < $2::timestamptz AND end_at > $1::timestamptz ORDER BY start_at, id`,
    [from.toISOString(), to.toISOString()],
  );
  return rows.map(mapBlock);
}

export type BlockPatch = Partial<Omit<NewBlock, 'source'>>;

export async function updateBlock(db: Db, now: Date, id: string, patch: BlockPatch): Promise<Block> {
  const current = await getBlock(db, id);
  if (!current) throw new HttpError(404, `block ${id} not found`);
  const start = patch.start_at ?? new Date(current.start_at);
  const end = patch.end_at ?? new Date(current.end_at);
  if (end <= start) throw new HttpError(400, 'end must be after start');

  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, val: unknown, cast = '') => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.title !== undefined) add('title', patch.title);
  if (patch.category !== undefined) add('category', patch.category);
  if (patch.start_at !== undefined) add('start_at', patch.start_at.toISOString(), '::timestamptz');
  if (patch.end_at !== undefined) add('end_at', patch.end_at.toISOString(), '::timestamptz');
  if (patch.alarm_offsets_min !== undefined) add('alarm_offsets_min', JSON.stringify(patch.alarm_offsets_min), '::jsonb');
  if (patch.alarm_label !== undefined) add('alarm_label', patch.alarm_label);
  if (patch.required_place !== undefined) add('required_place', patch.required_place);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.notes !== undefined) add('notes', patch.notes);
  if (sets.length === 0) return current;
  add('updated_at', now.toISOString(), '::timestamptz');
  sets.push('version = version + 1');

  const rows = await db.query(`UPDATE blocks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return mapBlock(rows[0]);
}

export async function deleteBlock(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM blocks WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/** Blocks that are still planned/moved and started in [from, to]. */
export async function activeBlocksStartedBetween(db: Db, from: Date, to: Date): Promise<Block[]> {
  const rows = await db.query(
    `SELECT * FROM blocks WHERE status IN ('planned','moved') AND start_at >= $1::timestamptz AND start_at <= $2::timestamptz ORDER BY start_at`,
    [from.toISOString(), to.toISOString()],
  );
  return rows.map(mapBlock);
}

// ---------- events ----------

export interface EventRow {
  id: string;
  ts: string;
  ts_local: string;
  type: string;
  block_id: string | null;
  payload: Record<string, any>;
  source: string;
  client_id: string | null;
}

function mapEvent(r: any): EventRow {
  const ts = new Date(toIso(r.ts));
  return {
    id: r.id,
    ts: ts.toISOString(),
    ts_local: formatLondon(ts),
    type: r.type,
    block_id: r.block_id ?? null,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
    source: r.source,
    client_id: r.client_id ?? null,
  };
}

/** Inserts events, ignoring repeated client_ids. Returns only the newly inserted rows. */
export async function insertEvents(db: Db, now: Date, events: EventInput[], defaultSource = 'app'): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (const e of events) {
    const ts = e.ts ? parseTime(e.ts) : now;
    // Clamp wildly future timestamps (bad phone clock / bad Shortcut) to now.
    const safeTs = ts.getTime() > now.getTime() + 5 * 60_000 ? now : ts;
    const rows = await db.query(
      `INSERT INTO events (id, ts, type, block_id, payload, source, client_id, received_at)
       VALUES ($1, $2::timestamptz, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
       ON CONFLICT (client_id) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        safeTs.toISOString(),
        e.type,
        e.block_id ?? null,
        JSON.stringify(e.payload ?? {}),
        e.source ?? defaultSource,
        e.client_id ?? null,
        now.toISOString(),
      ],
    );
    if (rows[0]) out.push(mapEvent(rows[0]));
  }
  return out;
}

export async function listEvents(
  db: Db,
  opts: { since: Date; until?: Date; types?: string[]; blockId?: string; limit?: number },
): Promise<EventRow[]> {
  const params: unknown[] = [opts.since.toISOString()];
  const where = ['ts >= $1::timestamptz'];
  if (opts.until) {
    params.push(opts.until.toISOString());
    where.push(`ts < $${params.length}::timestamptz`);
  }
  if (opts.types?.length) {
    params.push(opts.types);
    where.push(`type = ANY($${params.length}::text[])`);
  }
  if (opts.blockId) {
    params.push(opts.blockId);
    where.push(`block_id = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 500, 2000));
  const rows = await db.query(
    `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts ASC, received_at ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapEvent);
}

export async function lastEvent(db: Db, type: string): Promise<EventRow | null> {
  const rows = await db.query(`SELECT * FROM events WHERE type = $1 ORDER BY ts DESC LIMIT 1`, [type]);
  return rows[0] ? mapEvent(rows[0]) : null;
}

// ---------- notes ----------

export interface Note {
  id: string;
  ts: string;
  ts_local: string;
  author: 'claude' | 'me' | 'system';
  text: string;
}

function mapNote(r: any): Note {
  const ts = new Date(toIso(r.ts));
  return { id: r.id, ts: ts.toISOString(), ts_local: formatLondon(ts), author: r.author, text: r.text };
}

export async function addNote(db: Db, now: Date, author: Note['author'], text: string): Promise<Note> {
  const rows = await db.query(
    `INSERT INTO notes (id, ts, author, text) VALUES ($1, $2::timestamptz, $3, $4) RETURNING *`,
    [randomUUID(), now.toISOString(), author, text],
  );
  return mapNote(rows[0]);
}

export async function listNotes(db: Db, since: Date, limit = 100): Promise<Note[]> {
  const rows = await db.query(
    `SELECT * FROM (SELECT * FROM notes WHERE ts >= $1::timestamptz ORDER BY ts DESC LIMIT $2) n ORDER BY ts ASC`,
    [since.toISOString(), limit],
  );
  return rows.map(mapNote);
}

// ---------- places ----------

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
}

const mapPlace = (r: any): Place => ({
  id: r.id,
  name: r.name,
  lat: Number(r.lat),
  lng: Number(r.lng),
  radius_m: Number(r.radius_m),
});

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export async function listPlaces(db: Db): Promise<Place[]> {
  return (await db.query(`SELECT * FROM places ORDER BY name`)).map(mapPlace);
}

export async function upsertPlace(db: Db, p: Omit<Place, 'id'> & { id?: string }): Promise<Place> {
  const id = p.id ? slugify(p.id) : slugify(p.name);
  if (!id) throw new HttpError(400, 'place needs a name');
  const rows = await db.query(
    `INSERT INTO places (id, name, lat, lng, radius_m) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng, radius_m = EXCLUDED.radius_m
     RETURNING *`,
    [id, p.name, p.lat, p.lng, p.radius_m],
  );
  return mapPlace(rows[0]);
}

export async function deletePlace(db: Db, id: string): Promise<boolean> {
  return (await db.query(`DELETE FROM places WHERE id = $1 RETURNING id`, [id])).length > 0;
}

// ---------- rules ----------

export interface Rule {
  id: string;
  name: string;
  condition: Record<string, any>;
  action: Record<string, any>;
  enabled: boolean;
}

const mapRule = (r: any): Rule => ({
  id: r.id,
  name: r.name,
  condition: typeof r.condition === 'string' ? JSON.parse(r.condition) : r.condition,
  action: typeof r.action === 'string' ? JSON.parse(r.action) : r.action,
  enabled: !!r.enabled,
});

export async function listRules(db: Db): Promise<Rule[]> {
  return (await db.query(`SELECT * FROM rules ORDER BY name`)).map(mapRule);
}

export async function setRule(
  db: Db,
  r: { name: string; condition?: object; action?: object; enabled?: boolean },
): Promise<Rule> {
  const rows = await db.query(
    `INSERT INTO rules (id, name, condition, action, enabled)
     VALUES ($1, $1, COALESCE($2::jsonb, '{}'::jsonb), COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4::boolean, true))
     ON CONFLICT (name) DO UPDATE SET
       condition = COALESCE($2::jsonb, rules.condition),
       action = COALESCE($3::jsonb, rules.action),
       enabled = COALESCE($4::boolean, rules.enabled)
     RETURNING *`,
    [
      r.name,
      r.condition === undefined ? null : JSON.stringify(r.condition),
      r.action === undefined ? null : JSON.stringify(r.action),
      r.enabled === undefined ? null : r.enabled,
    ],
  );
  return mapRule(rows[0]);
}

/** Records that a rule fired for `key`. Returns false if it already had. */
export async function claimFiring(db: Db, now: Date, rule: string, key: string): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO rule_firings (rule, key, ts) VALUES ($1, $2, $3::timestamptz) ON CONFLICT DO NOTHING RETURNING rule`,
    [rule, key, now.toISOString()],
  );
  return rows.length > 0;
}

export async function lastFiring(db: Db, rule: string, keyPrefix: string): Promise<Date | null> {
  const rows = await db.query(
    `SELECT ts FROM rule_firings WHERE rule = $1 AND key LIKE $2 ORDER BY ts DESC LIMIT 1`,
    [rule, `${keyPrefix}%`],
  );
  return rows[0] ? new Date(toIso(rows[0].ts)) : null;
}

// ---------- week template ----------

export type WeekTemplate = Record<number, TemplateItem[]>;

export async function getTemplate(db: Db): Promise<WeekTemplate> {
  const rows = await db.query(`SELECT weekday, items FROM week_template`);
  const out: WeekTemplate = {};
  for (const r of rows) out[Number(r.weekday)] = typeof r.items === 'string' ? JSON.parse(r.items) : r.items;
  return out;
}

export async function replaceTemplate(db: Db, t: WeekTemplate): Promise<void> {
  await db.query(`DELETE FROM week_template`);
  for (const [weekday, items] of Object.entries(t)) {
    await db.query(`INSERT INTO week_template (weekday, items) VALUES ($1, $2::jsonb)`, [
      Number(weekday),
      JSON.stringify(items),
    ]);
  }
}
