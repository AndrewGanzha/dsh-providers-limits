# dsh-provider-limits

[![CI](https://github.com/OWNER/dsh-provider-limits/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dsh-provider-limits/actions/workflows/ci.yml)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
shows the subscription limits of your AI providers — the 5-hour, weekly and
monthly windows — right in the composer dock.

![Provider limits in the composer dock](docs/preview.svg)

```
OpenCode Go 5h 2% wk 1% mo 0%    Z.AI GLM ✕
```

- one compact line under the composer, refreshed every minute;
- **click it** to open a details panel: every window, a progress bar, the exact
  reset time and a countdown, plus provider errors and the config path;
- **add a provider from the panel** — the `+ Добавить` button lists the known
  presets (showing whether their key is reachable) and accepts a custom JSON
  entry; `×` removes a provider (a second click confirms);
- the provider list is a plain JSON file you edit yourself, and the panel writes
  to the same file — no separate state;
- one broken provider never hides the others: it just shows `✕` (the reason is
  in the details panel);
- credentials stay on your machine: the Host half calls the providers, the
  browser only receives percentages.

## Install

1. Get the code:

   ```bash
   git clone https://github.com/OWNER/dsh-provider-limits.git
   ```

2. In DeepSeek Harness open **Plugins → Add plugin** and pick the cloned
   directory. Alternatively let an agent install it with the `plugin_manager`
   tool: `install_bundle` with the absolute path to the directory.

3. Reload the window (Ctrl+R). The client half loads with the page.

The plugin appears under **Plugins** with its own title, description and icon.

## Configure

`~/.dsh/provider-limits.json` is created on first use, pre-filled with the
providers already connected to [OpenCode](https://opencode.ai) (its
`auth.json` is used for keys). Edit it and the next refresh picks the changes
up — no restart.

```jsonc
{
  "timeoutSeconds": 12,
  "providers": [
    { "id": "opencode-go",     "preset": "opencode-go", "enabled": true },
    { "id": "zai-coding-plan", "preset": "zai",         "enabled": true }
  ]
}
```

`enabled: false` keeps a provider in the file without polling it.

### Add a provider from the panel

Click the limits line → **+ Добавить**:

- pick a preset — the plugin shows `ключ найден` / `ключ не найден` so you know
  whether the credential is already reachable, and appends the entry;
- or paste a custom provider JSON (the template is pre-filled) — the Host
  validates it, writes the file atomically and refreshes the data.

Nothing is stored twice: the form edits `~/.dsh/provider-limits.json` directly,
so hand edits and panel edits are the same thing. Invalid input comes back as a
readable message instead of a broken config; an unparsable file is never
overwritten.

`×` next to a provider removes it after a confirming second click.

### Presets

| preset | windows | key source |
| --- | --- | --- |
| `opencode-go` | 5h, weekly, monthly | `~/.local/share/opencode/auth.json` → `opencode-go` |
| `zai` | 5h, weekly, MCP bucket | same file → `zai-coding-plan`, else `ZHIPU_API_KEY` |
| `anthropic` | 5h, 7d | `anthropic` entry or `~/.claude/.credentials.json` |
| `openai-codex` | 5h, weekly | `~/.codex/auth.json` |
| `copilot` | premium requests | `github-copilot` entry |
| `custom` | whatever you map | you choose |

### Any other provider

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

- `percentPath` — used percent (0–100), or `usedPath` + `totalPath`;
- `resetPath` — reset time as ISO 8601, epoch seconds or milliseconds;
- paths use dots and array indexes: `usage.limits[0].percentage`;
- `auth.from`: `opencode`, `env`, `file` (+ `json` path), `codex`, `literal`;
- `${env:NAME}` works in `url` and header values.

A provider without an HTTP API can run a command that prints JSON on stdout:

```jsonc
{ "id": "local-gw", "type": "command", "command": "node C:/tools/limits.js",
  "windows": [{ "label": "5h", "percentPath": "used_percent", "resetPath": "reset_at" }] }
```

## Layout

| file | role |
| --- | --- |
| `index.js` | Host half: reads the config, polls providers, serves `GET /api/provider.limits` |
| `client.js` | Web client half: the dock line and the details overlay |
| `cordis.patch.yml` | bundle patch that inserts the plugin row |
| `locale/{en,ru}.json` | Plugin Manager title and description |
| `docs/DETAIL.md` | In-app details page |

The two halves talk over the Host's authenticated fetch route; the browser never
sees a provider key.

## Development

```bash
node --check index.js
node --check client.js
node --test test/        # host + client unit tests, no network
node scripts/check.js    # live probe of the configured providers
```

`scripts/check.js` prints the same data the panel shows, which is the fastest way
to debug a provider entry.

## Notes and limitations

- Web surface only: the dock line is part of the web client, so a DSH build
  without it shows nothing (the Host route and `/api/provider.limits` still work).
- The panel text is Russian; the repository and this README are English. PRs to
  localize the UI strings are welcome.
- Provider APIs change; that is why every field path lives in the config.

## License

MIT — see [LICENSE](LICENSE).
