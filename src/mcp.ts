// Minimal stateless MCP server over Streamable HTTP (JSON responses, no SSE).
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import { z, ZodError } from 'zod';
import { type Ctx, HttpError, json, readJson, requireAuth } from './http.js';
import { TOOL_MAP, TOOLS } from './tools.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'accountability-alarms', version: '1.0.0' };

export const INSTRUCTIONS = `You are the planner for one person's accountability alarm system.
- Everything is Europe/London time. Times you pass without an offset are London wall-clock ("2026-11-19T09:00").
- Every block's alarm offsets become full-screen iPhone alarms that break through Silent/Focus. They reach the phone only at its next sync (app open, background refresh, Shortcut at 07:30/12:30/17:30/21:30, or geofence), so plan changes at least ~1h ahead when possible; the phone books 48h ahead.
- Start each session with get_today and get_notes; end it with add_note explaining what you changed and why.
- Statuses: planned → done (checked in "On it" or arrived at required place) / skipped (user said skip) / missed (no check-in 30 min after start). move_block re-arms a block.
- Rule firings (late, distraction, play limit) appear as notes by 'system' and as short 'rule' blocks.
- Be firm but realistic: reschedule missed essentials (gym, study) into real free slots instead of stacking them.`;

type JsonRpcId = string | number | null;
interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

const toolDefs = () =>
  TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      inputSchema: schema,
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: t.name.startsWith('delete') || t.name === 'set_week_template' },
    };
  });

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

async function callTool(params: any, ctx: Ctx) {
  const t = TOOL_MAP.get(params?.name);
  if (!t) return { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true };
  try {
    const args = t.input.parse(params?.arguments ?? {});
    const result = await t.run(args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg =
      e instanceof ZodError
        ? `Invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
        : e instanceof Error
          ? e.message
          : String(e);
    if (!(e instanceof ZodError) && !(e instanceof HttpError)) console.error(e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

async function handleMessage(msg: JsonRpcMsg, ctx: Ctx) {
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  if (isNotification) return null;
  const id = msg.id as JsonRpcId;
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDefs() } };
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: await callTool(msg.params, ctx) };
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // Stateless server: no SSE stream, no sessions.
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  requireAuth(req, ctx, { allowUrlKey: true });

  const body = await readJson(req);
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as JsonRpcMsg[];
  const responses = [];
  for (const m of msgs) {
    const r = await handleMessage(m, ctx);
    if (r) responses.push(r);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}
