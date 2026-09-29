import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/index.ts';
import { OpenMeteoRiskService, WeatherDataError } from '../src/open-meteo.ts';
import { generateCandidateWindows, InputError, parseSearchInterval } from '../src/time.ts';
import { rankWeatherWindows } from '../src/weather-windows.ts';

const HOUR_MS = 60 * 60 * 1000;
const MOSCOW_OFFSET_MS = 3 * HOUR_MS;
const fixedNow = new Date('2026-09-27T12:00:00.000Z');
const fixedClock = () => new Date(fixedNow);
const location = {
  id: 1,
  name: 'Dubai',
  admin1: 'Dubai',
  country: 'United Arab Emirates',
  timezone: 'Asia/Dubai',
  latitude: 25.2,
  longitude: 55.3,
};
const args = {
  city: 'Dubai, United Arab Emirates',
  work_type: 'maintenance',
  search_start: '2026-09-27T16:00',
  search_end: '2026-09-27T20:00',
  duration_hours: 1,
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

function hourlyForecast(firstUtcMs, count, weatherAt = () => ({ temperature_2m: 25, precipitation_probability: 0, wind_speed_10m: 3 })) {
  const hours = Array.from({ length: count }, (_, index) => {
    const date = new Date(firstUtcMs + index * HOUR_MS);
    return {
      time: date.toISOString().slice(0, 16),
      ...weatherAt(index, date),
    };
  });
  return {
    timezone: 'GMT',
    utc_offset_seconds: 0,
    hourly_units: { wind_speed_10m: 'm/s' },
    hourly: {
      time: hours.map(({ time }) => time),
      temperature_2m: hours.map(({ temperature_2m }) => temperature_2m),
      precipitation_probability: hours.map(({ precipitation_probability }) => precipitation_probability),
      wind_speed_10m: hours.map(({ wind_speed_10m }) => wind_speed_10m),
    },
  };
}

function utcForMoscow(value) {
  const [datePart, timePart] = value.split('T');
  return Date.parse(`${datePart}T${timePart}:00Z`) - MOSCOW_OFFSET_MS;
}

async function withClient(service, check, now = fixedClock) {
  const server = createServer(service, { now });
  const client = new Client({ name: 'find-safe-weather-window-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('search interval enforces Moscow format, a single now snapshot, and five-day boundary', () => {
  const interval = parseSearchInterval(
    '2026-09-27T15:00',
    '2026-10-02T15:00',
    fixedNow,
  );
  assert.equal(interval.start.toISOString(), fixedNow.toISOString());
  assert.equal(interval.end.toISOString(), '2026-10-02T12:00:00.000Z');
  assert.throws(() => parseSearchInterval('2026-09-27T14:59', '2026-09-27T16:00', fixedNow), InputError);
  assert.throws(() => parseSearchInterval('2026-09-27T15:00', '2026-09-27T14:59', fixedNow), InputError);
  assert.throws(() => parseSearchInterval('2026-02-30T15:00', '2026-03-01T15:00', fixedNow), InputError);
  assert.throws(() => parseSearchInterval('2026-09-27 15:00', '2026-09-27T16:00', fixedNow), InputError);
  assert.throws(() => parseSearchInterval('2026-09-27T15:00', '2026-10-02T15:01', fixedNow), /пяти суток/);
});

test('candidate generation rounds up to full Moscow hours and permits exact end equality', () => {
  const interval = parseSearchInterval('2026-09-27T16:30', '2026-09-27T20:00', fixedNow);
  const windows = generateCandidateWindows(interval, 2);
  assert.deepEqual(windows.map(({ start_at, end_at }) => [start_at, end_at]), [
    ['2026-09-27T17:00', '2026-09-27T19:00'],
    ['2026-09-27T18:00', '2026-09-27T20:00'],
  ]);
  assert.throws(() => generateCandidateWindows(
    parseSearchInterval('2026-09-27T16:30', '2026-09-27T18:59', fixedNow),
    2,
  ), /нет подходящих/);
  for (const invalid of [0, 9, 1.5, Number.NaN]) {
    assert.throws(() => generateCandidateWindows(interval, invalid), InputError);
  }
});

test('seeded generative oracle checks at least 1000 intervals and candidate uniqueness', () => {
  let seed = 0x51afe;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const base = Date.parse('2026-09-27T12:00:00.000Z');
  for (let iteration = 0; iteration < 1000; iteration++) {
    const startMs = base + random(5 * 24 * 60) * 60_000;
    const endMs = startMs + random(24 * 60) * 60_000;
    const duration = 1 + random(8);
    const interval = { start: new Date(startMs), end: new Date(endMs) };
    let firstAligned = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
    const oracle = [];
    for (let candidateMs = firstAligned; candidateMs + duration * HOUR_MS <= endMs; candidateMs += HOUR_MS) {
      oracle.push(candidateMs);
    }
    let actual;
    try {
      actual = generateCandidateWindows(interval, duration);
    } catch (error) {
      assert.ok(error instanceof InputError);
      assert.equal(oracle.length, 0);
      continue;
    }
    assert.deepEqual(actual.map(({ start }) => start.getTime()), oracle);
    assert.equal(new Set(actual.map(({ start }) => start.getTime())).size, actual.length);
    for (const window of actual) {
      assert.equal(window.start.getTime() % HOUR_MS, 0);
      assert.ok(window.start.getTime() >= startMs);
      assert.ok(window.end.getTime() <= endMs);
      assert.equal(window.end.getTime() - window.start.getTime(), duration * HOUR_MS);
    }
  }
});

test('ranking is risk, then factor count, then earliest start and is permutation invariant', () => {
  const candidates = [
    { start_at: 'late', start_utc_ms: 30, risk_level: 'MEDIUM', factors: [{}, {}] },
    { start_at: 'high', start_utc_ms: 10, risk_level: 'HIGH', factors: [] },
    { start_at: 'early', start_utc_ms: 20, risk_level: 'MEDIUM', factors: [{}] },
    { start_at: 'low', start_utc_ms: 40, risk_level: 'LOW', factors: [] },
  ];
  const expected = ['low', 'early', 'late', 'high'];
  assert.deepEqual(rankWeatherWindows(candidates).map(({ start_at }) => start_at), expected);
  assert.deepEqual(rankWeatherWindows([...candidates].reverse()).map(({ start_at }) => start_at), expected);
});

test('service uses one forecast, returns stable metadata and the best four unique windows', async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    if (url.hostname.startsWith('geocoding')) return jsonResponse({ results: [location] });
    return jsonResponse(hourlyForecast(utcForMoscow('2026-09-27T16:00'), 4, (index) => {
      if (index === 0) return { temperature_2m: 20, precipitation_probability: 40, wind_speed_10m: 3 };
      if (index === 1) return { temperature_2m: 20, precipitation_probability: 70, wind_speed_10m: 3 };
      if (index === 2) return { temperature_2m: 20, precipitation_probability: 40, wind_speed_10m: 10 };
      return { temperature_2m: 20, precipitation_probability: 0, wind_speed_10m: 3 };
    }));
  };
  const service = new OpenMeteoRiskService(fetchMock, fixedClock);
  const result = await service.findSafeWeatherWindow(args);
  assert.equal(result.kind, 'search_result');
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((url) => url.hostname === 'api.open-meteo.com').length, 1);
  assert.equal(calls[1].searchParams.get('forecast_days'), '6');
  assert.deepEqual(calls[1].searchParams.get('hourly').split(','), [
    'temperature_2m', 'precipitation_probability', 'wind_speed_10m'
  ]);
  assert.deepEqual(result.selected_window, {
    start_at: '2026-09-27T19:00',
    end_at: '2026-09-27T20:00',
    duration_hours: 1,
    risk_level: 'LOW',
    recommendation: 'PROCEED',
    factors: [],
  });
  assert.deepEqual(result.alternatives.map(({ start_at }) => start_at), [
    '2026-09-27T16:00', '2026-09-27T18:00', '2026-09-27T17:00'
  ]);
  assert.equal(result.alternatives[0].risk_level, 'MEDIUM');
  assert.equal(result.alternatives[0].factors.length, 1);
  assert.equal(result.alternatives[1].factors.length, 2);
  assert.equal(result.candidates_checked, 4);
  assert.deepEqual(result.location, {
    city: 'Dubai', region: 'Dubai', country: 'United Arab Emirates', timezone: 'Asia/Dubai'
  });
  assert.equal(result.work_type, 'maintenance');
  assert.equal(result.source, 'Open-Meteo');
  assert.equal(result.fetched_at, fixedNow.toISOString());
});

test('minute search endpoints require only buckets belonging to full candidate windows', async () => {
  const minuteArgs = { ...args, search_start: '2026-09-27T16:30', search_end: '2026-09-27T19:00', duration_hours: 2 };
  const requests = [];
  const service = new OpenMeteoRiskService(async (url) => {
    requests.push(url);
    return jsonResponse(url.hostname.startsWith('geocoding')
      ? { results: [location] }
      : hourlyForecast(utcForMoscow('2026-09-27T17:00'), 2));
  }, fixedClock);
  const result = await service.findSafeWeatherWindow(minuteArgs);
  assert.equal(result.kind, 'search_result');
  assert.equal(result.candidates_checked, 1);
  assert.equal(result.selected_window.start_at, '2026-09-27T17:00');
  assert.equal(requests.length, 2);
});

test('maximal now+5d horizon requests and validates the last required hour', async () => {
  const horizonArgs = {
    ...args,
    search_start: '2026-09-27T15:00',
    search_end: '2026-10-02T15:00',
    duration_hours: 8,
  };
  let forecastRequest;
  const service = new OpenMeteoRiskService(async (url) => {
    if (url.hostname.startsWith('geocoding')) return jsonResponse({ results: [location] });
    forecastRequest = url;
    return jsonResponse(hourlyForecast(fixedNow.getTime(), 120));
  }, fixedClock);
  const result = await service.findSafeWeatherWindow(horizonArgs);
  assert.equal(result.kind, 'search_result');
  assert.equal(forecastRequest.searchParams.get('forecast_days'), '6');
  assert.equal(result.candidates_checked, 113);
  assert.equal(result.selected_window.factors.length, 0);

  const missingLastHour = new OpenMeteoRiskService(async (url) => jsonResponse(
    url.hostname.startsWith('geocoding')
      ? { results: [location] }
      : hourlyForecast(fixedNow.getTime(), 119),
  ), fixedClock);
  await assert.rejects(missingLastHour.findSafeWeatherWindow(horizonArgs), WeatherDataError);
});

test('unknown and ambiguous cities stop before forecast; zero candidates stop before geocoding', async () => {
  let forecastCalls = 0;
  for (const results of [[], [location, { ...location, id: 2 }]]) {
    const service = new OpenMeteoRiskService(async (url) => {
      if (url.hostname.startsWith('geocoding')) return jsonResponse({ results });
      forecastCalls++;
      return jsonResponse(hourlyForecast(utcForMoscow('2026-09-27T16:00'), 4));
    }, fixedClock);
    const result = await service.findSafeWeatherWindow(args);
    assert.equal(result.kind, results.length === 0 ? 'not_found' : 'ambiguous');
  }
  assert.equal(forecastCalls, 0);

  let calls = 0;
  const noCandidates = new OpenMeteoRiskService(async () => { calls++; throw new Error('should not fetch'); }, fixedClock);
  await assert.rejects(noCandidates.findSafeWeatherWindow({
    ...args, search_start: '2026-09-27T16:00', search_end: '2026-09-27T16:59', duration_hours: 1
  }), /нет подходящих/);
  assert.equal(calls, 0);
});

test('forecast errors and missing final bucket never return partial results', async () => {
  for (const failForecast of [
    async () => { throw new Error('offline'); },
    async () => jsonResponse({}, 503),
    async () => new Response('{invalid'),
    async () => jsonResponse({ error: true }),
    async () => jsonResponse(hourlyForecast(utcForMoscow('2026-09-27T16:00'), 3)),
  ]) {
    const service = new OpenMeteoRiskService(async (url) =>
      url.hostname.startsWith('geocoding')
        ? jsonResponse({ results: [location] })
        : failForecast(),
    fixedClock);
    await assert.rejects(service.findSafeWeatherWindow(args), WeatherDataError);
  }
});

test('MCP tool has strict input, stable success structuredContent, and controlled errors', async () => {
  const fetchMock = async (url) => jsonResponse(url.hostname.startsWith('geocoding')
    ? { results: [location] }
    : hourlyForecast(utcForMoscow('2026-09-27T16:00'), 4));
  const service = new OpenMeteoRiskService(fetchMock, fixedClock);
  await withClient(service, async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
      'assess_weather_risk', 'compare_weather_windows', 'find_safe_weather_window', 'get_weather'
    ]);
    const result = await client.callTool({ name: 'find_safe_weather_window', arguments: args });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.candidates_checked, 4);
    assert.equal(result.structuredContent.alternatives.length, 3);
    assert.equal('kind' in result.structuredContent, false);

    for (const invalidArgs of [
      { ...args, duration_hours: 1.5 },
      { ...args, duration_hours: 9 },
      { ...args, extra: true },
      { ...args, work_type: 'other' },
    ]) {
      const invalid = await client.callTool({ name: 'find_safe_weather_window', arguments: invalidArgs });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent, undefined);
    }
  });
});
