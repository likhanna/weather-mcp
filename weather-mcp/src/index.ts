import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { pathToFileURL } from "node:url";
import { startHealthServer } from "./health.js";
import { cleanCity, MemoryCache, normalizeCity, WEATHER_CACHE_TTL_MS } from "./cache.js";
import { OpenMeteoRiskService, WeatherDataError, WEATHER_UNAVAILABLE_MESSAGE } from "./open-meteo.js";
import { InputError, parseWorkPeriod } from "./time.js";
import type { RiskResult, RiskRequest } from "./open-meteo.js";

const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 10_000;

interface ForecastResponse {
  current?: {
    temperature_2m: number;
    apparent_temperature: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  daily?: {
    time: string[];
    temperature_2m_min: number[];
    temperature_2m_max: number[];
    weather_code: number[];
  };
}

class WeatherServiceError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function weatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: "Ясно",
    1: "Преимущественно ясно",
    2: "Переменная облачность",
    3: "Пасмурно",
    45: "Туман",
    48: "Туман с изморозью",
    51: "Слабая морось",
    53: "Умеренная морось",
    55: "Сильная морось",
    56: "Слабая ледяная морось",
    57: "Сильная ледяная морось",
    61: "Небольшой дождь",
    63: "Умеренный дождь",
    65: "Сильный дождь",
    66: "Слабый ледяной дождь",
    67: "Сильный ледяной дождь",
    71: "Небольшой снег",
    73: "Умеренный снег",
    75: "Сильный снег",
    77: "Снежные зёрна",
    80: "Слабые ливни",
    81: "Умеренные ливни",
    82: "Сильные ливни",
    85: "Слабые снежные заряды",
    86: "Сильные снежные заряды",
    95: "Гроза",
    96: "Гроза с небольшим градом",
    99: "Гроза с сильным градом"
  };

  return descriptions[code] ?? "Неизвестные погодные условия";
}

async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;

  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    console.error("Open-Meteo request failed:", error);
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    console.error(`Open-Meteo returned HTTP ${response.status} for ${url.hostname}`);
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }

  try {
    const data: unknown = await response.json();
    if (isRecord(data) && data.error === true) throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
    return data;
  } catch (error) {
    console.error("Open-Meteo returned invalid JSON:", error);
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }
}

async function getWeather(city: string, days: number, fetchImpl: typeof fetch) {
  const geocodingUrl = new URL(GEOCODING_API);
  geocodingUrl.searchParams.set("name", cleanCity(city));
  geocodingUrl.searchParams.set("count", "1");
  geocodingUrl.searchParams.set("language", "ru");
  geocodingUrl.searchParams.set("format", "json");

  const geocoding = await fetchJson(geocodingUrl, fetchImpl);
  if (!isRecord(geocoding) || (geocoding.results !== undefined && !Array.isArray(geocoding.results))) {
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }
  const locations = geocoding.results as unknown[] | undefined;
  if (!locations || locations.length === 0) {
    return null;
  }
  const location = locations[0];
  if (!isRecord(location) ||
      typeof location.name !== "string" || !location.name.trim() ||
      typeof location.country !== "string" || !location.country.trim() ||
      !isFiniteNumber(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
      !isFiniteNumber(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }

  const forecastUrl = new URL(FORECAST_API);
  forecastUrl.searchParams.set("latitude", String(location.latitude));
  forecastUrl.searchParams.set("longitude", String(location.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,wind_speed_10m,weather_code"
  );
  forecastUrl.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,weather_code");
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", String(days));

  const forecast = await fetchJson(forecastUrl, fetchImpl);
  if (!isRecord(forecast)) throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  const current = forecast.current;
  const daily = forecast.daily;

  if (!isRecord(current) || !isRecord(daily) ||
      !isFiniteNumber(current.temperature_2m) ||
      !isFiniteNumber(current.apparent_temperature) ||
      !isFiniteNumber(current.wind_speed_10m) || current.wind_speed_10m < 0 ||
      !Number.isInteger(current.weather_code) ||
      !Array.isArray(daily.time) || daily.time.length !== days ||
      !Array.isArray(daily.temperature_2m_min) || daily.temperature_2m_min.length !== days ||
      !Array.isArray(daily.temperature_2m_max) || daily.temperature_2m_max.length !== days ||
      !Array.isArray(daily.weather_code) || daily.weather_code.length !== days ||
      !daily.time.every(isValidDate) ||
      !daily.temperature_2m_min.every(isFiniteNumber) ||
      !daily.temperature_2m_max.every(isFiniteNumber) ||
      !daily.weather_code.every((code: unknown) => Number.isInteger(code))) {
    throw new WeatherServiceError(WEATHER_UNAVAILABLE_MESSAGE);
  }
  const validatedCurrent = current as unknown as NonNullable<ForecastResponse["current"]>;
  const validatedDaily = daily as unknown as NonNullable<ForecastResponse["daily"]>;

  return {
    location: {
      city: location.name,
      country: location.country
    },
    current: {
      temperature_c: validatedCurrent.temperature_2m,
      feels_like_c: validatedCurrent.apparent_temperature,
      wind_speed_kmh: validatedCurrent.wind_speed_10m,
      conditions: weatherDescription(validatedCurrent.weather_code)
    },
    forecast: validatedDaily.time.map((date, index) => ({
      date,
      min_temperature_c: validatedDaily.temperature_2m_min[index],
      max_temperature_c: validatedDaily.temperature_2m_max[index],
      conditions: weatherDescription(validatedDaily.weather_code[index])
    }))
  };
}

export function createServer(
  riskService = new OpenMeteoRiskService(),
  weatherDependencies: { fetchImpl?: typeof fetch; now?: () => Date } = {}
): McpServer {
  const weatherFetch = weatherDependencies.fetchImpl ?? fetch;
  const weatherNow = weatherDependencies.now ?? (() => new Date());
  const weatherCache = new MemoryCache<NonNullable<Awaited<ReturnType<typeof getWeather>>>>(
    WEATHER_CACHE_TTL_MS,
    () => weatherNow().getTime()
  );
  const server = new McpServer(
    { name: "weather-mcp", version: "1.0.0" },
    {
      instructions:
        "Use get_weather to retrieve the current conditions and a 1-7 day forecast for a city. Weather data comes from Open-Meteo and may be temporarily unavailable."
    }
  );

  server.registerTool(
    "get_weather",
    {
      title: "Get weather forecast",
      description:
        "Gets the current weather and daily temperature forecast for a city using Open-Meteo.",
      inputSchema: z.object({
        city: z.string().trim().min(1, "Укажите название города.").max(120),
        days: z.number().int().min(1).max(7)
      })
    },
    async ({ city, days }) => {
      try {
        const cacheKey = JSON.stringify([normalizeCity(city), days]);
        const cached = weatherCache.get(cacheKey);
        const weather = cached ?? await getWeather(city, days, weatherFetch);

        if (!weather) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Город «${city}» не найден. Уточните название и попробуйте снова.`
              }
            ],
            isError: true
          };
        }

        if (!cached) weatherCache.set(cacheKey, weather);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(weather, null, 2) }],
          structuredContent: weather
        };
      } catch (error) {
        const message =
          error instanceof WeatherServiceError
            ? error.message
            : "Не удалось получить погоду. Попробуйте позже.";
        console.error("get_weather failed:", error);

        return {
          content: [{ type: "text" as const, text: message }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "assess_weather_risk",
    {
      title: "Assess weather risk for outdoor work",
      description: "Assesses hourly weather risk for scheduled outdoor work using Open-Meteo. start_at is Moscow time (YYYY-MM-DDTHH:mm).",
      inputSchema: z.object({
        city: z.string().trim().min(1, "Укажите название города.").max(120),
        start_at: z.string(),
        work_type: z.enum(["maintenance", "installation", "inspection"]),
        duration_hours: z.number().finite().positive()
      })
    },
    async (request) => {
      try {
        const result = await riskService.assess(request);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: result.kind !== "assessment"
        };
      } catch (error) {
        const message = error instanceof WeatherDataError
          ? WEATHER_UNAVAILABLE_MESSAGE
          : error instanceof InputError
            ? error.message
            : "Не удалось оценить погодный риск. Попробуйте позже.";
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "compare_weather_windows",
    {
      title: "Compare weather windows for outdoor work",
      description: "Assesses two scheduled outdoor work windows with the same risk service and returns the safer one, or both when risk levels tie.",
      inputSchema: z.object({
        city: z.string().trim().min(1, "Укажите название города.").max(120),
        work_type: z.enum(["maintenance", "installation", "inspection"]),
        windows: z.array(z.object({
          start_at: z.string(),
          duration_hours: z.number().finite().positive()
        }).strict()).length(2)
      }).strict()
    },
    async ({ city, work_type, windows }) => {
      try {
        const now = weatherNow();
        for (const window of windows) {
          parseWorkPeriod(window.start_at, window.duration_hours, now);
        }

        const requests: [RiskRequest, RiskRequest] = windows.map((window) => ({
          city,
          work_type,
          start_at: window.start_at,
          duration_hours: window.duration_hours
        })) as [RiskRequest, RiskRequest];
        const assessments = await Promise.all(requests.map((request) => riskService.assess(request)));
        const firstUnassessed = assessments.find((result) => result.kind !== "assessment");
        if (firstUnassessed) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(firstUnassessed, null, 2) }],
            structuredContent: firstUnassessed,
            isError: true
          };
        }

        const completeAssessments = assessments as [Extract<RiskResult, { kind: "assessment" }>, Extract<RiskResult, { kind: "assessment" }>];
        const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
        const tied = completeAssessments[0].risk_level === completeAssessments[1].risk_level;
        const selectedIndices = tied ? [] : [rank[completeAssessments[0].risk_level] < rank[completeAssessments[1].risk_level] ? 0 : 1];
        const selectedIndex = selectedIndices[0];
        const otherIndex = selectedIndex === 0 ? 1 : 0;
        const explanation = tied
          ? `Оба окна имеют одинаковый уровень риска ${completeAssessments[0].risk_level} и рекомендацию ${completeAssessments[0].recommendation}/${completeAssessments[1].recommendation}; выбрать одно по уровню риска нельзя.`
          : `Окно ${selectedIndex + 1} (${completeAssessments[selectedIndex].risk_level}) безопаснее окна ${otherIndex + 1} (${completeAssessments[otherIndex].risk_level}). Рекомендация: ${completeAssessments[selectedIndex].recommendation}.`;
        const result = {
          windows: windows.map((window, index) => ({
            window_id: `window-${index + 1}`,
            start_at: window.start_at,
            duration_hours: window.duration_hours,
            assessment: completeAssessments[index]
          })),
          selected_indices: selectedIndices,
          tie: tied,
          explanation
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false
        };
      } catch (error) {
        const message = error instanceof WeatherDataError
          ? WEATHER_UNAVAILABLE_MESSAGE
          : error instanceof InputError
            ? error.message
            : "Не удалось сравнить погодные окна. Попробуйте позже.";
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true
        };
      }
    }
  );

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const healthServer = startHealthServer(process.env.HEALTH_PORT);
  console.error("weather-mcp is running over STDIO");
  process.stdin.once("end", () => healthServer?.close());
  serveStdio(() => createServer());
}
