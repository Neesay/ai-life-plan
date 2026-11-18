import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import type { Db } from './db.js';

export interface Ctx {
  db: Db;
  now: () => Date;
  env: { apiToken?: string; mcpKey?: string };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status);
  if (e instanceof ZodError) return json({ error: 'invalid input', details: e.issues }, 400);
  console.error(e);
  return json({ error: 'internal error' }, 500);
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Pull the MCP URL key from `?key=` or a `/mcp/<key>` path. */
export function urlKey(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get('key') ?? /\/mcp\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
}

export function requireAuth(req: Request, ctx: Ctx, opts: { allowUrlKey?: boolean } = {}): void {
  const token = ctx.env.apiToken;
  if (!token || token.length < 16) throw new HttpError(500, 'API_TOKEN is not configured (min 16 chars)');
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (m && safeEqual(m[1].trim(), token)) return;
  if (opts.allowUrlKey && ctx.env.mcpKey && ctx.env.mcpKey.length >= 16) {
    const key = urlKey(req);
    if (key && safeEqual(decodeURIComponent(key), ctx.env.mcpKey)) return;
  }
  throw new HttpError(401, 'unauthorized');
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}
