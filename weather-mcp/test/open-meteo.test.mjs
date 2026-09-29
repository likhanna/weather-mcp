import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenMeteoRiskService, WeatherDataError } from '../src/open-meteo.ts';

const location = { id: 1, name: 'Dubai', country: 'United Arab Emirates', timezone: 'Asia/Dubai', latitude: 25.2, longitude: 55.3 };
const forecast = {
  timezone: 'GMT',
  hourly_units: { wind_speed_10m: 'm/s' },
  hourly: {
    time: ['2026-09-23T13:00', '2026-09-23T14:00'],
    temperature_2m: [33, 34],
    precipitation_probability: [0, 70],
    wind_speed_10m: [3, 4]
  }
};
const request = { city: 'Dubai, United Arab Emirates', start_at: '2026-09-23T16:00', work_type: 'maintenance', duration_hours: 2 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('service uses hourly API, location timezone, highest risk and ten-minute cache', async () => {
  let now = new Date('2026-09-23T12:00:00.000Z');
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(url.toString());
    return response(url.hostname.startsWith('geocoding')
      ? { results: [location, { ...location, id: 2, name: 'Dubai Marina' }] }
      : forecast);
  };
  const service = new OpenMeteoRiskService(fetchMock, () => now);
  const first = await service.assess(request);
  assert.equal(first.kind, 'assessment');
  assert.equal(first.location.timezone, 'Asia/Dubai');
  assert.equal(first.risk_level, 'HIGH');
  assert.equal(first.recommendation, 'CANCEL');
  assert.equal(first.hourly_weather.length, 2);
  assert.equal(first.source, 'Open-Meteo');
  assert.match(urls[1], /wind_speed_unit=ms/);
  assert.match(urls[1], /timezone=UTC/);
  await service.assess(request);
  assert.equal(urls.length, 2);
  now = new Date('2026-09-23T12:10:00.000Z');
  await service.assess(request);
  assert.equal(urls.length, 4);
});

test('ambiguous city returns at most five options and makes no forecast request', async () => {
  let calls = 0;
  const service = new OpenMeteoRiskService(async () => {
    calls++;
    return response({ results: Array.from({ length: 6 }, (_, id) => ({ ...location, id })) });
  }, () => new Date('2026-09-23T12:00:00.000Z'));
  const result = await service.assess(request);
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.options.length, 5);
  assert.equal(calls, 1);
});

test('region and country qualifier resolve an otherwise ambiguous city', async () => {
  const places = [
    { ...location, id: 11, name: 'Springfield', admin1: 'Illinois', country: 'United States' },
    { ...location, id: 12, name: 'Springfield', admin1: 'Missouri', country: 'United States' }
  ];
  let calls = 0;
  const service = new OpenMeteoRiskService(async (url) => {
    calls++;
    return response(url.hostname.startsWith('geocoding') ? { results: places } : forecast);
  }, () => new Date('2026-09-23T12:00:00.000Z'));
  const ambiguous = await service.assess({ ...request, city: 'Springfield' });
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(ambiguous.options.length, 2);
  const selected = await service.assess({ ...request, city: 'Springfield, Illinois, United States' });
  assert.equal(selected.kind, 'assessment');
  assert.equal(selected.location.region, 'Illinois');
  assert.equal(calls, 3);
});

test('missing hour, bad units, HTTP error, bad JSON and timeout return controlled errors', async () => {
  const now = () => new Date('2026-09-23T12:00:00.000Z');
  const badForecasts = [
    { ...forecast, hourly: { ...forecast.hourly, time: ['2026-09-23T13:00'], temperature_2m: [33], precipitation_probability: [0], wind_speed_10m: [3] } },
    { ...forecast, hourly_units: { wind_speed_10m: 'km/h' } }
  ];
  for (const bad of badForecasts) {
    const service = new OpenMeteoRiskService(async (url) => response(url.hostname.startsWith('geocoding') ? { results: [location] } : bad), now);
    await assert.rejects(service.assess(request), WeatherDataError);
  }
  const httpError = new OpenMeteoRiskService(async () => response({}, 503), now);
  await assert.rejects(httpError.assess(request), /временно недоступен/);
  const badJson = new OpenMeteoRiskService(async () => new Response('{invalid'), now);
  await assert.rejects(badJson.assess(request), /временно недоступен/);
  const timeout = new OpenMeteoRiskService(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), now);
  await assert.rejects(timeout.assess(request), /временно недоступен/);
});

test('not found has no made-up weather', async () => {
  const service = new OpenMeteoRiskService(async () => response({}), () => new Date('2026-09-23T12:00:00.000Z'));
  const result = await service.assess(request);
  assert.equal(result.kind, 'not_found');
  assert.equal('hourly_weather' in result, false);
});

test('risk cache normalizes city, isolates request parameters and expires without sliding', async () => {
  let now = new Date('2026-09-23T12:00:00.000Z');
  let calls = 0;
  const service = new OpenMeteoRiskService(async (url) => {
    calls++;
    return response(url.hostname.startsWith('geocoding') ? { results: [location] } : forecast);
  }, () => now);
  const base = { ...request, city: '  DUBAI  ,  United   Arab Emirates  ' };
  const first = await service.assess(base);
  assert.equal(first.kind, 'assessment');
  assert.equal(calls, 2);
  assert.equal((await service.assess({ ...base, city: 'dubai,united arab emirates' })).fetched_at, first.fetched_at);
  assert.equal(calls, 2);
  now = new Date('2026-09-23T12:09:59.999Z');
  assert.equal((await service.assess(base)).fetched_at, first.fetched_at);
  assert.equal(calls, 2);
  now = new Date('2026-09-23T12:10:00.000Z');
  const refreshed = await service.assess(base);
  assert.equal(calls, 4);
  assert.notEqual(refreshed.fetched_at, first.fetched_at);
  for (const variant of [
    { work_type: 'inspection' },
    { duration_hours: 1 },
    { start_at: '2026-09-23T17:00', duration_hours: 1 }
  ]) {
    assert.equal((await service.assess({ ...base, ...variant })).kind, 'assessment');
  }
  assert.equal(calls, 10);
});

test('risk does not cache not_found or ambiguous, and can recover', async () => {
  let geocoding = {};
  let calls = 0;
  const service = new OpenMeteoRiskService(async (url) => {
    calls++;
    return response(url.hostname.startsWith('geocoding') ? geocoding : forecast);
  }, () => new Date('2026-09-23T12:00:00.000Z'));
  assert.equal((await service.assess(request)).kind, 'not_found');
  geocoding = { results: [] };
  assert.equal((await service.assess(request)).kind, 'not_found');
  geocoding = { results: [{ ...location, id: 1 }, { ...location, id: 2 }] };
  assert.equal((await service.assess(request)).kind, 'ambiguous');
  assert.equal(calls, 3);
  geocoding = { results: [location] };
  assert.equal((await service.assess(request)).kind, 'assessment');
  assert.equal(calls, 5);
  await service.assess(request);
  assert.equal(calls, 5);
});

test('risk retries after external failure and rejects expired work period before cache lookup', async () => {
  let now = new Date('2026-09-23T12:00:00.000Z');
  let fail = true;
  let calls = 0;
  const service = new OpenMeteoRiskService(async (url) => {
    calls++;
    if (!url.hostname.startsWith('geocoding') && fail) return response({}, 503);
    return response(url.hostname.startsWith('geocoding') ? { results: [location] } : forecast);
  }, () => now);
  await assert.rejects(service.assess(request), /временно недоступен/);
  assert.equal(calls, 2);
  fail = false;
  assert.equal((await service.assess(request)).kind, 'assessment');
  assert.equal(calls, 4);
  now = new Date('2026-09-23T13:00:01.000Z');
  await assert.rejects(service.assess(request), /раньше текущего момента/);
  assert.equal(calls, 4);
});
