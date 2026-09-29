HW-WEATHER-Khannanova

# Анализ влияния — HW-WEATHER-Khannanova

Добавляется один MCP tool. Публичные контракты `get_weather`, `assess_weather_risk`, `compare_weather_windows` и инфраструктура остаются прежними.

| Файл | Изменение | Потребители / риск |
|---|---|---|
| `weather-mcp/src/index.ts` | Отдельные Zod schema, registration, handler, structuredContent proposal | MCP clients; поля закрепить в v2, старые handlers не менять. |
| `weather-mcp/src/time.ts` | Новая диапазонная валидация и кандидатный генератор; не менять `parseWorkPeriod` | Новый tool/tests; off-by-one по минутам влияет на состав окон. |
| `weather-mcp/src/open-meteo.ts` | Новый метод exact geocode + один forecast + coverage + полный список оценок | Open-Meteo; отсутствующий крайний час должен дать полный controlled отказ. |
| `weather-mcp/src/risk.ts` | Без изменений, использовать `assessRisk` | Пороги общие; `factors.length` — предложенный tie-break, события час+метрика. |
| `weather-mcp/README.md` | Описание нового входа и результата | Клиенты; синхронизировать с утверждённой схемой. |
| `weather-mcp/test/*` | Генеративные, unit, MCP и regression checks | CI; фиксированный seed/exhaustive oracle для воспроизводимости без новой зависимости. |

Поток: schema → единый now → candidates → exact geocoding → один forecast → coverage validation → `assessRisk` по окнам → сортировка → полный MCP response. Unknown/ambiguous не выбирается и не запускает forecast. Сетевой/структурный сбой не возвращает partial result. Один внешний запрос относится к forecast; geocoding остаётся отдельным.

Основные риски: дальний forecast coverage, границы минут и регрессия прежних контрактов. Снижение: валидировать весь диапазон до fetch, проверять все hourly buckets до результата, добавлять assertions прежних MCP интерфейсов. Предлагаемая полуоткрытая граница и агрегация передаются Critic, не task facts. Миграции нет; откат — revert только новых блоков/тестов/README. До approval v2 никаких исходников.
