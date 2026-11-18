import { describe, expect, it } from 'vitest';
import { addDays, formatLondon, isoWeekday, londonDate, parseTime } from '../src/time.js';

describe('London time', () => {
  it('reads offset-less times as London wall clock (GMT in winter)', () => {
    expect(parseTime('2026-11-19T09:00').toISOString()).toBe('2026-11-19T09:00:00.000Z');
  });
  it('reads offset-less times as London wall clock (BST in summer)', () => {
    expect(parseTime('2026-07-01T09:00').toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });
  it('respects explicit offsets', () => {
    expect(parseTime('2026-07-01T09:00:00Z').toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(parseTime('2026-07-01T09:00:00+02:00').toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });
  it('handles DST change days', () => {
    // Clocks go forward 29 Mar 2026 at 01:00 GMT.
    expect(parseTime('2026-03-29T00:30').toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(parseTime('2026-03-29T03:00').toISOString()).toBe('2026-03-29T02:00:00.000Z');
  });
  it('formats and computes days', () => {
    expect(formatLondon(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02 00:30');
    expect(londonDate(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoWeekday('2026-11-23')).toBe(1); // Monday
    expect(isoWeekday('2026-11-22')).toBe(7); // Sunday
  });
  it('rejects junk', () => {
    expect(() => parseTime('tomorrow')).toThrow();
  });
});
