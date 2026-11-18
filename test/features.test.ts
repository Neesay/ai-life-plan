import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeCtx, mcpCall, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeCtx('2026-11-19T08:00:00Z'); // Thu 08:00 London
});

const actionsOf = (r: any, prefix: string): string[] => (r.body.rule_actions ?? r.body.actions).filter((a: string) => a.startsWith(prefix));

describe('quiet blocks and notification alerts', () => {
  it('a block can use a notification instead of an alarm', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Lecture', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T11:00', alarm_offsets_min: [-5], alert: 'notification', quiet: true });
    const s = (await api(ctx, 'GET', '/api/schedule')).body;
    expect(s.alarms).toHaveLength(1);
    expect(s.alarms[0]).toMatchObject({ alert: 'notification', quieted: false, label: 'LECTURE · in 5 min' });
  });

  it('alarms that fall inside a quiet block are downgraded', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Lecture', category: 'uni', start: '2026-11-19T10:00', end: '2026-11-19T12:00', alarm_offsets_min: [], quiet: true });
    await mcpCall(ctx, 'add_block', { title: 'Call mum', category: 'other', start: '2026-11-19T11:00', end: '2026-11-19T11:10', alarm_offsets_min: [0] });
    await mcpCall(ctx, 'add_block', { title: 'Lunch', category: 'other', start: '2026-11-19T12:00', end: '2026-11-19T12:30', alarm_offsets_min: [0] });
    const alarms = (await api(ctx, 'GET', '/api/schedule')).body.alarms;
    expect(alarms.find((a: any) => a.label === 'CALL MUM')).toMatchObject({ alert: 'notification', quieted: true });
    expect(alarms.find((a: any) => a.label === 'LUNCH')).toMatchObject({ alert: 'alarm', quieted: false });
  });

  it('rule alarms during a lecture become notifications', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Lecture', category: 'uni', start: '2026-11-19T09:00', end: '2026-11-19T11:00', alarm_offsets_min: [], quiet: true });
    ctx.setNow('2026-11-19T09:30:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' } });
    const nag = (await api(ctx, 'GET', '/api/schedule')).body.alarms.find((a: any) => a.label.startsWith('BACK TO WORK'));
    expect(nag).toMatchObject({ alert: 'notification', quieted: true });
  });

  it("alert 'none' books nothing", async () => {
    await mcpCall(ctx, 'add_block', { title: 'Free', category: 'other', start: '2026-11-19T10:00', end: '2026-11-19T11:00', alert: 'none' });
    expect((await api(ctx, 'GET', '/api/schedule')).body.alarms).toHaveLength(0);
  });

  it('template items carry alert and quiet', async () => {
    await mcpCall(ctx, 'set_week_template', { days: { fri: [{ title: 'NLP', category: 'uni', start: '14:00', end: '16:00', alert: 'notification', quiet: true }] } });
    const s = await mcpCall(ctx, 'get_schedule', { from: '2026-11-20T00:00', to: '2026-11-21T00:00' });
    expect(s.blocks[0]).toMatchObject({ alert: 'notification', quiet: true });
  });
});

describe('solo_gaming', () => {
  it('fires for games outside play blocks, not during them', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Friends', category: 'play', start: '2026-11-19T17:00', end: '2026-11-19T20:00', alarm_offsets_min: [] });
    ctx.setNow('2026-11-19T17:30:00Z');
    expect(actionsOf(await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Valorant', kind: 'game' } }), 'solo')).toEqual([]);
    ctx.setNow('2026-11-19T21:00:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Valorant', kind: 'game' } });
    expect(actionsOf(r, 'solo')).toEqual(['solo gaming: Valorant']);
    const nag = (await api(ctx, 'GET', '/api/schedule')).body.alarms.find((a: any) => a.label.startsWith('STOP'));
    expect(nag).toMatchObject({ label: 'STOP — NO SOLO GAMING', alert: 'alarm', fire_at: '2026-11-19T21:01:00.000Z' });
  });

  it('ignores social apps and focus blocks (handled by distraction rule)', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Study', category: 'uni', start: '2026-11-19T09:00', end: '2026-11-19T12:00' });
    ctx.setNow('2026-11-19T09:10:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Valorant', kind: 'game' } });
    expect(actionsOf(r, 'solo')).toEqual([]);
    expect(actionsOf(r, 'distraction')).toHaveLength(1);
    ctx.setNow('2026-11-19T13:00:00Z');
    expect(actionsOf(await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' } }), 'solo')).toEqual([]);
  });
});

describe('play_limit excludes friend time', () => {
  it('only counts minutes outside play blocks', async () => {
    await mcpCall(ctx, 'set_rule', { name: 'play_limit', condition: { limit_min: 30, exclude_play_blocks: true } });
    await mcpCall(ctx, 'add_block', { title: 'Friends', category: 'play', start: '2026-11-19T17:00', end: '2026-11-19T20:00', alarm_offsets_min: [] });
    ctx.setNow('2026-11-19T17:00:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'G', kind: 'game' } });
    ctx.setNow('2026-11-19T19:50:00Z');
    expect(actionsOf(await api(ctx, 'POST', '/api/events', { type: 'app_close', payload: { app: 'G', kind: 'game' } }), 'play limit')).toEqual([]);
    ctx.setNow('2026-11-19T20:10:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' } });
    ctx.setNow('2026-11-19T20:45:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_close', payload: { app: 'TikTok', kind: 'social' } });
    expect(actionsOf(r, 'play limit')).toEqual(['play limit: 35/30 min']);
  });
});

describe('steps', () => {
  it('evening check nudges with a notification when under goal, once per day', async () => {
    ctx.setNow('2026-11-19T20:00:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'steps', payload: { count: 6500 }, source: 'shortcut' });
    expect(actionsOf(await api(ctx, 'POST', '/api/tick'), 'steps')).toEqual([]); // before 20:30
    ctx.setNow('2026-11-19T20:31:00Z');
    expect(actionsOf(await api(ctx, 'POST', '/api/tick'), 'steps')).toEqual(['steps: 6500/10000']);
    expect(actionsOf(await api(ctx, 'POST', '/api/tick'), 'steps')).toEqual([]);
    const nag = (await api(ctx, 'GET', '/api/schedule')).body.alarms.find((a: any) => a.label.startsWith('WALK'));
    expect(nag).toMatchObject({ label: 'WALK — 3,500 STEPS TO GO', alert: 'notification' });
    expect((await mcpCall(ctx, 'get_today')).steps_today).toBe(6500);
    expect((await mcpCall(ctx, 'get_summary', {})).steps_by_day['2026-11-19']).toBe(6500);
  });

  it('stays quiet when the goal is met', async () => {
    ctx.setNow('2026-11-19T20:40:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'steps', payload: { count: 11200 } });
    expect(actionsOf(r, 'steps')).toEqual([]);
  });
});

describe('steps posted after the check time', () => {
  it('fires immediately on the same request', async () => {
    ctx.setNow('2026-11-19T21:00:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'steps', payload: { count: 4000 } });
    expect(actionsOf(r, 'steps')).toEqual(['steps: 4000/10000']);
  });
});
