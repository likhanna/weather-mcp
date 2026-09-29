const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_FORECAST_MS = 5 * 24 * HOUR_MS;
const NO_CANDIDATE_MESSAGE = "В заданном интервале нет подходящих почасовых окон для указанной длительности.";

export class InputError extends Error {}

export interface WorkPeriod {
  start: Date;
  end: Date;
}

export interface SearchInterval extends WorkPeriod {}

export interface CandidateWindow extends WorkPeriod {
  start_at: string;
  end_at: string;
  duration_hours: number;
}

function parseMoscowDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new InputError("Дата и время должны иметь формат YYYY-MM-DDTHH:mm по МСК.");
  }
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day ||
    localAsUtc.getUTCHours() !== hour ||
    localAsUtc.getUTCMinutes() !== minute
  ) {
    throw new InputError("Указана несуществующая дата или время.");
  }
  return new Date(localAsUtc.getTime() - MOSCOW_OFFSET_MS);
}

export function formatMoscowDateTime(value: Date): string {
  return new Date(value.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 16);
}

export function parseSearchInterval(
  searchStart: string,
  searchEnd: string,
  now = new Date(),
): SearchInterval {
  const start = parseMoscowDateTime(searchStart);
  const end = parseMoscowDateTime(searchEnd);
  if (end.getTime() <= start.getTime()) {
    throw new InputError("Конец интервала поиска должен быть позже его начала.");
  }
  if (start.getTime() < now.getTime()) {
    throw new InputError("Начало интервала поиска должно быть не раньше текущего момента.");
  }
  if (end.getTime() > now.getTime() + MAX_FORECAST_MS) {
    throw new InputError("Интервал поиска должен завершиться не позднее пяти суток от текущего момента.");
  }
  return { start, end };
}

export function generateCandidateWindows(
  interval: SearchInterval,
  durationHours: number,
): CandidateWindow[] {
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 8) {
    throw new InputError("Продолжительность должна быть целым числом от 1 до 8 часов.");
  }

  const durationMs = durationHours * HOUR_MS;
  const firstStart = Math.ceil(interval.start.getTime() / HOUR_MS) * HOUR_MS;
  const windows: CandidateWindow[] = [];
  for (let startMs = firstStart; startMs + durationMs <= interval.end.getTime(); startMs += HOUR_MS) {
    const start = new Date(startMs);
    const end = new Date(startMs + durationMs);
    windows.push({
      start,
      end,
      start_at: formatMoscowDateTime(start),
      end_at: formatMoscowDateTime(end),
      duration_hours: durationHours,
    });
  }
  if (windows.length === 0) throw new InputError(NO_CANDIDATE_MESSAGE);
  return windows;
}

export function parseWorkPeriod(startAt: string, durationHours: number, now = new Date()): WorkPeriod {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startAt);
  if (!match) {
    throw new InputError("Дата и время должны иметь формат YYYY-MM-DDTHH:mm по МСК.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day ||
    localAsUtc.getUTCHours() !== hour ||
    localAsUtc.getUTCMinutes() !== minute
  ) {
    throw new InputError("Указана несуществующая дата или время.");
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new InputError("Продолжительность должна быть положительным числом часов.");
  }

  const start = new Date(localAsUtc.getTime() - MOSCOW_OFFSET_MS);
  const end = new Date(start.getTime() + durationHours * HOUR_MS);
  if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) {
    throw new InputError("Продолжительность работ слишком мала для оценки прогноза.");
  }
  if (start.getTime() < now.getTime()) {
    throw new InputError("Начало работ должно быть не раньше текущего момента.");
  }
  if (end.getTime() > now.getTime() + MAX_FORECAST_MS) {
    throw new InputError("Работы должны завершиться не позднее пяти суток от текущего момента.");
  }
  return { start, end };
}

export function intersectsHour(hourStart: Date, period: WorkPeriod): boolean {
  return hourStart.getTime() < period.end.getTime() && hourStart.getTime() + HOUR_MS > period.start.getTime();
}
