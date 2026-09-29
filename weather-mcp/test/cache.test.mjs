import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCity, MemoryCache, normalizeCity, WEATHER_CACHE_TTL_MS } from '../src/cache.ts';

test('city normalization preserves qualifiers and collapses whitespace', () => {
  assert.equal(cleanCity('  New   York ,  United\tStates  '), 'New York,United States');
  assert.equal(normalizeCity('  NEW   YORK ,  United\tStates  '), 'new york,united states');
  assert.notEqual(normalizeCity('Springfield, Illinois'), normalizeCity('Springfield, Missouri'));
  assert.notEqual(normalizeCity('Елки'), normalizeCity('Ёлки'));
});

test('cache expires exactly after ten minutes and reads do not extend it', () => {
  let now = 100;
  const cache = new MemoryCache(WEATHER_CACHE_TTL_MS, () => now);
  cache.set('city', 'first');
  now += 300_000;
  assert.equal(cache.get('city'), 'first');
  now += 299_999;
  assert.equal(cache.get('city'), 'first');
  now += 1;
  assert.equal(cache.get('city'), undefined);
});

test('cache evicts the oldest of 500 entries and is instance-local', () => {
  const cache = new MemoryCache(WEATHER_CACHE_TTL_MS, () => 0);
  for (let index = 0; index < 500; index++) cache.set(String(index), index);
  assert.equal(cache.get('0'), 0);
  cache.set('500', 500);
  assert.equal(cache.get('0'), undefined);
  assert.equal(cache.get('1'), 1);
  assert.equal(cache.get('500'), 500);
  assert.equal(new MemoryCache(WEATHER_CACHE_TTL_MS, () => 0).get('500'), undefined);
});
