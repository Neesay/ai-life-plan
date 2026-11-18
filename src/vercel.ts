import { getDb } from './db.js';
import { errorResponse, type Ctx } from './http.js';
import { route } from './routes.js';

async function prodCtx(): Promise<Ctx> {
  return {
    db: await getDb(),
    now: () => new Date(),
    env: { apiToken: process.env.API_TOKEN, mcpKey: process.env.MCP_KEY },
  };
}

/** Vercel Function handler (Web standard Request/Response). */
export async function handler(req: Request): Promise<Response> {
  if (new URL(req.url).pathname.replace(/\/+$/, '') === '/api/health') return route(req, {} as Ctx);
  try {
    return await route(req, await prodCtx());
  } catch (e) {
    return errorResponse(e);
  }
}
