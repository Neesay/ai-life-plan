export interface Db {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
}

// One statement per entry: the Neon HTTP driver runs one statement per query.
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('uni','work','gym','play','sleep','other')),
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    alarm_offsets_min JSONB NOT NULL DEFAULT '[0]',
    alarm_label TEXT NOT NULL,
    required_place TEXT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','missed','skipped','moved')),
    source TEXT NOT NULL DEFAULT 'claude',
    notes TEXT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_at > start_at)
  )`,
  `CREATE INDEX IF NOT EXISTS blocks_start_idx ON blocks (start_at)`,
  `ALTER TABLE blocks ADD COLUMN IF NOT EXISTS alert TEXT NOT NULL DEFAULT 'alarm'`,
  `ALTER TABLE blocks ADD COLUMN IF NOT EXISTS quiet BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    type TEXT NOT NULL,
    block_id TEXT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    source TEXT NOT NULL,
    client_id TEXT NULL UNIQUE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts)`,
  `CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    radius_m INTEGER NOT NULL DEFAULT 150
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    condition JSONB NOT NULL DEFAULT '{}',
    action JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT true
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('claude','me','system')),
    text TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS notes_ts_idx ON notes (ts)`,
  `CREATE TABLE IF NOT EXISTS week_template (
    weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
    items JSONB NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS materialized_days (day TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS rule_firings (
    rule TEXT NOT NULL,
    key TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (rule, key)
  )`,
];

export const DEFAULT_RULES: { name: string; condition: object; action: object }[] = [
  {
    name: 'late_for_place',
    condition: { grace_min: 20 },
    action: { alarm_in_min: 10, label: 'LATE — GET TO {place}' },
  },
  {
    name: 'distraction_during_focus',
    condition: { categories: ['work', 'uni'], kinds: ['game', 'social'], cooldown_min: 10, max_age_min: 60 },
    action: { alarm_in_min: 2, label: 'BACK TO WORK — {title}' },
  },
  {
    name: 'no_checkin_missed',
    condition: { after_min: 30, snooze_min: 15 },
    action: {},
  },
  {
    name: 'solo_gaming',
    condition: { kinds: ['game'], cooldown_min: 15, max_age_min: 60 },
    action: { alarm_in_min: 1, label: 'STOP — NO SOLO GAMING' },
  },
  {
    name: 'steps_goal',
    condition: { goal: 10000, after: '20:30' },
    action: { alarm_in_min: 1, label: 'WALK — {short} STEPS TO GO', alert: 'notification' },
  },
  {
    name: 'play_limit',
    condition: { limit_min: 120, exclude_play_blocks: true },
    action: { alarm_in_min: 1, label: 'PLAY LIMIT HIT — PUT IT DOWN' },
  },
];

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA) await db.query(stmt);
  for (const r of DEFAULT_RULES) {
    await db.query(
      `INSERT INTO rules (id, name, condition, action, enabled) VALUES ($1, $1, $2::jsonb, $3::jsonb, true)
       ON CONFLICT (name) DO NOTHING`,
      [r.name, JSON.stringify(r.condition), JSON.stringify(r.action)],
    );
  }
}

let cached: Db | null = null;
let migrated: Promise<void> | null = null;

export async function getDb(): Promise<Db> {
  if (!cached) {
    const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    cached = { query: (text, params) => sql.query(text, params ?? []) as Promise<any[]> };
  }
  if (!migrated) {
    migrated = migrate(cached).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  await migrated;
  return cached;
}
