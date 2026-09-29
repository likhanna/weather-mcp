export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type Recommendation = "PROCEED" | "REVIEW" | "CANCEL";

export interface HourlyWeather {
  time: string;
  temperature_c: number;
  precipitation_probability_percent: number;
  wind_speed_ms: number;
}

export interface RiskFactor {
  time: string;
  metric: "temperature_c" | "precipitation_probability_percent" | "wind_speed_ms";
  value: number;
  level: "MEDIUM" | "HIGH";
}

export function assessRisk(hours: HourlyWeather[]): {
  risk_level: RiskLevel;
  recommendation: Recommendation;
  factors: RiskFactor[];
} {
  if (hours.length === 0) {
    throw new Error("Нельзя оценить риск без почасового прогноза.");
  }
  const factors: RiskFactor[] = [];
  for (const hour of hours) {
    const checks: Array<{ metric: RiskFactor["metric"]; value: number; level: RiskFactor["level"] | null }> = [
      {
        metric: "precipitation_probability_percent" as const,
        value: hour.precipitation_probability_percent,
        level: hour.precipitation_probability_percent >= 70 ? "HIGH" : hour.precipitation_probability_percent >= 40 ? "MEDIUM" : null
      },
      {
        metric: "wind_speed_ms" as const,
        value: hour.wind_speed_ms,
        level: hour.wind_speed_ms >= 15 ? "HIGH" : hour.wind_speed_ms >= 10 ? "MEDIUM" : null
      },
      {
        metric: "temperature_c" as const,
        value: hour.temperature_c,
        level: hour.temperature_c < -15 || hour.temperature_c > 40 ? "HIGH" : hour.temperature_c < -5 || hour.temperature_c > 32 ? "MEDIUM" : null
      }
    ];
    for (const check of checks) {
      if (check.level) {
        factors.push({ time: hour.time, metric: check.metric, value: check.value, level: check.level });
      }
    }
  }
  const risk_level: RiskLevel = factors.some((factor) => factor.level === "HIGH")
    ? "HIGH"
    : factors.length > 0
      ? "MEDIUM"
      : "LOW";
  const recommendation: Recommendation = risk_level === "HIGH" ? "CANCEL" : risk_level === "MEDIUM" ? "REVIEW" : "PROCEED";
  return { risk_level, recommendation, factors };
}
