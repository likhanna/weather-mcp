HW-WEATHER-Khannanova

# Проверка реализации

## Автоматические проверки

- Команда: `npm run ci` в `weather-mcp`.
- Первый запуск в sandbox: TypeScript build прошёл; Node test runner не стартовал: все дочерние процессы завершились с `uv_os_get_passwd returned ENOMEM` (`node:os.userInfo`).
- Повторный запуск вне sandbox: exit code `0`; сборка `tsc -p tsconfig.json` прошла; Node test runner: **39 passed, 0 failed, 0 skipped**.
- Property/generative тест: 1,000 детерминированных диапазонов проверены против oracle.

## Ручная проверка через MCP Inspector CLI

Использован Inspector 2.7.0 и локальная сессия STDIO. Вызов `tools/list` завершился с exit code `0` и показал ровно четыре инструмента, включая `find_safe_weather_window`.

Успешный вызов (Inspector CLI, Open-Meteo live forecast), exit code `0`:

```powershell
npx @modelcontextprotocol/inspector --cli --config dist/inspector-config.json --server weather --format json --method tools/call --tool-name find_safe_weather_window --tool-args-json '{"city":"Dubai, United Arab Emirates","work_type":"maintenance","search_start":"2026-09-28T08:00","search_end":"2026-09-28T18:00","duration_hours":3}'
```

Фактический результат: `candidates_checked=8`; выбран интервал `2026-09-28T13:00`–`16:00` по Москве, риск `MEDIUM`, рекомендация `REVIEW`; возвращены 3 альтернативы. Ответ содержал `location`, `source=Open-Meteo` и UTC `fetched_at`. Время и прогноз зависят от live-данных.

Контролируемый отказ (длительность `9` выходит за разрешённый диапазон), Inspector сообщил `isError=true`, `structuredContent` отсутствовал; CLI exit code `1` соответствует ошибке tool:

```powershell
npx @modelcontextprotocol/inspector --cli --config dist/inspector-config.json --server weather --format json --method tools/call --tool-name find_safe_weather_window --tool-args-json '{"city":"Dubai, United Arab Emirates","work_type":"maintenance","search_start":"2026-09-28T08:00","search_end":"2026-09-28T18:00","duration_hours":9}'
```

Сообщение MCP: `Input validation error: Invalid arguments for tool find_safe_weather_window: duration_hours: Too big: expected number to be <=8`.

## Известные ограничения

- Успешный ручной вызов зависит от текущей доступности Open-Meteo. Sandbox запрос вернул контролируемую ошибку; тот же вызов с разрешённым сетевым доступом прошёл.
- Рабочая папка `weather-mcp` не содержит `.git`; ветка и исходная ревизия для этого задания недоступны. README проекта прямо допускает работу без Git.
- Inspector API token не сохранялся в отчётах.
