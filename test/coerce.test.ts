import { describe, expect, it } from 'vitest';
import { api, makeCtx, mcpCall } from './helpers.js';

describe('lenient booleans from MCP clients', () => {
  it('accepts quiet as "true"/"false" strings and still lists a schema', async () => {
    const ctx = await makeCtx('2026-11-19T08:00:00Z');
    const b = await mcpCall(ctx, 'add_block', { title: 'L', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T11:00', quiet: 'true', alert: 'notification' });
    expect(b.quiet).toBe(true);
    const u = await mcpCall(ctx, 'update_block', { id: b.id, quiet: 'false' });
    expect(u.quiet).toBe(false);
    const list = await api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.body.result.tools.find((t: any) => t.name === 'add_block').inputSchema.properties.quiet).toBeDefined();
  });
});
