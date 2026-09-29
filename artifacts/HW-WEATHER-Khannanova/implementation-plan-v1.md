HW-WEATHER-Khannanova

# План реализации v1 — HW-WEATHER-Khannanova

**Статус:** черновик для Critic. Исходники не менять до явного одобрения пользователя implementation-plan-v2.md. CI/тесты/MCP не запускались.

## Минимальное решение

Добавить диапазонный parser и генератор кандидатов в `weather-mcp/src/time.ts` без изменения `parseWorkPeriod`; отдельный поиск в `weather-mcp/src/open-meteo.ts`; новую Zod-схему, регистрацию и результат в `weather-mcp/src/index.ts`. Сначала валидировать ввод по одному `now`, затем создать кандидатов, exact-match геокодировать, получить один общий forecast, проверить все требуемые buckets, вызвать существующий `assessRisk` для каждого окна, отсортировать и вернуть только полный результат. Не вызывать `assess()` по каждому кандидату (это сделает несколько прогнозных запросов). Пороги риска не копировать. Старые три MCP tools не менять.

## Рекомендуемые трактовки для Critic (не task facts)

- Диапазон `[search_start, search_end)`, строки текущего формата Moscow `YYYY-MM-DDTHH:mm`, минуты допустимы. Старт кандидата — первый полный час `>= search_start`; конец окна `<= search_end` допустим.
- Один snapshot now: `search_start >= now`, `search_end > search_start`, `search_end <= now+5 суток`; invalid input отвергается до запросов.
- Окно оценивается `assessRisk` по всем часам; риск — существующий максимум. Tie-break count = `factors.length` (события час+метрика).
- Один общий UTC forecast запрос после геокодирования; предварительно `forecast_days=6` и те же hourly variables. Валидировать coverage крайнего часа и весь набор до любого успешного ответа. Любая ошибка — controlled отказ без частичного результата.
- **Предложение structuredContent, не установленный факт:** `{selected, alternatives, candidates_checked, city, source, fetched_at, work_type}`; selected/alternative `{start_at, end_at, duration_hours, risk_level, recommendation, factors}`; city `{city, region?, country, timezone}`; source `Open-Meteo`; времена окон Moscow `YYYY-MM-DDTHH:mm`. Альтернативы — следующие максимум три результата. Закрепить поля только в v2.

## Этапы и проверки

1. **Время/кандидаты** — `src/time.ts`, `test/risk-time.test.mjs` либо новый suite. Проверить календарь, границы, полный список почасовых стартов, duration 1/8, минутные :00/:01/:59, точное совпадение конца, пустой набор. Риск off-by-one снижается сохранением прежнего parser.
2. **Прогноз/оценка** — `src/open-meteo.ts`, текущий `test/open-meteo.test.mjs` или новый suite. Mock должен показать ровно 1 geocoding и 1 forecast на success; unknown/ambiguous без forecast; network/HTTP/JSON/missing buckets без partial result. Риск: дальний bucket может отсутствовать, в таком случае отказать целиком.
3. **MCP/API** — `src/index.ts`, `test/mcp-health.test.mjs` и MCP integration suite. Проверить точное имя, Zod duration, старые три имени/контракта без изменений, MCP errors и предложенный ответ.
4. **Docs и приёмка** — `README.md` и regression suites. После approval выполнить `npm run ci`, затем Inspector `npx @modelcontextprotocol/inspector node dist/index.js` (либо Codex) для реального success и controlled refusal; записать только фактическое в verification.md.

## Генеративные проверки и открытые пункты

Детерминированная property-based проверка >=1,000 сгенерированных диапазонов: oracle сравнивает точный список допустимых стартов; проверяются alignment, start/end bounds, длительность, уникальность и перестановочная инвариантность ранжирования `(risk rank, factors.length, start)`. Предпочесть штатный node:test с seed, без dependency.

Вопросы `questions.md` получают предложения выше для Critic, они не являются ответом пользователя и не меняют task facts. Если Critic находит блокирующее несогласие — пометить план BLOCKED и запросить решение; иначе зафиксировать рекомендуемые правила/публичные поля в implementation-plan-v2 и запросить явное approval. Миграции нет; rollback — revert аддитивных исходников, тестов и README. Verification/final-review не заполнять заранее.
