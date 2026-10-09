import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches, cronMatchesNow, cronMinuteKey, shouldFireCron } from './cron.js';

const d = (s: string) => new Date(s);

describe('parseCron', () => {
  it('parses stars, steps, ranges, lists', () => {
    const f = parseCron('*/15 9-17 * * mon-fri');
    expect(f.minutes.has(0) && f.minutes.has(45) && !f.minutes.has(7)).toBe(true);
    expect(f.hours.has(9) && f.hours.has(17) && !f.hours.has(8)).toBe(true);
    expect([...f.dows].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
  it('accepts month names and sunday as 0 or 7', () => {
    const f = parseCron('0 0 1 jan-dec sun');
    expect(f.months.size).toBe(12);
    expect(f.dows.has(0) || f.dows.has(7)).toBe(true);
  });
  it('rejects bad shapes', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('9-8 * * * *')).toThrow(/range/);
    expect(() => parseCron('nope * * * *')).toThrow(/bad cron/);
  });
});

describe('cronMatches', () => {
  it('matches daily midnight', () => {
    const f = parseCron('0 0 * * *');
    expect(cronMatches(f, d('2026-05-04T00:00:00'))).toBe(true);
    expect(cronMatches(f, d('2026-05-04T00:01:00'))).toBe(false);
  });
  it('matches every-5-minutes', () => {
    const f = parseCron('*/5 * * * *');
    expect(cronMatches(f, d('2026-05-04T09:35:00'))).toBe(true);
    expect(cronMatches(f, d('2026-05-04T09:36:00'))).toBe(false);
  });
  it('matches weekday mornings only', () => {
    const f = parseCron('30 9 * * mon-fri');
    expect(cronMatches(f, d('2026-05-04T09:30:00'))).toBe(true); // Monday
    expect(cronMatches(f, d('2026-05-09T09:30:00'))).toBe(false); // Saturday
  });
  it('treats restricted dom+dow as either-may-match', () => {
    const f = parseCron('0 12 1 * sun');
    expect(cronMatches(f, d('2026-02-01T12:00:00'))).toBe(true); // 1st AND Sunday
    expect(cronMatches(f, d('2026-03-01T12:00:00'))).toBe(true); // 1st, not Sunday
    expect(cronMatches(f, d('2026-02-08T12:00:00'))).toBe(true); // Sunday, not 1st
    expect(cronMatches(f, d('2026-02-03T12:00:00'))).toBe(false); // neither
  });
});

describe('shouldFireCron', () => {
  it('fires once per matching minute, never on invalid expr', () => {
    const now = d('2026-05-04T09:30:00');
    expect(shouldFireCron('30 9 * * *', undefined, now)).toBe(true);
    expect(shouldFireCron('30 9 * * *', cronMinuteKey(now), now)).toBe(false);
    expect(shouldFireCron('31 9 * * *', undefined, now)).toBe(false);
    expect(shouldFireCron('', undefined, now)).toBe(false);
    expect(shouldFireCron('bogus', undefined, now)).toBe(false);
  });
  it('cronMatchesNow never throws', () => {
    expect(cronMatchesNow('bogus', new Date())).toBe(false);
  });
});
