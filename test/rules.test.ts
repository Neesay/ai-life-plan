import { beforeEach, describe, expect, it } from 'vitest';
import { distractionMinutes } from '../src/rules.js';
import type { EventRow } from '../src/store.js';
import { api, makeCtx, mcpCall, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await makeCtx('2026-11-19T08:00:00Z');
});

const tick = () => api(ctx, 'POST', '/api/tick');
const distractions = (r: any): string[] => r.body.rule_actions.filter((a: string) => a.startsWith('distraction'));

describe('late_for_place', () => {
  it('fires once when not at the required place 20 min after start', async () => {
    await mcpCall(ctx, 'upsert_place', { name: 'Gym', lat: 51.5, lng: -0.1 });
    await mcpCall(ctx, 'add_block', { title: 'Gym', category: 'gym', start: '2026-11-19T09:00', end: '2026-11-19T10:00', required_place: 'gym' });
    ctx.setNow('2026-11-19T09:15:00Z');
    expect((await tick()).body.actions).toEqual([]);
    ctx.setNow('2026-11-19T09:21:00Z');
    expect((await tick()).body.actions).toEqual(['late: Gym']);
    expect((await tick()).body.actions).toEqual([]);
    const s = (await api(ctx, 'GET', '/api/schedule')).body;
    const nag = s.alarms.find((a: any) => a.label.startsWith('LATE'));
    expect(nag.label).toBe('LATE — GET TO GYM');
    expect(nag.fire_at).toBe('2026-11-19T09:31:00.000Z');
    const notes = await mcpCall(ctx, 'get_notes', {});
    expect(notes.some((n: any) => n.author === 'system' && n.text.includes('late_for_place'))).toBe(true);
  });
  it('does not fire if already there', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Lecture', category: 'uni', start: '2026-11-19T09:00', end: '2026-11-19T11:00', required_place: 'kcl' });
    // Arrived >30 min before start, so it is not auto-marked done, but we are there.
    await api(ctx, 'POST', '/api/events', { type: 'place_enter', payload: { place: 'kcl' } });
    ctx.setNow('2026-11-19T09:25:00Z');
    expect((await tick()).body.actions).toEqual([]);
  });
});

describe('Phase 4 acceptance: game during a work block gives a back-to-work alarm at next sync', () => {
  it('inserts an alarm 2 min out, with a cooldown', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Coursework', category: 'work', start: '2026-11-19T09:00', end: '2026-11-19T12:00' });
    ctx.setNow('2026-11-19T09:30:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Clash Royale', kind: 'game' }, source: 'shortcut' });
    expect(distractions(r)).toEqual(['distraction: Clash Royale during Coursework']);
    const s = (await api(ctx, 'GET', '/api/schedule')).body;
    const nag = s.alarms.find((a: any) => a.label.startsWith('BACK TO WORK'));
    expect(nag).toMatchObject({ label: 'BACK TO WORK — COURSEWORK', fire_at: '2026-11-19T09:32:00.000Z' });
    ctx.advance(3);
    const r2 = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' } });
    expect(distractions(r2)).toEqual([]); // cooldown
    ctx.advance(10);
    const r3 = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'TikTok', kind: 'social' } });
    expect(distractions(r3)).toHaveLength(1);
  });
  it('ignores games outside focus blocks', async () => {
    await mcpCall(ctx, 'add_block', { title: 'Chill', category: 'play', start: '2026-11-19T09:00', end: '2026-11-19T12:00' });
    ctx.setNow('2026-11-19T09:30:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Clash Royale' } });
    expect(distractions(r)).toEqual([]);
  });
});

describe('no_checkin_missed', () => {
  it('marks missed 30 min after start, extended by snoozes', async () => {
    const a = await mcpCall(ctx, 'add_block', { title: 'Gym', category: 'gym', start: '2026-11-19T09:00', end: '2026-11-19T10:00' });
    const b = await mcpCall(ctx, 'add_block', { title: 'Read', category: 'uni', start: '2026-11-19T09:00', end: '2026-11-19T10:00' });
    ctx.setNow('2026-11-19T09:05:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'checkin', block_id: b.id, payload: { action: 'snooze' } });
    ctx.setNow('2026-11-19T09:31:00Z');
    expect((await tick()).body.actions).toEqual(['missed: Gym']);
    ctx.setNow('2026-11-19T09:46:00Z');
    expect((await tick()).body.actions).toEqual(['missed: Read']);
    const today = await mcpCall(ctx, 'get_today');
    expect(today.blocks.find((x: any) => x.id === a.id).status).toBe('missed');
  });
});

describe('play_limit', () => {
  it('fires once per day when distraction time exceeds the limit', async () => {
    await mcpCall(ctx, 'set_rule', { name: 'play_limit', condition: { limit_min: 30 } });
    ctx.setNow('2026-11-19T10:00:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Game', kind: 'game' } });
    ctx.setNow('2026-11-19T10:25:00Z');
    expect((await api(ctx, 'POST', '/api/events', { type: 'app_close', payload: { app: 'Game', kind: 'game' } })).body.rule_actions).toEqual([]);
    ctx.setNow('2026-11-19T11:00:00Z');
    await api(ctx, 'POST', '/api/events', { type: 'app_open', payload: { app: 'Game', kind: 'game' } });
    ctx.setNow('2026-11-19T11:10:00Z');
    const r = await api(ctx, 'POST', '/api/events', { type: 'app_close', payload: { app: 'Game', kind: 'game' } });
    expect(r.body.rule_actions).toEqual(['play limit: 35/30 min']);
    ctx.setNow('2026-11-19T11:20:00Z');
    expect((await tick()).body.actions).toEqual([]);
  });
  it('rule can be disabled', async () => {
    await mcpCall(ctx, 'set_rule', { name: 'play_limit', enabled: false });
    const rules = await mcpCall(ctx, 'list_rules');
    expect(rules.find((r: any) => r.name === 'play_limit')).toMatchObject({ enabled: false, condition: { limit_min: 120 } });
  });
});

describe('distractionMinutes', () => {
  const ev = (type: string, ts: string, app = 'A'): EventRow => ({ id: ts, ts, ts_local: '', type, block_id: null, payload: { app }, source: 'app', client_id: null });
  it('pairs opens with closes and caps unclosed sessions', () => {
    const noon = new Date('2026-11-19T12:00:00Z');
    expect(distractionMinutes([ev('app_open', '2026-11-19T10:00:00Z'), ev('app_close', '2026-11-19T10:20:00Z')], noon)).toBe(20);
    expect(distractionMinutes([ev('app_open', '2026-11-19T10:00:00Z')], noon)).toBe(30);
    expect(
      distractionMinutes([ev('app_open', '2026-11-19T10:00:00Z'), ev('app_open', '2026-11-19T10:05:00Z', 'B')], new Date('2026-11-19T10:10:00Z')),
    ).toBe(10);
  });
});

describe('summary', () => {
  it('totals planned vs done per category', async () => {
    const g = await mcpCall(ctx, 'add_block', { title: 'Gym', category: 'gym', start: '2026-11-19T09:00', end: '2026-11-19T10:30' });
    await mcpCall(ctx, 'add_block', { title: 'Work', category: 'work', start: '2026-11-19T11:00', end: '2026-11-19T13:00' });
    await api(ctx, 'POST', '/api/events', { type: 'checkin', block_id: g.id, payload: { action: 'on_it' } });
    const s = await mcpCall(ctx, 'get_summary', {});
    expect(s.by_category.gym).toMatchObject({ planned_h: 1.5, done_h: 1.5, done: 1 });
    expect(s.by_category.work).toMatchObject({ planned_h: 2, done_h: 0 });
    expect(s.gym_sessions).toBe(1);
    expect(s.checkins.on_it).toBe(1);
  });
});
