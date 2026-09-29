import type { RiskFactor, RiskLevel } from "./risk.js";

export interface RankableWeatherWindow {
  start_at: string;
  start_utc_ms: number;
  risk_level: RiskLevel;
  factors: RiskFactor[];
}

const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function rankWeatherWindows<T extends RankableWeatherWindow>(windows: T[]): T[] {
  return [...windows].sort((left, right) =>
    RISK_RANK[left.risk_level] - RISK_RANK[right.risk_level] ||
    left.factors.length - right.factors.length ||
    left.start_utc_ms - right.start_utc_ms,
  );
}
