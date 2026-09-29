HW-WEATHER-Khannanova

# Матрица тестирования — HW-WEATHER-Khannanova

План; тесты не запускались.

| ID | Сценарий | Проверяемый результат |
|---|---|---|
| T01 | duration 1,8 и invalid 0,9, дробь/строка; bad city/work_type | Только integer 1..8; invalid до fetch (0 внешних вызовов). |
| T02 | bad format/date, empty/reversed, start<now, end>now+5d | Controlled error до geocoding; единый now snapshot. |
| T03 | start :00/:01/:59 | Первый старт ceil к полной границе; все starts в :00. |
| T04 | candidate end==search_end, превышение на минуту, короткий range | Равенство допускается по предложению; выход исключён; пустой набор controlled error. |
| T05 | duration 1/8 и границы | Каждый интервал внутри поиска; генерация совпадает с независимым oracle. |
| T06 | >=1000 seeded диапазонов | Полнота oracle, alignment, границы, длительность, отсутствие дублей. |
| T07 | Генеративные risk/factor/start и перестановки | Сортировка tuple `(risk rank,factors.length,start)` неизменна от перестановки. |
| T08 | Несколько risk hours и одинаковый risk с разным factors | Сходится с `assessRisk` max; count=`factors.length` (час+метрика), затем раннее окно. |
| T09 | exact / not_found / ambiguous geocoding | Forecast calls 1/0/0; ambiguity не auto-select. |
| T10 | Success с несколькими кандидатами | 1 geocoding + ровно 1 forecast; checked = всех оценённых кандидатов. |
| T11 | Network/timeout/HTTP/JSON/error:true/missing forecast bucket | Controlled error; отсутствуют selected, alternatives и partial structuredContent. |
| T12 | >=5 кандидатов | selected первый, alternatives следующие максимум 3; count и metadata присутствуют. |
| T13 | MCP compatibility | Старые 3 схемы/results/errors прежние; tool list +1. |
| T14 | `npm run ci` | Exit 0, build и tests failed=0. |
| T15 | Inspector/Codex success + controlled refusal | Два фактических вызова записаны в verification без секретов. |
| T16 | `search_start=10:30`, `search_end=13:00`, duration 2 | Единственный кандидат 11:00–13:00 использует buckets 11 и 12; bucket 10 не требуется. |
| T17 | Максимальный горизонт `now+5d` | Последний bucket, необходимый любому кандидату, включён в единичный прогноз и валидируется; `now+5d+1min` отклоняется до сети. |
| T18 | Отказ в последнем bucket после расчёта ранних окон | Весь вызов завершается controlled error без выбранного окна/альтернатив/partial structuredContent. |
| T19 | Длительность 8 и граничный риск во всех часах | `factors.length` не выше `3 × 8 = 24`; risk соответствует существующему `assessRisk`. |
| T20 | Уникальность генератора и перестановка списка | Не более одного кандидата на start; сортировка уникального набора независима от порядка входа. |
| T21 | Ноль подходящих кандидатов | MCP `isError: true`, стабильное сообщение, `structuredContent` отсутствует. |
| T22 | Много кандидатов с равными риском/факторами | Более ранний start первый; `candidates_checked` считает все оценённые, alternatives максимум три. |
| T23 | Получение метаданных при свежем запросе | Новый flow не использует кэш; `fetched_at` — UTC время получения forecast response; один forecast на успешный вызов. |

Генеративные тесты должны быть детерминированными (seed/exhaustive grid) и без новой зависимости, если достаточно штатного node:test. T14–T15 выполняются после approval/реализации; не заполнять результат заранее.
