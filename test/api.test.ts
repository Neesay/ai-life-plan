import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeCtx, mcpCall, MCP_KEY, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeCtx('2026-11-19T08:00:00Z'); // Thu 08:00 London
});

describe('auth', () => {
  it('rejects missing or wrong tokens', async () => {
    expect((await api(ctx, 'GET', '/api/schedule', undefined, null)).status).toBe(401);
    expect((await api(ctx, 'GET', '/api/schedule', undefined, 'wrong-token-wrong-token')).status).toBe(401);
  });
  it('health needs no auth', async () => {
    expect((await api(ctx, 'GET', '/api/health', undefined, null)).status).toBe(200);
  });
  it('MCP accepts the URL key but REST does not', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await api(ctx, 'POST', `/mcp/${MCP_KEY}`, init, null)).status).toBe(200);
    expect((await api(ctx, 'POST', `/api/mcp?key=${MCP_KEY}`, init, null)).status).toBe(200);
    expect((await api(ctx, 'POST', `/mcp/nope-nope-nope-nope`, init, null)).status).toBe(401);
    expect((await api(ctx, 'GET', `/api/schedule?key=${MCP_KEY}`, undefined, null)).status).toBe(401);
  });
});

describe('Phase 1 acceptance: Claude adds a block via MCP and GET /api/schedule returns it', () => {
  it('round-trips with alarms', async () => {
    const block = await mcpCall(ctx, 'add_block', {
      title: 'Gym',
      category: 'gym',
      start: '2026-11-19T18:00',
      end: '2026-11-19T19:00',
      alarm_offsets_min: [-15, 0],
      alarm_label: 'GO GYM',
    });
    const r = await api(ctx, 'GET', '/api/schedule?client=test');
    expect(r.status).toBe(200);
    expect(r.body.blocks.map((b: any) => b.id)).toContain(block.id);
    expect(r.body.alarms).toHaveLength(2);
    expect(r.body.alarms[0]).toMatchObject({ block_id: block.id, fire_at: '2026-11-19T17:45:00.000Z', label: 'GO GYM · in 15 min' });
    expect(r.body.alarms[1]).toMatchObject({ fire_at: '2026-11-19T18:00:00.000Z', label: 'GO GYM' });
    expect(r.body.alarms[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('moving changes alarm ids and the version; deleting removes alarms', async () => {
    const b = await mcpCall(ctx, 'add_block', { title: 'Study', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T12:00', alarm_offsets_min: [0] });
    const s1 = (await api(ctx, 'GET', '/api/schedule')).body;
    const moved = await mcpCall(ctx, 'move_block', { id: b.id, start: '2026-11-19T11:00' });
    expect(moved.status).toBe('moved');
    expect(moved.end_local).toBe('2026-11-19 13:00');
    const s2 = (await api(ctx, 'GET', '/api/schedule')).body;
    expect(s2.version).not.toBe(s1.version);
    expect(s2.alarms[0].id).not.toBe(s1.alarms[0].id);
    expect(s2.alarms[0].fire_at).toBe('2026-11-19T11:00:00.000Z');
    await mcpCall(ctx, 'delete_block', { id: b.id });
    expect((await api(ctx, 'GET', '/api/schedule')).body.alarms).toHaveLength(0);
  });

  it('same schedule gives the same version and alarm ids (stable diffing)', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Work', category: 'work', start: '2026-11-19T13:00', end: '2026-11-19T17:00' });
    const a = (await api(ctx, 'GET', '/api/schedule')).body;
    const b = (await api(ctx, 'GET', '/api/schedule')).body;
    expect(a.version).toBe(b.version);
    expect(a.alarms.map((x: any) => x.id)).toEqual(b.alarms.map((x: any) => x.id));
  });

  it('does not book alarms in the past or beyond the window', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Past', category: 'other', start: '2026-11-19T07:00', end: '2026-11-19T07:30' });
    await mcpCall(ctx, 'add_block', { title: 'Far', category: 'other', start: '2026-11-25T07:00', end: '2026-11-25T07:30' });
    expect((await api(ctx, 'GET', '/api/schedule')).body.alarms).toHaveLength(0);
  });
});

describe('events', () => {
  it('accepts single, array and {events} bodies and dedupes client_id', async () => {
    const one = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' }, source: 'shortcut' });
    expect(one.body.inserted).toBe(1);
    const arr = await api(ctx, 'POST', '/api/events', [
      { type: 'alarm_fired', client_id: 'abc' },
      { type: 'alarm_fired', client_id: 'abc' },
    ]);
    expect(arr.body).toMatchObject({ received: 2, inserted: 1, duplicates: 1 });
    const again = await api(ctx, 'POST', '/api/events', { events: [{ type: 'alarm_fired', client_id: 'abc' }] });
    expect(again.body.inserted).toBe(0);
  });

  it('rejects unknown event types', async () => {
    expect((await api(ctx, 'POST', '/api/events', { type: 'nope' })).status).toBe(400);
  });

  it('check-ins update block status and stop its alarms', async () => {
    const b = await mcpCall(ctx, 'add_block', { title: 'Lecture', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T11:00', alarm_offsets_min: [-15, 0] });
    ctx.setNow('2026-11-19T09:46:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'checkin', block_id: b.id, payload: { action: 'on_it' }, client_id: 'c1' });
    const s = (await api(ctx, 'GET', '/api/schedule')).body;
    expect(s.blocks.find((x: any) => x.id === b.id).status).toBe('done');
    expect(s.alarms).toHaveLength(0);
    const events = await mcpCall(ctx, 'get_events', { since: '2026-11-19T00:00', type: 'checkin' });
    expect(events).toHaveLength(1);
    expect(events[0].payload.action).toBe('on_it');
  });

  it('skip records the reason as a note', async () => {
    const b = await mcpCall(ctx, 'add_block', { title: 'Gym', category: 'gym', start: '2026-11-19T18:00', end: '2026-11-19T19:00' });
    await api(ctx, 'POST', '/api/events', { type: 'checkin', block_id: b.id, payload: { action: 'skip', reason: 'ill' } });
    const notes = await mcpCall(ctx, 'get_notes', {});
    expect(notes.at(-1).text).toContain('ill');
    expect((await mcpCall(ctx, 'get_today')).blocks[0].status).toBe('skipped');
  });

  it('arriving at the required place marks the block done', async () => {
    await mcpCall(ctx, 'upsert_place', { name: 'Gym', lat: 51.5, lng: -0.1 });
    const b = await mcpCall(ctx, 'add_block', { title: 'Gym', category: 'gym', start: '2026-11-19T18:00', end: '2026-11-19T19:00', required_place: 'gym' });
    ctx.setNow('2026-11-19T17:50:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'place_enter', payload: { place: 'gym' } });
    expect(r.body.changes[0]).toContain('done');
    expect((await mcpCall(ctx, 'get_today')).blocks.find((x: any) => x.id === b.id).status).toBe('done');
  });
});

describe('status + places', () => {
  it('status shows current/next block and last sync', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Now', category: 'work', start: '2026-11-19T07:30', end: '2026-11-19T09:00' });
    await mcpCall(ctx, 'add_block', { title: 'Next', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T11:00' });
    await api(ctx, 'GET', '/api/schedule');
    const s = (await api(ctx, 'GET', '/api/status')).body;
    expect(s.current_block.title).toBe('Now');
    expect(s.next_block.title).toBe('Next');
    expect(s.last_phone_sync.minutes_ago).toBe(0);
  });
  it('places endpoint lists upserted places', async () => {
    await mcpCall(ctx, 'upsert_place', { name: 'KCL Strand', lat: 51.5115, lng: -0.116, radius_m: 200 });
    const r = await api(ctx, 'GET', '/api/places');
    expect(r.body.places).toEqual([{ id: 'kcl_strand', name: 'KCL Strand', lat: 51.5115, lng: -0.116, radius_m: 200 }]);
  });
});
