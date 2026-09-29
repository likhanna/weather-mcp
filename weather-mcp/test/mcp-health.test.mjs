import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/index.ts';
import { startHealthServer } from '../src/health.ts';
import { OpenMeteoRiskService } from '../src/open-meteo.ts';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer as createNetServer } from 'node:net';

const location = { name: 'Dubai', country: 'UAE', timezone: 'Asia/Dubai', latitude: 25.2, longitude: 55.3 };
const dailyForecast = (days = 1) => ({
  current: { temperature_2m: 25, apparent_temperature: 27, wind_speed_10m: 8, weather_code: 0 },
  daily: {
    time: Array.from({ length: days }, (_, index) => `2026-09-${String(23 + index).padStart(2, '0')}`),
    temperature_2m_min: Array(days).fill(20),
    temperature_2m_max: Array(days).fill(30),
    weather_code: Array(days).fill(0)
  }
});
const hourlyForecast = {
  timezone: 'GMT', hourly_units: { wind_speed_10m: 'm/s' },
  hourly: {
    time: ['2026-09-23T13:00', '2026-09-23T14:00'],
    temperature_2m: [33, 34], precipitation_probability: [0, 70], wind_speed_10m: [3, 4]
  }
};
const riskArguments = { city: 'Dubai', start_at: '2026-09-23T16:00', work_type: 'inspection', duration_hours: 1 };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function withMcpServer(riskService, weatherDependencies, check) {
  const server = createServer(riskService, weatherDependencies);
  const client = new Client({ name: 'weather-cache-test', version: '1.0.0' });
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

test('MCP exposes the new tool and preserves get_weather behavior', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(
    url.hostname.startsWith('geocoding')
      ? { results: [{ name: 'Dubai', country: 'UAE', latitude: 25.2, longitude: 55.3 }] }
      : {
          current: { temperature_2m: 25, apparent_temperature: 27, wind_speed_10m: 8, weather_code: 0 },
          daily: { time: ['2026-09-23'], temperature_2m_min: [20], temperature_2m_max: [30], weather_code: [0] }
        }
  ));
  const riskService = { assess: async () => ({ kind: 'assessment', risk_level: 'LOW', recommendation: 'PROCEED' }) };
  const server = createServer(riskService);
  const client = new Client({ name: 'weather-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['assess_weather_risk', 'compare_weather_windows', 'find_safe_weather_window', 'get_weather']);
    const newResult = await client.callTool({
      name: 'assess_weather_risk',
      arguments: { city: 'Dubai', start_at: '2026-09-23T16:00', work_type: 'inspection', duration_hours: 1 }
    });
    assert.equal(newResult.isError, false);
    assert.equal(newResult.structuredContent.risk_level, 'LOW');
    const oldResult = await client.callTool({ name: 'get_weather', arguments: { city: 'Dubai', days: 1 } });
    assert.equal(oldResult.isError, undefined);
    assert.equal(oldResult.structuredContent.location.city, 'Dubai');
    assert.equal(oldResult.structuredContent.current.temperature_c, 25);
    const invalid = await client.callTool({ name: 'assess_weather_risk', arguments: { city: '', start_at: 'invalid', work_type: 'unknown', duration_hours: 0 } });
    assert.equal(invalid.isError, true);
    const afterError = await client.listTools();
    assert.equal(afterError.tools.length, 4);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = oldFetch;
  }
});

test('health endpoint responds only to GET /health', async () => {
  assert.throws(() => startHealthServer('invalid'));
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const listener = startHealthServer(String(port));
  try {
    await new Promise((resolve) => listener.once('listening', resolve));
    const healthy = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: 'ok' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('MCP reports invalid date without fetching or stopping the server', async () => {
  let calls = 0;
  const riskService = new OpenMeteoRiskService(async () => { calls++; throw new Error('should not fetch'); }, () => new Date('2026-09-23T12:00:00.000Z'));
  const server = createServer(riskService);
  const client = new Client({ name: 'weather-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'assess_weather_risk',
      arguments: { city: 'Dubai', start_at: '2026-02-30T15:00', work_type: 'inspection', duration_hours: 1 }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /несуществующая дата/);
    const tinyPeriod = await client.callTool({
      name: 'assess_weather_risk',
      arguments: { city: 'Dubai', start_at: '2026-09-23T16:00', work_type: 'inspection', duration_hours: 1e-20 }
    });
    assert.equal(tinyPeriod.isError, true);
    assert.match(tinyPeriod.content[0].text, /слишком мала/);
    assert.equal(calls, 0);
    assert.equal((await client.listTools()).tools.length, 4);
  } finally {
    await client.close();
    await server.close();
  }
});

test('get_weather caches complete weather for ten minutes from success, isolates days and server instances', async () => {
  let now = new Date('2026-09-23T12:00:00.000Z');
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(url.toString());
    if (url.hostname.startsWith('geocoding')) return jsonResponse({ results: [location] });
    if (urls.length === 2) now = new Date('2026-09-23T12:00:05.000Z');
    return jsonResponse(dailyForecast(Number(url.searchParams.get('forecast_days'))));
  };
  const dependencies = { fetchImpl: fetchMock, now: () => now };
  const riskService = { assess: async () => ({ kind: 'assessment', risk_level: 'LOW' }) };
  await withMcpServer(riskService, dependencies, async (client) => {
    const call = async (city, days = 1) => client.callTool({ name: 'get_weather', arguments: { city, days } });
    const first = await call(' Dubai ');
    assert.equal(first.structuredContent.current.temperature_c, 25);
    assert.equal(first.isError, undefined);
    assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
    assert.equal(urls.length, 2);
    now = new Date('2026-09-23T12:10:04.999Z');
    assert.deepEqual((await call('  DUBAI  ')).structuredContent, first.structuredContent);
    assert.equal(urls.length, 2);
    now = new Date('2026-09-23T12:10:05.000Z');
    await call('dubai');
    assert.equal(urls.length, 4);
    await call('Dubai', 2);
    assert.equal(urls.length, 6);
    assert.equal(new URL(urls[5]).searchParams.get('forecast_days'), '2');
  });
  await withMcpServer(riskService, dependencies, async (client) => {
    await client.callTool({ name: 'get_weather', arguments: { city: 'Dubai', days: 1 } });
    assert.equal(urls.length, 8);
  });
});

test('get_weather does not cache not_found and recovers when city appears', async () => {
  let geocoding = {};
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    return jsonResponse(url.hostname.startsWith('geocoding') ? geocoding : dailyForecast());
  };
  await withMcpServer({ assess: async () => ({ kind: 'assessment' }) }, { fetchImpl: fetchMock }, async (client) => {
    for (const body of [{}, { results: [] }]) {
      geocoding = body;
      const result = await client.callTool({ name: 'get_weather', arguments: { city: 'Dubai', days: 1 } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /не найден/);
      assert.equal(result.structuredContent, undefined);
    }
    assert.equal(calls, 2);
    geocoding = { results: [location] };
    const recovered = await client.callTool({ name: 'get_weather', arguments: { city: 'Dubai', days: 1 } });
    assert.equal(recovered.structuredContent.location.city, 'Dubai');
    assert.equal(calls, 4);
  });
});

test('both MCP tools return one external failure message and retry the same request', async () => {
  const failures = [
    { name: 'network', make: () => { throw new Error('offline'); } },
    { name: 'timeout', make: () => { throw new DOMException('timeout', 'TimeoutError'); } },
    { name: 'HTTP', make: () => jsonResponse({}, 503) },
    { name: 'bad JSON', make: () => new Response('{invalid') },
    { name: 'error object', make: () => jsonResponse({ error: true, reason: 'bad request' }) },
    { name: 'malformed', make: (geocoding) => jsonResponse(geocoding ? { results: null } : { current: {} }) }
  ];
  for (const toolName of ['get_weather', 'assess_weather_risk']) {
    for (const stage of ['geocoding', 'forecast']) {
      for (const failure of failures) {
        let failed = false;
        let calls = 0;
        const fetchMock = async (url, { signal }) => {
          assert.ok(signal);
          calls++;
          const geocoding = url.hostname.startsWith('geocoding');
          if ((stage === 'geocoding') === geocoding && !failed) {
            failed = true;
            return failure.make(geocoding);
          }
          return jsonResponse(geocoding ? { results: [location] } :
            toolName === 'get_weather' ? dailyForecast() : hourlyForecast);
        };
        const riskService = new OpenMeteoRiskService(fetchMock, () => new Date('2026-09-23T12:00:00.000Z'));
        await withMcpServer(riskService, { fetchImpl: fetchMock }, async (client) => {
          const args = toolName === 'get_weather' ? { city: 'Dubai', days: 1 } : riskArguments;
          const first = await client.callTool({ name: toolName, arguments: args });
          assert.equal(first.isError, true, `${toolName} ${stage} ${failure.name}`);
          assert.equal(first.content[0].text, 'Погодный сервис временно недоступен. Попробуйте позже.');
          assert.equal(first.structuredContent, undefined);
          const afterFailure = calls;
          assert.equal(afterFailure, stage === 'geocoding' ? 1 : 2);
          const second = await client.callTool({ name: toolName, arguments: args });
          assert.equal(second.isError, toolName === 'get_weather' ? undefined : false);
          assert.equal(calls, afterFailure + 2);
          assert.deepEqual(JSON.parse(second.content[0].text), JSON.parse(JSON.stringify(second.structuredContent)));
          assert.equal((await client.listTools()).tools.length, 4);
        });
      }
    }
  }
});

test('get_weather rejects incomplete forecast and does not return expired weather on refresh failure', async () => {
  const malformed = [
    { current: {}, daily: dailyForecast().daily },
    { ...dailyForecast(), daily: { ...dailyForecast().daily, time: [] } },
    { ...dailyForecast(), daily: { ...dailyForecast().daily, temperature_2m_min: [] } },
    { ...dailyForecast(), daily: { ...dailyForecast().daily, temperature_2m_max: [null] } },
    { ...dailyForecast(), daily: { ...dailyForecast().daily, weather_code: ['x'] } },
    { ...dailyForecast(), daily: { ...dailyForecast().daily, time: ['2026-02-30'] } },
    { ...dailyForecast(), current: { ...dailyForecast().current, wind_speed_10m: -1 } }
  ];
  for (const bad of malformed) {
    let calls = 0;
    const fetchMock = async (url) => {
      calls++;
      return jsonResponse(url.hostname.startsWith('geocoding') ? { results: [location] } : calls === 2 ? bad : dailyForecast());
    };
    await withMcpServer({ assess: async () => ({ kind: 'assessment' }) }, { fetchImpl: fetchMock }, async (client) => {
      const args = { name: 'get_weather', arguments: { city: 'Dubai', days: 1 } };
      const first = await client.callTool(args);
      assert.equal(first.isError, true);
      assert.equal(first.structuredContent, undefined);
      assert.equal((await client.callTool(args)).structuredContent.current.temperature_c, 25);
      assert.equal(calls, 4);
    });
  }
  let now = new Date('2026-09-23T12:00:00.000Z');
  let failRefresh = false;
  let calls = 0;
  const fetchMock = async (url) => {
    calls++;
    if (failRefresh) return jsonResponse({}, 503);
    return jsonResponse(url.hostname.startsWith('geocoding') ? { results: [location] } : dailyForecast());
  };
  await withMcpServer({ assess: async () => ({ kind: 'assessment' }) }, { fetchImpl: fetchMock, now: () => now }, async (client) => {
    const args = { name: 'get_weather', arguments: { city: 'Dubai', days: 1 } };
    assert.equal((await client.callTool(args)).isError, undefined);
    now = new Date('2026-09-23T12:10:00.000Z');
    failRefresh = true;
    const stale = await client.callTool(args);
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent, undefined);
    assert.equal(calls, 3);
  });
});
