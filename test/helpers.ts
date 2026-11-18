import { PGlite } from '@electric-sql/pglite';
import { type Db, migrate } from '../src/db.js';
import type { Ctx } from '../src/http.js';
import { route } from '../src/routes.js';

export const TOKEN = 'test-token-0123456789abcdef';
export const MCP_KEY = 'mcp-key-0123456789abcdef';

export interface TestCtx extends Ctx {
  setNow(iso: string | Date): void;
  advance(min: number): void;
}

export async function makeCtx(startIso = '2026-11-19T08:00:00Z'): Promise<TestCtx> {
  const pg = new PGlite();
  const db: Db = { query: async (text, params) => (await pg.query(text, params as any[])).rows as any[] };
  await migrate(db);
  let now = new Date(startIso);
  return {
    db,
    now: () => now,
    env: { apiToken: TOKEN, mcpKey: MCP_KEY },
    setNow: (d) => (now = new Date(d)),
    advance: (min) => (now = new Date(now.getTime() + min * 60_000)),
  };
}

export async function api(ctx: Ctx, method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await route(
    new Request(`https://test.local${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    ctx,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let rpcId = 0;
export async function mcpCall(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  const r = await api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const result = r.body.result;
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
