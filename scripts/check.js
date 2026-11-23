// Prints the same data the Host serves at /api/provider.limits.
//   node scripts/check.js [--json]
import { collect } from '../index.js'

const asJson = process.argv.includes('--json')
const payload = await collect(true)

if (asJson) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(`opencode-limits · ${payload.configPath}`)
  if (payload.configError) console.log(`config error: ${payload.configError}`)
  console.log(`обновлено ${new Date(payload.updatedAt).toLocaleString()}\n`)
  for (const provider of payload.providers) {
    if (provider.error) {
      console.log(`${provider.label.padEnd(18)} ошибка: ${provider.error}`)
      continue
    }
    const cells = provider.windows.map((window) => {
      const reset = window.resetAt ? ` (сброс ${new Date(window.resetAt).toLocaleString()})` : ''
      const status = window.status && window.status !== 'ok' ? ` [${window.status}]` : ''
      return `${window.label} ${window.percent ?? '?'}%${status}${reset}`
    })
    console.log(`${provider.label.padEnd(18)} ${cells.join(' · ')}`)
  }
  const failed = payload.providers.filter((provider) => provider.error)
  if (failed.length > 0) {
    console.log(`\n${failed.length} из ${payload.providers.length} провайдеров не ответили — см. provider-limits.json`)
    process.exitCode = 1
  }
}
