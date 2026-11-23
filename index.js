/**
 * Provider limits — Host half.
 *
 * Reads a user-editable provider list, asks each provider for its subscription
 * quota, and exposes the result to the Web Client at GET /api/provider.limits.
 * The Client half (client.js) renders it in the composer dock.
 *
 * Config: %USERPROFILE%\.dsh\provider-limits.json (created on first use).
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'provider-limits'
export const inject = ['connection']

export const ROUTE = '/api/provider.limits'
const CACHE_MS = 20_000

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESETS = {
  // OpenCode Go / Go Plus / Go Teams — official usage endpoint.
  'opencode-go': {
    label: 'OpenCode Go',
    url: 'https://opencode.ai/inference/go/v1/usage',
    auth: { from: 'opencode', provider: 'opencode-go' },
    windows: [
      { label: '5h', percentPath: 'usage.rolling.percent', resetPath: 'usage.rolling.resetsAt', statusPath: 'usage.rolling.status' },
      { label: 'wk', percentPath: 'usage.weekly.percent', resetPath: 'usage.weekly.resetsAt', statusPath: 'usage.weekly.status' },
      { label: 'mo', percentPath: 'usage.monthly.percent', resetPath: 'usage.monthly.resetsAt', statusPath: 'usage.monthly.status' },
    ],
  },

  // Z.AI GLM Coding Plan — unit 3 is the 5-hour window, unit 6 the weekly one;
  // TIME_LIMIT is the MCP bucket. The key goes in Authorization without Bearer.
  zai: {
    label: 'Z.AI GLM',
    url: 'https://api.z.ai/api/monitor/usage/quota/limit',
    auth: { from: 'opencode', provider: 'zai-coding-plan', fallbackEnv: ['ZHIPU_API_KEY', 'ZAI_API_KEY'] },
    authHeader: 'raw',
    auto: 'zai',
  },

  // Anthropic Claude subscription (Claude Code OAuth).
  anthropic: {
    label: 'Claude',
    url: 'https://api.anthropic.com/api/oauth/usage',
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    auth: { from: 'opencode', provider: 'anthropic', fallbackClaudeCode: true },
    auto: 'anthropic',
  },

  // OpenAI Codex / ChatGPT subscription.
  'openai-codex': {
    label: 'Codex',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    auth: { from: 'codex' },
    auto: 'codex',
  },

  // GitHub Copilot premium requests.
  copilot: {
    label: 'Copilot',
    url: 'https://api.github.com/copilot_internal/user',
    headers: {
      Accept: 'application/json',
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot-chat/0.26.0',
      'User-Agent': 'GitHubCopilotChat/0.26.0',
    },
    auth: { from: 'opencode', provider: 'github-copilot', fallbackGitHubCopilot: true },
    auto: 'copilot',
  },

  // Template for any other provider.
  custom: {
    label: 'Custom',
    url: '',
    auth: { from: 'env', name: 'MY_PROVIDER_API_KEY' },
    windows: [{ label: '5h', percentPath: 'usage.percent', resetPath: 'usage.resetsAt' }],
  },
}

export const KNOWN_AUTH_PRESETS = {
  'opencode-go': 'opencode-go',
  zai: 'zai',
  'zai-coding-plan': 'zai',
  anthropic: 'anthropic',
  'github-copilot': 'copilot',
  copilot: 'copilot',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function getByPath(value, path) {
  if (!path) return undefined
  let current = value
  for (const token of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[token]
  }
  return current
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function asDate(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    const date = new Date(value > 1e12 ? value : value * 1000)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return asDate(numeric)
  }
  return undefined
}

function clampPercent(value) {
  if (value === undefined) return undefined
  return Math.round(Math.min(100, Math.max(0, value)))
}

function ratioPercent(used, total) {
  const u = asNumber(used)
  const t = asNumber(total)
  if (u === undefined || t === undefined || t <= 0) return undefined
  return (u / t) * 100
}

function interpolate(template) {
  return String(template).replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, key) => process.env[key] ?? '')
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function configPath() {
  return process.env.DSH_PROVIDER_LIMITS_CONFIG ?? join(homedir(), '.dsh', 'provider-limits.json')
}

function authFile() {
  if (process.env.OPENCODE_AUTH_FILE) return process.env.OPENCODE_AUTH_FILE
  const candidates = []
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  candidates.push(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'))
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}

export function readAuth() {
  return readJson(authFile()) ?? {}
}

export function mergeProvider(entry) {
  const preset = (entry.preset && PRESETS[entry.preset]) || {}
  const merged = { type: 'http', ...preset, ...entry }
  const presetWindows = Array.isArray(preset.windows) ? preset.windows : []
  const entryWindows = Array.isArray(entry.windows) ? entry.windows : []
  if (presetWindows.length > 0 && entryWindows.length > 0) {
    merged.windows = entryWindows.map((window, index) => ({ ...(presetWindows[index] ?? {}), ...window }))
  } else if (entryWindows.length > 0) {
    merged.windows = entryWindows
  } else if (presetWindows.length > 0) {
    merged.windows = presetWindows
  } else {
    merged.windows = []
  }
  if (preset.headers || entry.headers) merged.headers = { ...(preset.headers ?? {}), ...(entry.headers ?? {}) }
  if (preset.auth || entry.auth) merged.auth = { ...(preset.auth ?? {}), ...(entry.auth ?? {}) }
  return merged
}

export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const providers = (Array.isArray(config.providers) ? config.providers : [])
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => {
      const merged = mergeProvider(entry)
      return { ...merged, enabled: merged.enabled !== false, label: merged.label || merged.id }
    })
  return {
    timeoutSeconds: Math.min(300, Math.max(3, asNumber(config.timeoutSeconds) ?? 12)),
    providers,
  }
}

export function starterConfig(auth = readAuth()) {
  const providers = []
  const seen = new Set()
  for (const id of Object.keys(auth)) {
    const preset = KNOWN_AUTH_PRESETS[id]
    if (!preset || seen.has(preset)) continue
    seen.add(preset)
    providers.push({ id, preset, enabled: true })
  }
  if (providers.length === 0) providers.push({ id: 'opencode-go', preset: 'opencode-go', enabled: true })
  return { timeoutSeconds: 12, providers }
}

export function loadConfig(file = configPath()) {
  const exists = existsSync(file)
  const raw = exists ? readJson(file) : undefined
  if (exists && raw === undefined) {
    return { config: normalizeConfig(undefined), path: file, error: 'provider-limits.json: не удалось разобрать JSON' }
  }
  if (!exists) {
    // First run only: never replace a config that already exists, even a
    // truncated or empty one the user is in the middle of editing.
    const starter = starterConfig()
    try {
      writeFileSync(file, JSON.stringify(starter, null, 2) + '\n', 'utf8')
      return { config: normalizeConfig(starter), path: file, created: true }
    } catch (error) {
      return { config: normalizeConfig(starter), path: file, error: `не удалось создать конфиг: ${error?.message ?? error}` }
    }
  }
  return { config: normalizeConfig(raw), path: file }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function jwtClaim(token, key) {
  try {
    const payload = String(token).split('.')[1]
    if (!payload) return undefined
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return key ? JSON.parse(decoded)?.[key] : JSON.parse(decoded)
  } catch {
    return undefined
  }
}

function codexAuth() {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const data = readJson(join(home, 'auth.json'))
  const token = data?.tokens?.access_token
  if (!token) return undefined
  const account = jwtClaim(token, 'https://api.openai.com/auth')?.chatgpt_account_id
  return { token, headers: account ? { 'chatgpt-account-id': account } : {} }
}

function copilotToken() {
  const files = [join(homedir(), '.config', 'opencode', 'copilot.json')]
  if (process.env.GH_CONFIG_DIR) files.push(join(process.env.GH_CONFIG_DIR, 'hosts.yml'))
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      if (file.endsWith('.json')) {
        const data = JSON.parse(text)
        const token = data.oauth_token ?? data.access_token ?? data.token
        if (token) return token
      } else {
        const match = text.match(/oauth_token:\s*(\S+)/)
        if (match) return match[1]
      }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

export function resolveAuth(spec, auth = readAuth()) {
  if (!spec) return undefined
  const plain = (token) => (token ? { token, headers: {} } : undefined)
  switch (spec.from ?? 'opencode') {
    case 'opencode': {
      const entry = spec.provider ? auth[spec.provider] : undefined
      if (entry?.access) return plain(entry.access)
      if (entry?.key) return plain(entry.key)
      for (const key of spec.fallbackEnv ?? []) {
        if (process.env[key]) return plain(process.env[key])
      }
      if (spec.fallbackClaudeCode) {
        return plain(readJson(join(homedir(), '.claude', '.credentials.json'))?.claudeAiOauth?.accessToken)
      }
      if (spec.fallbackGitHubCopilot) return plain(copilotToken())
      return undefined
    }
    case 'env':
      return plain(spec.name ? process.env[spec.name] : undefined)
    case 'file': {
      const file = spec.path ? interpolate(spec.path) : undefined
      if (!file) return undefined
      const data = readJson(file)
      return plain(spec.json ? getByPath(data, spec.json) : data)
    }
    case 'codex':
      return codexAuth()
    case 'literal':
      return plain(spec.value)
    default:
      return undefined
  }
}

function describeAuth(spec) {
  if (!spec) return 'не настроен'
  switch (spec.from ?? 'opencode') {
    case 'env':
      return `переменная ${spec.name ?? '?'}`
    case 'file':
      return `файл ${spec.path ?? '?'}`
    case 'codex':
      return '~/.codex/auth.json'
    case 'literal':
      return 'значение в provider-limits.json'
    default:
      return `opencode auth "${spec.provider ?? '?'}"`
  }
}

// ---------------------------------------------------------------------------
// Fetching and parsing
// ---------------------------------------------------------------------------

function errorMessage(body) {
  if (!body || typeof body !== 'object') return undefined
  return body?.error?.message ?? body?.message ?? body?.error ?? body?.detail
}

async function fetchJson(provider, timeoutSeconds, auth) {
  const url = interpolate(provider.url ?? '')
  if (!url) throw new Error('url не задан')
  const token = resolveAuth(provider.auth, auth)
  const headers = {}
  for (const [key, value] of Object.entries(provider.headers ?? {})) headers[key] = interpolate(String(value))
  if (token?.token) {
    if (provider.authHeader === 'raw') headers.Authorization = token.token
    else if (typeof provider.authHeader === 'string') headers.Authorization = `${provider.authHeader} ${token.token}`
    else headers.Authorization = `Bearer ${token.token}`
    Object.assign(headers, token.headers ?? {})
  } else if (provider.auth && provider.auth.optional !== true) {
    throw new Error(`нет ключа: ${describeAuth(provider.auth)}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    let response
    try {
      response = await fetch(url, { method: provider.method ?? 'GET', headers, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new Error(`сеть: ${error?.cause?.code ?? error?.message ?? 'fetch failed'}`)
    }
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = text
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorMessage(body) ?? response.statusText}`)
    if (body && typeof body === 'object' && body.success === false) {
      throw new Error(`API ${body.code ?? 'error'}: ${body.msg ?? body.message ?? 'request rejected'}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function runCommand(provider, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const command = interpolate(provider.command ?? '')
    if (!command) return reject(new Error('command не задан'))
    const isWindows = process.platform === 'win32'
    const file = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command]
    execFile(file, args, { timeout: timeoutSeconds * 1000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message || '').trim() || 'command failed'))
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {})
      } catch {
        reject(new Error('command did not return JSON'))
      }
    })
  })
}

function windowsFromSpec(provider, body) {
  return (provider.windows ?? []).map((spec) => ({
    label: spec.label ?? 'limit',
    percent: clampPercent(asNumber(getByPath(body, spec.percentPath)) ?? ratioPercent(getByPath(body, spec.usedPath), getByPath(body, spec.totalPath))),
    resetAt: asDate(getByPath(body, spec.resetPath)),
    status: spec.statusPath ? getByPath(body, spec.statusPath) : undefined,
  }))
}

function windowsAuto(provider, body) {
  switch (provider.auto) {
    case 'zai': {
      const limits = getByPath(body, 'data.limits') ?? getByPath(body, 'limits')
      if (!Array.isArray(limits)) return undefined
      return limits.map((limit) => {
        const type = String(limit?.type ?? '').toUpperCase()
        const unit = asNumber(limit?.unit)
        return {
          label: type === 'TIME_LIMIT' ? 'mcp' : unit === 3 ? '5h' : unit === 6 ? 'wk' : 'limit',
          percent: clampPercent(asNumber(limit?.percentage) ?? ratioPercent(limit?.currentValue, limit?.limit)),
          resetAt: asDate(limit?.nextResetTime ?? limit?.resetTime),
          status: limit?.status,
        }
      })
    }
    case 'anthropic': {
      const windows = []
      for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'wk'], ['seven_day_opus', 'opus']]) {
        const node = getByPath(body, key)
        if (node) windows.push({ label, percent: clampPercent(asNumber(node.utilization)), resetAt: asDate(node.resets_at) })
      }
      return windows
    }
    case 'codex': {
      const windows = []
      for (const [key, fallback] of [['primary_window', '5h'], ['secondary_window', 'wk']]) {
        const node = getByPath(body, `rate_limit.${key}`) ?? getByPath(body, key)
        if (!node) continue
        const seconds = asNumber(node.limit_window_seconds)
        const label = seconds === 18_000 ? '5h' : seconds === 604_800 ? 'wk' : seconds === 2_628_000 ? 'mo' : fallback
        const percent = asNumber(node.used_percent)
        if (percent !== undefined) windows.push({ label, percent: clampPercent(percent), resetAt: asDate(node.reset_at) })
      }
      return windows.length > 0 ? windows : undefined
    }
    case 'copilot': {
      const snapshot = getByPath(body, 'quota_snapshots.premium_interactions')
      if (!snapshot) return undefined
      const remaining = asNumber(snapshot.percent_remaining)
      return [
        {
          label: 'premium',
          percent: clampPercent(remaining !== undefined ? 100 - remaining : ratioPercent(asNumber(snapshot.entitlement) - (asNumber(snapshot.remaining) ?? 0), asNumber(snapshot.entitlement))),
          resetAt: asDate(snapshot.quota_reset_at ?? getByPath(body, 'quota_reset_date')),
        },
      ]
    }
    default:
      return undefined
  }
}

function friendlyError(provider, message) {
  if (provider.auto === 'zai' && /coding plan/i.test(message)) return 'нет активной подписки Coding Plan'
  if (/SELF_SIGNED_CERT|CERT_|UNABLE_TO_VERIFY|ERR_TLS/i.test(message)) {
    return `${message} — TLS-сертификат подменяется прокси; добавьте его в NODE_EXTRA_CA_CERTS`
  }
  return message
}

export async function loadProvider(provider, timeoutSeconds, auth) {
  const base = { id: provider.id, label: provider.label, windows: [], error: null }
  try {
    const body = provider.type === 'command' ? await runCommand(provider, timeoutSeconds) : await fetchJson(provider, timeoutSeconds, auth)
    const parsed = windowsAuto(provider, body) ?? windowsFromSpec(provider, body)
    const windows = parsed
      .filter((window) => window.percent !== undefined || window.resetAt)
      .map((window) => ({ ...window, resetAt: window.resetAt ? window.resetAt.toISOString() : null }))
    if (windows.length === 0) return { ...base, error: 'ответ не совпал с полями `windows` в provider-limits.json' }
    return { ...base, windows }
  } catch (error) {
    return { ...base, error: friendlyError(provider, error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error)) }
  }
}

// ---------------------------------------------------------------------------
// Collection with a small cache
// ---------------------------------------------------------------------------

let cache = { at: 0, payload: undefined }
let cacheKey = ''

async function collect(force) {
  const loaded = loadConfig()
  const key = `${loaded.path}:${loaded.config.providers.map((p) => p.id + p.enabled).join(',')}`
  let mtime = 0
  try {
    mtime = statSync(loaded.path).mtimeMs
  } catch {
    mtime = 0
  }
  const now = Date.now()
  const fresh = cache.payload && now - cache.at < CACHE_MS && cacheKey === `${key}:${mtime}`
  if (fresh && !force) return cache.payload

  const enabled = loaded.config.providers.filter((provider) => provider.enabled)
  const auth = readAuth()
  const providers = await Promise.all(enabled.map((provider) => loadProvider(provider, loaded.config.timeoutSeconds, auth)))
  const payload = {
    updatedAt: new Date().toISOString(),
    configPath: loaded.path,
    configError: loaded.error ?? null,
    providers,
  }
  cache = { at: now, payload }
  cacheKey = `${key}:${mtime}`
  return payload
}

async function handler(request) {
  try {
    const url = new URL(request.url)
    const payload = await collect(url.searchParams.get('refresh') === '1')
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection')
  if (!connection?.fetch?.register) {
    console.error('[provider-limits] connection.fetch is unavailable; route not registered')
    return
  }
  const dispose = connection.fetch.register({
    path: ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: handler,
  })
  ctx.effect(() => dispose, 'provider-limits: route')
}

export { collect }
