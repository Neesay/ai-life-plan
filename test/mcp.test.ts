import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeCtx, mcpCall, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeCtx();
});

describe('MCP protocol', () => {
  it('initializes and negotiates the protocol version', async () => {
    const r = await api(ctx, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.instructions).toContain('Europe/London');
    const r2 = await api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(r2.body.result.protocolVersion).toBe('2025-11-25');
  });
  it('returns 202 for notifications', async () => {
    const r = await api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
  });
  it('GET is 405 (no SSE)', async () => {
    expect((await api(ctx, 'GET', '/mcp')).status).toBe(405);
  });
  it('lists tools with JSON schemas', async () => {
    const r = await api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = r.body.result.tools.map((t: any) => t.name);
    for (const n of ['get_today', 'get_schedule', 'add_block', 'update_block', 'move_block', 'delete_block', 'set_week_template', 'get_events', 'get_summary', 'add_note', 'upsert_place', 'set_rule'])
      expect(names).toContain(n);
    const add = r.body.result.tools.find((t: any) => t.name === 'add_block');
    expect(add.inputSchema.type).toBe('object');
    expect(add.inputSchema.required).toEqual(expect.arrayContaining(['title', 'category', 'start', 'end']));
  });
  it('handles batches and unknown methods', async () => {
    const r = await api(ctx, 'POST', '/mcp', [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'nope' },
    ]);
    expect(r.body[0].result).toEqual({});
    expect(r.body[1].error.code).toBe(-32601);
  });
  it('reports bad tool arguments as tool errors', async () => {
    await expect(mcpCall(ctx, 'add_block', { title: 'x' })).rejects.toThrow(/Invalid arguments/);
    await expect(
      mcpCall(ctx, 'add_block', { title: 'x', category: 'gym', start: '2026-11-19T10:00', end: '2026-11-19T09:00' }),
    ).rejects.toThrow(/end must be after start/);
  });
});

describe('week template', () => {
  it('materialises 14 days, handles overnight blocks, and keeps manual edits', async () => {
    const r = await mcpCall(ctx, 'set_week_template', {
      days: {
        thu: [
          { title: 'Lecture', category: 'uni', start: '10:00', end: '12:00', required_place: 'kcl_strand' },
          { title: 'Sleep', category: 'sleep', start: '23:30', end: '07:30', alarm_offsets_min: [-30], alarm_label: 'WIND DOWN' },
        ],
        mon: [{ title: 'Gym', category: 'gym', start: '18:00', end: '19:00' }],
      },
    });
    // 2 Thursdays x 2 items + 2 Mondays x 1 item
    expect(r.created).toBe(6);
    const sched = await mcpCall(ctx, 'get_schedule', { from: '2026-11-19T00:00', to: '2026-11-20T12:00' });
    const sleep = sched.blocks.find((b: any) => b.title === 'Sleep');
    expect(sleep.start_local).toBe('2026-11-19 23:30');
    expect(sleep.end_local).toBe('2026-11-20 07:30');
    expect(sched.alarms.find((a: any) => a.block_id === sleep.id).label).toBe('WIND DOWN · in 30 min');

    const lecture = sched.blocks.find((b: any) => b.title === 'Lecture');
    await mcpCall(ctx, 'update_block', { id: lecture.id, status: 'skipped' });
    const r2 = await mcpCall(ctx, 'get_schedule', { from: '2026-11-19T00:00', to: '2026-11-20T00:00' });
    expect(r2.blocks.filter((b: any) => b.title === 'Lecture')).toHaveLength(1);

    const t = await mcpCall(ctx, 'get_week_template');
    expect(t.thu).toHaveLength(2);
    expect(t.tue).toEqual([]);
  });

  it('does not create blocks that already started today', async () => {
    ctx.setNow('2026-11-19T11:00:00Z');
    const r = await mcpCall(ctx, 'set_week_template', { days: { thu: [{ title: 'Morning', category: 'work', start: '09:00', end: '10:00' }] } });
    expect(r.created).toBe(1); // only next Thursday
  });
});
