HW-WEATHER-Khannanova

# Контекст реализации — HW-WEATHER-Khannanova

Использовать после approval `implementation-plan-v2.md`.

- Task key/spec/questions: `task.json`, `task-spec.json`, `task-spec.md`, `questions.md`; карта: `repo-map.md`; ограничения: `prompts/homework-weather-mcp.md`.
- `weather-mcp/src/index.ts`: регистрация трёх MCP tools, Zod, handlers и error/result mapping.
- `weather-mcp/src/time.ts`: `parseWorkPeriod` строгий Moscow `YYYY-MM-DDTHH:mm`, UTC+3, now/five-day check; `intersectsHour` полуоткрытый. Добавить range helpers, не менять старую функцию.
- `weather-mcp/src/open-meteo.ts`: `OpenMeteoRiskService.assess` уже делает exact geocoding, not_found/ambiguous, один forecast и coverage validation; ошибки контролируемы.
- `weather-mcp/src/risk.ts`: `assessRisk` — общие thresholds, max aggregation и factors per hour+metric.
- `weather-mcp/package.json`: `npm run ci` = build + node:test. Suites: `test/risk-time.test.mjs`, `open-meteo.test.mjs`, `compare-weather-windows.test.mjs`, `mcp-health.test.mjs`.
- План: отдельный service path получает общий прогноз один раз, затем режет часы по кандидатам и вызывает assessRisk. Не вызывать assess на кандидата; старые tools не менять.
- Предложения для Critic, не факты: `[start,end)`, допустимые минуты, старт ceil к часу, конец <= search_end; start>=now/end<=now+5d; max risk и `factors.length` tie-break. StructuredContent proposal и тесты описаны в plan-v1/test-matrix, закрепить в v2.
- Не включать `node_modules`, dist, секреты или весь репозиторий.
