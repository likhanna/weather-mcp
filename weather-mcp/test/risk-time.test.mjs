import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRisk } from '../src/risk.ts';
import { InputError, parseWorkPeriod } from '../src/time.ts';

const hour = (temperature_c, precipitation_probability_percent, wind_speed_ms) => ({
  time: '2026-09-23T13:00:00.000Z', temperature_c, precipitation_probability_percent, wind_speed_ms
});

test('risk thresholds and recommendations use strict temperature bounds', () => {
  const cases = [
    [hour(20, 39, 9.9), 'LOW', 'PROCEED'],
    [hour(20, 40, 9.9), 'MEDIUM', 'REVIEW'],
    [hour(20, 69, 14.9), 'MEDIUM', 'REVIEW'],
    [hour(20, 70, 9.9), 'HIGH', 'CANCEL'],
    [hour(20, 0, 10), 'MEDIUM', 'REVIEW'],
    [hour(20, 0, 15), 'HIGH', 'CANCEL'],
    [hour(-15, 0, 0), 'MEDIUM', 'REVIEW'],
    [hour(-15.1, 0, 0), 'HIGH', 'CANCEL'],
    [hour(-5, 0, 0), 'LOW', 'PROCEED'],
    [hour(-5.1, 0, 0), 'MEDIUM', 'REVIEW'],
    [hour(32, 0, 0), 'LOW', 'PROCEED'],
    [hour(32.1, 0, 0), 'MEDIUM', 'REVIEW'],
    [hour(40, 0, 0), 'MEDIUM', 'REVIEW'],
    [hour(40.1, 0, 0), 'HIGH', 'CANCEL']
  ];
  for (const [weather, expectedRisk, expectedRecommendation] of cases) {
    const result = assessRisk([weather]);
    assert.equal(result.risk_level, expectedRisk);
    assert.equal(result.recommendation, expectedRecommendation);
  }
});

test('highest risk across hours wins and factors identify time and metric', () => {
  const result = assessRisk([
    hour(20, 40, 0),
    { ...hour(20, 0, 15), time: '2026-09-23T14:00:00.000Z' }
  ]);
  assert.equal(result.risk_level, 'HIGH');
  assert.equal(result.recommendation, 'CANCEL');
  assert.deepEqual(result.factors.map(({ time, metric, level }) => [time, metric, level]), [
    ['2026-09-23T13:00:00.000Z', 'precipitation_probability_percent', 'MEDIUM'],
    ['2026-09-23T14:00:00.000Z', 'wind_speed_ms', 'HIGH']
  ]);
});

test('an empty forecast cannot produce LOW/PROCEED', () => {
  assert.throws(() => assessRisk([]), /без почасового прогноза/);
});

test('Moscow time converts to UTC and period must fit the forecast horizon', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const period = parseWorkPeriod('2026-09-23T15:30', 1.5, now);
  assert.equal(period.start.toISOString(), '2026-09-23T12:30:00.000Z');
  assert.equal(period.end.toISOString(), '2026-09-23T14:00:00.000Z');
  assert.equal(parseWorkPeriod('2026-09-28T14:00', 1, now).end.toISOString(), '2026-09-28T12:00:00.000Z');
  assert.throws(() => parseWorkPeriod('2026-09-28T14:01', 1, now), InputError);
  assert.throws(() => parseWorkPeriod('2026-09-23T14:59', 1, now), InputError);
  assert.throws(() => parseWorkPeriod('2026-02-30T15:00', 1, now), InputError);
  assert.throws(() => parseWorkPeriod('2026-09-23T15:00', 0, now), InputError);
  assert.throws(() => parseWorkPeriod('2026-09-23T16:00', 1e-20, now), /слишком мала/);
  assert.throws(() => parseWorkPeriod('2026-09-23 15:00', 1, now), InputError);
});
