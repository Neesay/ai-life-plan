import { z } from 'zod';
import { type Ctx, errorResponse, HttpError, json, readJson, requireAuth } from './http.js';
import { handleMcp } from './mcp.js';
import { eventInput } from './model.js';
import { applyEvent, tick } from './rules.js';
import { scheduleSnapshot } from './schedule.js';
import { insertEvents, listPlaces } from './store.js';
import { today } from './summary.js';
import { MIN, parseTime } from './time.js';

const eventsBody = z.union([z.array(eventInput).max(500), z.object({ events: z.array(eventInput).max(500) }), eventInput]);

async function getSchedule(req: Request, ctx: Ctx) {
  requireAuth(req, ctx);
  const now = ctx.now();
  const url = new URL(req.url);
  const from = url.searchParams.get('from') ? parseTime(url.searchParams.get('from')!) : now;
  const to = url.searchParams.get('to') ? parseTime(url.searchParams.get('to')!) : new Date(from.getTime() + 48 * 60 * MIN);
  if (to <= from) throw new HttpError(400, '`to` must be after `from`');
  if (to.getTime() - from.getTime() > 31 * 24 * 60 * MIN) throw new HttpError(400, 'range too large (max 31 days)');
  const ticked = await tick(ctx.db, now);
  await insertEvents(ctx.db, now, [{ type: 'sync', payload: { client: url.searchParams.get('client') ?? 'unknown' } }], 'server');
  return json({ ...(await scheduleSnapshot(ctx.db, now, from, to)), rule_actions: ticked.actions });
}

async function postEvents(req: Request, ctx: Ctx) {
  requireAuth(req, ctx);
  const now = ctx.now();
  const parsed = eventsBody.parse(await readJson(req));
  const events = Array.isArray(parsed) ? parsed : 'events' in parsed ? parsed.events : [parsed];
  const inserted = await insertEvents(ctx.db, now, events);
  const changes: string[] = [];
  for (const e of inserted) changes.push(...(await applyEvent(ctx.db, now, e)));
  const ticked = await tick(ctx.db, now);
  return json({ received: events.length, inserted: inserted.length, duplicates: events.length - inserted.length, changes, rule_actions: ticked.actions });
}

async function getPlaces(req: Request, ctx: Ctx) {
  requireAuth(req, ctx);
  return json({ places: await listPlaces(ctx.db) });
}

async function getStatus(req: Request, ctx: Ctx) {
  requireAuth(req, ctx);
  return json(await today(ctx.db, ctx.now()));
}

async function postTick(req: Request, ctx: Ctx) {
  requireAuth(req, ctx);
  return json(await tick(ctx.db, ctx.now()));
}

type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  '/api/schedule': { GET: getSchedule },
  '/api/events': { POST: postEvents },
  '/api/places': { GET: getPlaces },
  '/api/status': { GET: getStatus },
  '/api/tick': { POST: postTick, GET: postTick },
};

/** Single entry point for every request. Works for both rewritten (/mcp) and direct (/api/mcp) paths. */
export async function route(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/health') return json({ ok: true });
    if (path === '/mcp' || path.startsWith('/mcp/') || path === '/api/mcp') return await handleMcp(req, ctx);
    const r = ROUTES[path];
    if (!r) throw new HttpError(404, 'not found');
    const h = r[req.method];
    if (!h) throw new HttpError(405, `method ${req.method} not allowed`);
    return await h(req, ctx);
  } catch (e) {
    return errorResponse(e);
  }
}
