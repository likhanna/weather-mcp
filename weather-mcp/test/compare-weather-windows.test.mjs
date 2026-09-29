import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/index.ts';
import { OpenMeteoRiskService } from '../src/open-meteo.ts';

const fixedNow = new Date('2026-09-24T12:00:00.000Z');
const fixedClock = () => new Date(fixedNow);
const windows = [
  { start_at: '2026-09-24T15:00', duration_hours: 1 },
  { start_at: '2026-09-24T16:00', duration_hours: 1 }
];
const assessment = (risk_level, recommendation = ({ LOW: 'PROCEED', MEDIUM: 'REVIEW', HIGH: 'CANCEL' })[risk_level]) => ({
  kind: 'assessment',
  location: { city: 'Dubai', country: 'UAE', timezone: 'Asia/Dubai' },
  period: { start_utc: '2026-09-24T12:00:00.000Z', end_utc: '2026-09-24T13:00:00.000Z', input_timezone: 'Europe/Moscow' },
  work_type: 'maintenance',
  duration_hours: 1,
  hourly_weather: [],
  risk_level,
  recommendation,
  factors: [],
  source: 'Open-Meteo',
  fetched_at: '2026-09-24T12:00:00.000Z'
});
const jsonResponse = (body) => new Response(JSON.stringify(body));

async function withClient(riskService, check, dependencies = { now: fixedClock }) {
  const server = createServer(riskService, dependencies);
  const client = new Client({ name: 'compare-weather-windows-test', version: '1.0.0' });
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

async function callCompare(client, suppliedWindows = windows) {
  return client.callTool({
    name: 'compare_weather_windows',
    arguments: { city: 'Dubai', work_type: 'maintenance', windows: suppliedWindows }
  });
}

test('compare_weather_windows ranks all nine ordered risk pairs and retains both assessments', async () => {
  const levels = ['HIGH', 'MEDIUM', 'LOW'];
  for (const first of levels) {
    for (const second of levels) {
      const requests = [];
      await withClient({ assess: async (request) => { requests.push(request); return assessment(requests.length === 1 ? first : second); } }, async (client) => {
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map(({ name }) => name).sort(), ['assess_weather_risk', 'compare_weather_windows', 'find_safe_weather_window', 'get_weather']);
        const result = await callCompare(client);
        assert.equal(result.isError, false);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests.map(({ city, work_type, start_at, duration_hours }) => ({ city, work_type, start_at, duration_hours })), [
          { city: 'Dubai', work_type: 'maintenance', ...windows[0] },
          { city: 'Dubai', work_type: 'maintenance', ...windows[1] }
        ]);
        const expected = first === second ? [] : [first === 'LOW' || (first === 'MEDIUM' && second === 'HIGH') ? 0 : 1];
        assert.deepEqual(result.structuredContent.selected_indices, expected, `${first}/${second}`);
        assert.equal(result.structuredContent.tie, first === second);
        if (expected.length === 1) {
          const selectedIndex = expected[0];
          const otherIndex = 1 - selectedIndex;
          const rankedLevels = [first, second];
          assert.match(
            result.structuredContent.explanation,
            new RegExp(`Окно ${selectedIndex + 1} \\(${rankedLevels[selectedIndex]}\\) безопаснее окна ${otherIndex + 1} \\(${rankedLevels[otherIndex]}\\)\\.`),
            `${first}/${second}`
          );
        }
        assert.deepEqual(result.structuredContent.windows.map(({ window_id, start_at, duration_hours }) => ({ window_id, start_at, duration_hours })), [
          { window_id: 'window-1', ...windows[0] },
          { window_id: 'window-2', ...windows[1] }
        ]);
        assert.deepEqual(result.structuredContent.windows.map(({ assessment: a }) => a.risk_level), [first, second]);
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      });
    }
  }
});

test('ties at every level preserve both windows and HIGH/HIGH does not recommend proceeding', async () => {
  for (const level of ['LOW', 'MEDIUM', 'HIGH']) {
    await withClient({ assess: async () => assessment(level) }, async (client) => {
      const result = await callCompare(client);
      assert.deepEqual(result.structuredContent.selected_indices, []);
      assert.equal(result.structuredContent.tie, true);
      assert.equal(result.structuredContent.windows.length, 2);
      if (level === 'HIGH') {
        assert.match(result.structuredContent.explanation, /CANCEL/);
        assert.doesNotMatch(result.structuredContent.explanation, /можно работать|разрешено/iu);
        assert.ok(result.structuredContent.windows.every(({ assessment: a }) => a.recommendation === 'CANCEL'));
      }
    });
  }
});

test('swapping windows changes only the selected index, while equal windows retain separate identities', async () => {
  for (const supplied of [windows, [...windows].reverse()]) {
    await withClient({ assess: async ({ start_at }) => assessment(start_at === windows[0].start_at ? 'LOW' : 'HIGH') }, async (client) => {
      const result = await callCompare(client, supplied);
      const expectedIndex = supplied[0].start_at === windows[0].start_at ? 0 : 1;
      assert.deepEqual(result.structuredContent.selected_indices, [expectedIndex]);
      assert.equal(result.structuredContent.windows[expectedIndex].assessment.risk_level, 'LOW');
    });
  }
  await withClient({ assess: async () => assessment('LOW') }, async (client) => {
    const result = await callCompare(client, [windows[0], windows[0]]);
    assert.deepEqual(result.structuredContent.windows.map(({ window_id }) => window_id), ['window-1', 'window-2']);
    assert.deepEqual(result.structuredContent.windows.map(({ start_at }) => start_at), [windows[0].start_at, windows[0].start_at]);
    assert.deepEqual(result.structuredContent.selected_indices, []);
  });
  const overlapping = [
    { start_at: '2026-09-24T15:00', duration_hours: 2 },
    { start_at: '2026-09-24T16:00', duration_hours: 1 }
  ];
  await withClient({ assess: async ({ start_at }) => assessment(start_at === overlapping[0].start_at ? 'MEDIUM' : 'LOW') }, async (client) => {
    const result = await callCompare(client, overlapping);
    assert.deepEqual(result.structuredContent.selected_indices, [1]);
    assert.deepEqual(result.structuredContent.windows.map(({ start_at, duration_hours }) => ({ start_at, duration_hours })), overlapping);
  });
});

test('invalid input and invalid second window fail before any assessment or fetch', async () => {
  let assessments = 0;
  await withClient({ assess: async () => { assessments++; return assessment('LOW'); } }, async (client) => {
    const invalidCases = [
      [], [windows[0]], [...windows, windows[1]], null,
      [null, windows[1]], [{ ...windows[0], duration_hours: '1' }, windows[1]],
      [{ ...windows[0], extra: true }, windows[1]],
      [{ ...windows[0], duration_hours: 0 }, windows[1]],
      [{ ...windows[0], duration_hours: -1 }, windows[1]],
      [{ ...windows[0], start_at: '2026-02-30T15:00' }, windows[1]],
      [{ ...windows[0], start_at: '2026-09-23T15:00' }, windows[1]],
      [{ ...windows[0], start_at: '2026-09-29T15:00' }, windows[1]],
      [windows[0], { ...windows[1], start_at: 'invalid' }],
      [windows[0], { ...windows[1], start_at: '2026-09-23T15:00' }],
      [windows[0], { ...windows[1], start_at: '2026-09-29T15:00' }],
      [windows[0], { ...windows[1], duration_hours: 0.0000000000000001 }]
    ];
    for (const invalidWindows of invalidCases) {
      const result = await callCompare(client, invalidWindows);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
    }
    for (const input of [
      { city: ' ', work_type: 'maintenance', windows },
      { city: 'x'.repeat(121), work_type: 'maintenance', windows },
      { city: 'Dubai', work_type: 'other', windows },
      { city: 'Dubai', work_type: 'maintenance', windows: [{ ...windows[0], extra: true }, windows[1]] }
    ]) {
      const result = await client.callTool({ name: 'compare_weather_windows', arguments: input });
      assert.equal(result.isError, true);
    }
  });
  assert.equal(assessments, 0);

  let reads = 0;
  let fetches = 0;
  const actualService = new OpenMeteoRiskService(async () => { fetches++; throw new Error('must not fetch'); }, fixedClock);
  const countingService = { assess: async (request) => { reads++; return actualService.assess(request); } };
  let nowReads = 0;
  await withClient(countingService, async (client) => {
    const result = await callCompare(client, [windows[0], { ...windows[1], start_at: 'bad-date' }]);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /формат/);
  }, { now: () => { nowReads++; return fixedClock(); } });
  assert.equal(reads, 0, 'valid first window must not reach assess before invalid second is rejected');
  assert.equal(fetches, 0, 'an invalid pair must not fetch weather');
  assert.equal(nowReads, 1, 'both windows are checked against one handler clock snapshot');
});

test('not_found and ambiguous preserve the first unassessed result without winner fields', async () => {
  const notFound = { kind: 'not_found', message: 'missing city' };
  const ambiguous = { kind: 'ambiguous', message: 'choose city', options: [{ city: 'Springfield', country: 'US' }] };
  for (const pair of [[notFound, assessment('LOW')], [assessment('LOW'), ambiguous], [ambiguous, notFound]]) {
    let index = 0;
    await withClient({ assess: async () => pair[index++] }, async (client) => {
      const result = await callCompare(client);
      const expected = pair.find((entry) => entry.kind !== 'assessment');
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, expected);
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      assert.ok(!('selected_indices' in result.structuredContent));
      assert.ok(!('tie' in result.structuredContent));
      assert.ok(!('explanation' in result.structuredContent));
    });
  }
});

test('thrown errors from either assessment return the existing messages without a winner', async () => {
  for (const failingIndex of [0, 1]) {
    let index = 0;
    await withClient({ assess: async () => {
      const current = index++;
      if (current === failingIndex) throw new Error('internal failure');
      return assessment('LOW');
    } }, async (client) => {
      const result = await callCompare(client);
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, 'Не удалось сравнить погодные окна. Попробуйте позже.');
      assert.equal(result.structuredContent, undefined);
    });
  }
});

test('real OpenMeteoRiskService compares both windows with the shared fixed clock and reuses its memory cache', async () => {
  const requests = [];
  const fetchMock = async (url) => {
    requests.push(url.toString());
    if (url.hostname.startsWith('geocoding')) {
      return jsonResponse({ results: [{ id: 1, name: 'Dubai', country: 'UAE', timezone: 'Asia/Dubai', latitude: 25.2, longitude: 55.3 }] });
    }
    return jsonResponse({
      timezone: 'GMT', utc_offset_seconds: 0, hourly_units: { wind_speed_10m: 'm/s' },
      hourly: {
        time: ['2026-09-24T12:00', '2026-09-24T13:00'],
        temperature_2m: [25, 25], precipitation_probability: [0, 0], wind_speed_10m: [3, 3]
      }
    });
  };
  const service = new OpenMeteoRiskService(fetchMock, fixedClock);
  await withClient(service, async (client) => {
    const result = await callCompare(client);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.windows.length, 2);
    assert.ok(result.structuredContent.windows.every(({ assessment: a }) => a.kind === 'assessment' && a.risk_level === 'LOW'));
    assert.deepEqual(result.structuredContent.windows.map(({ assessment: a }) => a.period.start_utc), [
      '2026-09-24T12:00:00.000Z', '2026-09-24T13:00:00.000Z'
    ]);
    const callsAfterFirstCompare = requests.length;
    await callCompare(client);
    assert.equal(requests.length, callsAfterFirstCompare, 'successful assessments should be served from the existing process memory cache');
  }, { now: fixedClock });
});
