// Host-half tests. No network: every HTTP call is stubbed.
//   node --test test/          (CI)
//   node test/host.test.mjs    (single file, no child processes)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  KNOWN_AUTH_PRESETS,
  PRESETS,
  loadConfig,
  loadProvider,
  mergeProvider,
  normalizeConfig,
  resolveAuth,
  starterConfig,
} from '../index.js'

const opencodeGoBody = {
  usage: {
    rolling: { status: 'ok', percent: 30, resetsAt: '2026-11-21T15:00:00.000Z' },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-23T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 50, resetsAt: '2026-12-01T00:00:00.000Z' },
  },
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'provider-limits-'))
}

test('preset metadata is consistent', () => {
  assert.ok(PRESETS['opencode-go'].url.includes('opencode.ai'))
  assert.equal(PRESETS.zai.authHeader, 'raw')
  assert.deepEqual(KNOWN_AUTH_PRESETS['zai-coding-plan'], 'zai')
})

test('mergeProvider merges preset windows by index and keeps overrides', () => {
  const merged = mergeProvider({
    id: 'opencode-go',
    preset: 'opencode-go',
    label: 'Go',
    windows: [{ percentPath: 'usage.rolling.percent' }, { label: 'week' }],
  })
  assert.equal(merged.url, PRESETS['opencode-go'].url)
  assert.equal(merged.label, 'Go')
  assert.equal(merged.windows[1].percentPath, 'usage.weekly.percent')
  assert.equal(merged.windows[1].label, 'week')
})

test('mergeProvider tolerates a windows object instead of an array', () => {
  const merged = mergeProvider({ id: 'x', preset: 'opencode-go', windows: { label: '5h' } })
  assert.equal(merged.windows.length, 3)
  assert.ok(Array.isArray(merged.windows))
})

test('normalizeConfig drops malformed providers and clamps the timeout', () => {
  const config = normalizeConfig({
    timeoutSeconds: 9999,
    providers: [{ id: 'a' }, { nope: true }, { id: 'b', enabled: false }],
  })
  assert.equal(config.timeoutSeconds, 300)
  assert.deepEqual(
    config.providers.map((provider) => provider.id),
    ['a', 'b'],
  )
  assert.equal(config.providers[1].enabled, false)
})

test('normalizeConfig ignores non-array windows and headers', () => {
  const config = normalizeConfig({ providers: [{ id: 'x', windows: 'nope', headers: 5, auth: 7 }] })
  assert.deepEqual(config.providers[0].windows, [])
})

test('loadConfig creates a starter config on first run', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'provider-limits.json')
    const loaded = loadConfig(file)
    assert.equal(loaded.created, true)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(Array.isArray(written.providers))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig never replaces an existing falsy config', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'provider-limits.json')
    writeFileSync(file, 'null', 'utf8')
    const loaded = loadConfig(file)
    assert.equal(loaded.error, undefined)
    assert.equal(readFileSync(file, 'utf8'), 'null')
    assert.equal(loaded.config.providers.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadConfig reports a parse error without overwriting', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'provider-limits.json')
    writeFileSync(file, '{ broken', 'utf8')
    const loaded = loadConfig(file)
    assert.match(loaded.error, /JSON/)
    assert.equal(readFileSync(file, 'utf8'), '{ broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starterConfig picks presets for connected providers', () => {
  const starter = starterConfig({ 'zai-coding-plan': { type: 'api' }, 'opencode-go': { type: 'api' }, other: {} })
  assert.deepEqual(starter.providers, [
    { id: 'zai-coding-plan', preset: 'zai', enabled: true },
    { id: 'opencode-go', preset: 'opencode-go', enabled: true },
  ])
})

test('resolveAuth reads env and literal sources', () => {
  process.env.PROVIDER_LIMITS_TEST_KEY = 'from-env'
  try {
    assert.equal(resolveAuth({ from: 'env', name: 'PROVIDER_LIMITS_TEST_KEY' }, {}).token, 'from-env')
    assert.equal(resolveAuth({ from: 'literal', value: 'literal-key' }, {}).token, 'literal-key')
    assert.equal(resolveAuth({ from: 'env', name: 'MISSING_KEY' }, {}), undefined)
  } finally {
    delete process.env.PROVIDER_LIMITS_TEST_KEY
  }
})

test('loadProvider parses the OpenCode Go response', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization })
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(opencodeGoBody) }
  }
  try {
    const provider = normalizeConfig({
      providers: [{ id: 'opencode-go', preset: 'opencode-go', auth: { from: 'literal', value: 'sk-test' } }],
    }).providers[0]
    const result = await loadProvider(provider, 5, {})
    assert.equal(result.error, null)
    assert.deepEqual(
      result.windows.map((window) => [window.label, window.percent]),
      [
        ['5h', 30],
        ['wk', 100],
        ['mo', 50],
      ],
    )
    assert.equal(calls[0].authorization, 'Bearer sk-test')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('zai uses the raw authorization header and explains a missing plan', async () => {
  const originalFetch = globalThis.fetch
  let authorization
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.Authorization
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: false, code: 500, msg: '当前用户不存在coding plan' }),
    }
  }
  try {
    const provider = normalizeConfig({ providers: [{ id: 'zai', preset: 'zai', auth: { from: 'literal', value: 'raw' } }] }).providers[0]
    const result = await loadProvider(provider, 5, {})
    assert.equal(authorization, 'raw')
    assert.match(result.error, /Coding Plan/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('loadProvider reports HTTP errors and missing keys', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'subscription required' } }),
  })
  try {
    const provider = normalizeConfig({
      providers: [{ id: 'opencode-go', preset: 'opencode-go', auth: { from: 'literal', value: 'x' } }],
    }).providers[0]
    const result = await loadProvider(provider, 5, {})
    assert.match(result.error, /HTTP 401/)
    assert.match(result.error, /subscription required/)
  } finally {
    globalThis.fetch = originalFetch
  }

  const missing = normalizeConfig({ providers: [{ id: 'opencode-go', preset: 'opencode-go', auth: { from: 'opencode', provider: 'absent' } }] }).providers[0]
  const missingResult = await loadProvider(missing, 5, {})
  assert.match(missingResult.error, /нет ключа/)
})
