# Лимиты провайдеров

![Строка лимитов в панели ввода](preview.svg)

Плагин показывает остаток подписочных лимитов (5 часов, неделя, месяц) по тем
провайдерам, которые перечислены в `~/.dsh/provider-limits.json`.

Строка появляется под полем ввода и обновляется раз в минуту. **Клик по строке**
открывает панель с подробностями: процент и шкала по каждому окну, точное время
и обратный отсчёт до сброса, ошибки провайдеров, путь к конфигу и кнопка
«Обновить».

Цвет процента: зелёный — меньше 70 %, жёлтый — от 70 %, красный — 100 % или
ошибка. `✕` обозначает, что провайдер не ответил; причина видна в подробностях.

## Настройка

Файл `~/.dsh/provider-limits.json` создаётся при первом запуске и заполняется
провайдерами, уже подключёнными в OpenCode (ключи берутся из его `auth.json`).
Файл перечитывается автоматически.

```jsonc
{
  "timeoutSeconds": 12,
  "providers": [
    { "id": "opencode-go",     "preset": "opencode-go", "enabled": true },
    { "id": "zai-coding-plan", "preset": "zai",         "enabled": true }
  ]
}
```

`enabled: false` оставляет провайдера в конфиге, но не опрашивает его.

## Пресеты

| preset | что показывает | ключ |
| --- | --- | --- |
| `opencode-go` | 5h, неделя, месяц | `~/.local/share/opencode/auth.json` → `opencode-go` |
| `zai` | 5h, неделя, MCP | тот же файл → `zai-coding-plan`, иначе `ZHIPU_API_KEY` |
| `anthropic` | 5h, 7d | `anthropic` в auth.json или `~/.claude/.credentials.json` |
| `openai-codex` | 5h, неделя | `~/.codex/auth.json` |
| `copilot` | premium requests | `github-copilot` в auth.json |
| `custom` | шаблон | задаётся вручную |

## Свой провайдер

```jsonc
{
  "id": "my-gateway",
  "label": "My Gateway",
  "url": "https://api.example.com/usage",
  "headers": { "Accept": "application/json" },
  "auth": { "from": "env", "name": "MY_GATEWAY_TOKEN" },
  "windows": [
    { "label": "5h", "percentPath": "usage.rolling.percent", "resetPath": "usage.rolling.resetsAt" },
    { "label": "mo", "usedPath": "used", "totalPath": "total", "resetPath": "resets_at" }
  ]
}
```

Источники ключа (`auth.from`): `opencode` (ключ из auth.json OpenCode), `env`,
`file` (+ `json` — путь внутри файла), `codex`, `literal`.
`${env:NAME}` подставляется в `url` и `headers`.

Провайдер без HTTP API описывается как `{"type": "command", "command": "..."}`:
команда должна напечатать JSON в stdout.

## Ограничения

- Плагин работает в веб-интерфейсе DSH: строка живёт в панели ввода.
- Ключи не покидают машину — запросы к провайдерам делает Host, браузер
  получает только проценты.
- Форматы ответов у провайдеров меняются, поэтому пути к полям вынесены
  в конфиг.
