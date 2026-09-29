import { cleanCity, MemoryCache, normalizeCity, WEATHER_CACHE_TTL_MS } from "./cache.js";
import { assessRisk, type HourlyWeather } from "./risk.js";
import { intersectsHour, parseWorkPeriod, type WorkPeriod } from "./time.js";

const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 5_000;
const HOUR_MS = 60 * 60_000;

export const WEATHER_UNAVAILABLE_MESSAGE = "Погодный сервис временно недоступен. Попробуйте позже.";
export class WeatherDataError extends Error {}

export interface RiskRequest {
  city: string;
  start_at: string;
  work_type: "maintenance" | "installation" | "inspection";
  duration_hours: number;
}

interface Location {
  id?: number;
  name: string;
  country: string;
  admin1?: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

export type RiskResult =
  | { kind: "not_found"; message: string }
  | { kind: "ambiguous"; message: string; options: Array<{ city: string; region?: string; country: string; location_id?: number }> }
  | {
      kind: "assessment";
      location: { city: string; region?: string; country: string; timezone: string };
      period: { start_utc: string; end_utc: string; input_timezone: "Europe/Moscow" };
      work_type: RiskRequest["work_type"];
      duration_hours: number;
      hourly_weather: HourlyWeather[];
      risk_level: "LOW" | "MEDIUM" | "HIGH";
      recommendation: "PROCEED" | "REVIEW" | "CANCEL";
      factors: ReturnType<typeof assessRisk>["factors"];
      source: "Open-Meteo";
      fetched_at: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocations(data: unknown): Location[] {
  if (!isRecord(data) || data.error === true) throw new WeatherDataError(WEATHER_UNAVAILABLE_MESSAGE);
  if (data.results === undefined) return [];
  if (!Array.isArray(data.results)) throw new WeatherDataError("Сервис геокодирования вернул некорректные данные.");
  return data.results.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" || !entry.name.trim() ||
      typeof entry.country !== "string" || !entry.country.trim() ||
      typeof entry.timezone !== "string" || !entry.timezone.trim() ||
      typeof entry.latitude !== "number" ||
      !Number.isFinite(entry.latitude) || entry.latitude < -90 || entry.latitude > 90 ||
      typeof entry.longitude !== "number" ||
      !Number.isFinite(entry.longitude) || entry.longitude < -180 || entry.longitude > 180
    ) {
      throw new WeatherDataError("Сервис геокодирования вернул некорректные данные.");
    }
    return {
      id: typeof entry.id === "number" ? entry.id : undefined,
      name: entry.name,
      country: entry.country,
      admin1: typeof entry.admin1 === "string" ? entry.admin1 : undefined,
      timezone: entry.timezone,
      latitude: entry.latitude,
      longitude: entry.longitude
    };
  });
}

function parseForecast(data: unknown, period: WorkPeriod): { timezone: string; hours: HourlyWeather[] } {
  if (!isRecord(data) || typeof data.timezone !== "string" || !isRecord(data.hourly)) {
    throw new WeatherDataError("Погодный сервис вернул неполные данные.");
  }
  if ((data.timezone !== "GMT" && data.timezone !== "UTC") || (data.utc_offset_seconds !== undefined && data.utc_offset_seconds !== 0)) {
    throw new WeatherDataError("Погодный сервис вернул неожиданный часовой пояс прогноза.");
  }
  const { time, temperature_2m, precipitation_probability, wind_speed_10m } = data.hourly;
  if (
    !Array.isArray(time) ||
    !Array.isArray(temperature_2m) ||
    !Array.isArray(precipitation_probability) ||
    !Array.isArray(wind_speed_10m) ||
    time.length !== temperature_2m.length ||
    time.length !== precipitation_probability.length ||
    time.length !== wind_speed_10m.length
  ) {
    throw new WeatherDataError("Погодный сервис вернул неполные данные.");
  }
  if (isRecord(data.hourly_units) && data.hourly_units.wind_speed_10m !== undefined && data.hourly_units.wind_speed_10m !== "m/s") {
    throw new WeatherDataError("Погодный сервис вернул неожиданную единицу скорости ветра.");
  }

  const byTime = new Map<number, HourlyWeather>();
  for (let index = 0; index < time.length; index++) {
    const rawTime = time[index];
    const temperature = temperature_2m[index];
    const precipitation = precipitation_probability[index];
    const wind = wind_speed_10m[index];
    if (
      typeof rawTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(rawTime) ||
      typeof temperature !== "number" || !Number.isFinite(temperature) ||
      typeof precipitation !== "number" || !Number.isFinite(precipitation) || precipitation < 0 || precipitation > 100 ||
      typeof wind !== "number" || !Number.isFinite(wind) || wind < 0
    ) {
      throw new WeatherDataError("Погодный сервис вернул некорректные почасовые данные.");
    }
    const hourStart = new Date(`${rawTime}Z`);
    if (Number.isNaN(hourStart.getTime()) || hourStart.toISOString().slice(0, 16) !== rawTime) {
      throw new WeatherDataError("Погодный сервис вернул некорректное время прогноза.");
    }
    if (intersectsHour(hourStart, period)) {
      byTime.set(hourStart.getTime(), {
        time: hourStart.toISOString(),
        temperature_c: temperature,
        precipitation_probability_percent: precipitation,
        wind_speed_ms: wind
      });
    }
  }

  const hours: HourlyWeather[] = [];
  const firstHour = Math.floor(period.start.getTime() / HOUR_MS) * HOUR_MS;
  for (let timestamp = firstHour; timestamp < period.end.getTime(); timestamp += HOUR_MS) {
    const hour = byTime.get(timestamp);
    if (!hour) throw new WeatherDataError("Погодный сервис не предоставил прогноз на весь период работ.");
    hours.push(hour);
  }
  return { timezone: data.timezone, hours };
}

export class OpenMeteoRiskService {
  private readonly cache: MemoryCache<RiskResult>;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date()
  ) {
    this.cache = new MemoryCache<RiskResult>(WEATHER_CACHE_TTL_MS, () => this.now().getTime());
  }

  private async fetchJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new WeatherDataError(WEATHER_UNAVAILABLE_MESSAGE);
    }
    if (!response.ok) throw new WeatherDataError(WEATHER_UNAVAILABLE_MESSAGE);
    try {
      const data: unknown = await response.json();
      if (isRecord(data) && data.error === true) throw new WeatherDataError(WEATHER_UNAVAILABLE_MESSAGE);
      return data;
    } catch {
      throw new WeatherDataError(WEATHER_UNAVAILABLE_MESSAGE);
    }
  }

  async assess(request: RiskRequest): Promise<RiskResult> {
    const period = parseWorkPeriod(request.start_at, request.duration_hours, this.now());
    const cacheKey = JSON.stringify([
      normalizeCity(request.city),
      period.start.toISOString(),
      request.work_type,
      request.duration_hours
    ]);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const geocodingUrl = new URL(GEOCODING_API);
    geocodingUrl.searchParams.set("name", cleanCity(request.city));
    geocodingUrl.searchParams.set("count", "5");
    geocodingUrl.searchParams.set("language", /[А-Яа-яЁё]/.test(request.city) ? "ru" : "en");
    geocodingUrl.searchParams.set("format", "json");
    const locations = parseLocations(await this.fetchJson(geocodingUrl));
    const [cityName, ...qualifiers] = cleanCity(request.city).split(",").map(normalizeCity).filter(Boolean);
    const exactName = cityName;
    const exactMatches = locations.filter((location) => normalizeCity(location.name) === exactName);
    const namedCandidates = exactMatches.length > 0 ? exactMatches : locations;
    const candidates = qualifiers.length === 0
      ? namedCandidates
      : namedCandidates.filter((location) => qualifiers.every((qualifier) =>
          qualifier === normalizeCity(location.admin1 ?? "") || qualifier === normalizeCity(location.country)
        ));

    let result: RiskResult;
    if (candidates.length === 0) {
      result = { kind: "not_found", message: "Город или указанный регион/страна не найдены. Уточните название и попробуйте снова." };
    } else if (candidates.length > 1) {
      result = {
        kind: "ambiguous",
        message: "Название города неоднозначно. Уточните город по одному из вариантов.",
        options: candidates.slice(0, 5).map((location) => ({
          city: location.name,
          region: location.admin1,
          country: location.country,
          location_id: location.id
        }))
      };
    } else {
      const location = candidates[0];
      const forecastUrl = new URL(FORECAST_API);
      forecastUrl.searchParams.set("latitude", String(location.latitude));
      forecastUrl.searchParams.set("longitude", String(location.longitude));
      forecastUrl.searchParams.set("hourly", "temperature_2m,precipitation_probability,wind_speed_10m");
      forecastUrl.searchParams.set("wind_speed_unit", "ms");
      forecastUrl.searchParams.set("timezone", "UTC");
      forecastUrl.searchParams.set("forecast_days", "6");
      const forecast = parseForecast(await this.fetchJson(forecastUrl), period);
      const risk = assessRisk(forecast.hours);
      result = {
        kind: "assessment",
        location: { city: location.name, region: location.admin1, country: location.country, timezone: location.timezone },
        period: { start_utc: period.start.toISOString(), end_utc: period.end.toISOString(), input_timezone: "Europe/Moscow" },
        work_type: request.work_type,
        duration_hours: request.duration_hours,
        hourly_weather: forecast.hours,
        ...risk,
        source: "Open-Meteo",
        fetched_at: this.now().toISOString()
      };
    }
    if (result.kind === "assessment") this.cache.set(cacheKey, result);
    return result;
  }
}
