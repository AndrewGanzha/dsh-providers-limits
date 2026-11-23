window.__ModuleLoader__.load({
  id: 'dsh-provider-limits',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Optional: the host's component library. When it is missing, the panel
    // falls back to a plain styled overlay so the plugin still works.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    /** Document-relative route registered by the Host half. */
    const ROUTE = 'api/provider.limits'
    const POLL_MS = 60_000
    const OK = '#22c55e'
    const WARN = '#f59e0b'
    const BAD = '#ef4444'

    // ---------------------------------------------------------------------
    // Shared store: the dock renders the summary, the overlay renders details.
    // ---------------------------------------------------------------------
    let state = { open: false, status: 'loading', data: null, error: null, refreshing: false }
    const listeners = new Set()

    function setState(patch) {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function useStore() {
      const [snapshot, setSnapshot] = React.useState(state)
      React.useEffect(() => subscribe(() => setSnapshot(state)), [])
      return snapshot
    }

    let inFlight = false
    async function load(force) {
      if (inFlight) return
      inFlight = true
      if (force) setState({ refreshing: true })
      try {
        const url = new URL(ROUTE, document.baseURI)
        if (force) url.searchParams.set('refresh', '1')
        const response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        setState({ status: 'ok', data, error: null, refreshing: false })
      } catch (error) {
        setState({ status: 'error', error: String(error?.message ?? error), refreshing: false })
      } finally {
        inFlight = false
      }
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------
    function colorFor(window) {
      if (!window) return 'inherit'
      if (window.status === 'rate-limited' || (window.percent ?? 0) >= 100) return BAD
      if ((window.percent ?? 0) >= 70) return WARN
      return OK
    }

    function percentText(window) {
      return window && window.percent !== undefined ? `${window.percent}%` : '—'
    }

    function barText(percent) {
      const filled = Math.round(Math.min(100, Math.max(0, percent ?? 0)) / 10)
      return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
    }

    /** Compact reset stamp: "23.11, 16:42". */
    function formatReset(resetAt) {
      const date = new Date(resetAt)
      if (Number.isNaN(date.getTime())) return String(resetAt)
      return date.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    function countdown(resetAt) {
      if (!resetAt) return ''
      const diff = new Date(resetAt).getTime() - Date.now()
      if (!Number.isFinite(diff) || diff <= 60_000) return 'скоро'
      const minutes = Math.floor(diff / 60000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return `${days} д`
      if (hours > 0) return `${hours} ч ${mins} мин`
      return `${mins} мин`
    }

    function chipStyle(extra) {
      return {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        fontVariantNumeric: 'tabular-nums',
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        ...extra,
      }
    }

    function detailText(provider) {
      if (provider.error) return `${provider.label}: ${provider.error}`
      return (
        `${provider.label}\n` +
        provider.windows
          .map((window) => {
            const reset = window.resetAt ? ` · сброс ${new Date(window.resetAt).toLocaleString()}` : ''
            return `${window.label}: использовано ${percentText(window)}${reset}`
          })
          .join('\n')
      )
    }

    // ---------------------------------------------------------------------
    // Dock: one compact line, click opens details
    // ---------------------------------------------------------------------
    function ProviderChip({ provider }) {
      return h(
        'span',
        { title: detailText(provider), style: chipStyle({ opacity: provider.error ? 0.85 : 1 }) },
        h('span', { style: { opacity: 0.7 } }, provider.label),
        provider.error
          ? h('span', { style: { color: BAD } }, '✕')
          : provider.windows.map((window) =>
              h(
                'span',
                { key: window.label, style: { color: colorFor(window) } },
                `${window.label} ${percentText(window)}`,
              ),
            ),
      )
    }

    function LimitsDock() {
      const snapshot = useStore()
      React.useEffect(() => {
        void load(false)
        const timer = setInterval(() => void load(false), POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const providers = snapshot.data?.providers ?? []
      const visible = providers.filter((provider) => provider.windows.length > 0 || provider.error)
      const open = () => {
        setState({ open: true })
        void load(true)
      }

      if (snapshot.status === 'loading' && visible.length === 0) return null
      if (snapshot.status === 'error') {
        return h(
          'div',
          { style: chipStyle({ color: BAD, cursor: 'pointer' }), title: `Лимиты: ${snapshot.error}`, onClick: open },
          'Лимиты: недоступны',
        )
      }
      if (visible.length === 0) {
        return h(
          'div',
          {
            style: chipStyle({ opacity: 0.7, cursor: 'pointer' }),
            title: snapshot.data?.configPath ?? '',
            onClick: open,
          },
          'Лимиты: нет провайдеров',
        )
      }
      return h(
        'div',
        {
          role: 'status',
          'aria-label': 'Лимиты провайдеров',
          title: `Обновлено ${new Date(snapshot.data.updatedAt).toLocaleTimeString()} · клик — подробности`,
          onClick: open,
          style: chipStyle({ gap: 12, cursor: 'pointer', flexWrap: 'wrap', justifyContent: 'center', padding: '2px 0' }),
        },
        visible.map((provider) => h(ProviderChip, { key: provider.id, provider })),
        snapshot.data?.configError ? h('span', { style: { color: BAD } }, snapshot.data.configError) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Overlay: details
    // ---------------------------------------------------------------------
    function WindowRow({ window }) {
      const color = colorFor(window)
      return h(
        'div',
        { style: { padding: '3px 0' } },
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '30px 44px 1fr', alignItems: 'center', gap: 8 } },
          h('span', { style: { opacity: 0.65, fontSize: 11 } }, window.label),
          h('span', { style: { color, fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, percentText(window)),
          h(
            'span',
            {
              style: {
                color,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11,
                lineHeight: '12px',
                letterSpacing: 0,
                whiteSpace: 'nowrap',
              },
            },
            barText(window.percent),
          ),
        ),
        window.status === 'rate-limited'
          ? h('div', { style: { marginLeft: 82, color: BAD, fontSize: 10, marginTop: 1 } }, 'лимит исчерпан')
          : null,
        window.resetAt
          ? h(
              'div',
              { style: { marginLeft: 82, opacity: 0.6, fontSize: 10, marginTop: 1 } },
              `сброс ${formatReset(window.resetAt)} · через ${countdown(window.resetAt)}`,
            )
          : null,
      )
    }

    function ProviderRow({ provider }) {
      if (provider.error) {
        return h(
          'div',
          { style: { padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.25)' } },
          h('div', { style: { color: BAD, fontSize: 12 } }, `${provider.label}: ошибка`),
          h('div', { style: { opacity: 0.75, fontSize: 11, marginTop: 2, lineHeight: '15px' } }, provider.error),
        )
      }
      return h(
        'div',
        { style: { padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.25)' } },
        h('div', { style: { fontSize: 12, marginBottom: 2 } }, provider.label),
        provider.windows.map((window) => h(WindowRow, { key: window.label, window })),
      )
    }

    function LimitsDetails() {
      const snapshot = useStore()
      if (!snapshot.open) return null

      const close = () => setState({ open: false })
      const data = snapshot.data
      const providers = data?.providers ?? []
      const updated = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : '—'

      const body = h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            maxWidth: 420,
            minWidth: 260,
            boxSizing: 'border-box',
            gap: 2,
          },
        },
        snapshot.status === 'error'
          ? h('div', { style: { color: BAD, fontSize: 12 } }, `Не удалось получить лимиты: ${snapshot.error}`)
          : null,
        snapshot.data?.configError
          ? h('div', { style: { color: BAD, fontSize: 12 } }, snapshot.data.configError)
          : null,
        providers.length === 0
          ? h('div', { style: { opacity: 0.75, fontSize: 12 } }, 'Нет провайдеров в конфиге.')
          : providers.map((provider) => h(ProviderRow, { key: provider.id, provider })),
        h(
          'div',
          {
            style: {
              marginTop: 10,
              fontSize: 10,
              lineHeight: '14px',
              opacity: 0.6,
              wordBreak: 'break-all',
            },
          },
          `Обновлено ${updated}${snapshot.refreshing ? ' · обновляю…' : ''}`,
          h('br'),
          `Конфиг: ${data?.configPath ?? '—'}`,
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => void load(true),
              disabled: snapshot.refreshing,
              style: { padding: '4px 12px', borderRadius: 6, cursor: 'pointer' },
            },
            snapshot.refreshing ? 'Обновляю…' : 'Обновить',
          ),
          h(
            'button',
            { type: 'button', onClick: close, style: { padding: '4px 12px', borderRadius: 6, cursor: 'pointer' } },
            'Закрыть',
          ),
        ),
      )

      const Modal = primitives?.Modal
      if (typeof Modal === 'function') {
        return h(
          Modal,
          { open: true, onClose: close, title: 'Лимиты провайдеров', closeLabel: 'Закрыть' },
          body,
        )
      }
      // Fallback when the host component library is unavailable.
      return h(
        'div',
        {
          onClick: close,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              background: 'Canvas',
              color: 'CanvasText',
              border: '1px solid rgba(127,127,127,0.4)',
              borderRadius: 10,
              padding: 16,
              width: 'min(420px, 92vw)',
              maxHeight: '80vh',
              overflow: 'auto',
              boxSizing: 'border-box',
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, 'Лимиты провайдеров'),
          body,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'provider-limits', order: 5 }, LimitsDock),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'provider-limits.details' }, LimitsDetails),
        )
      },
    }
  },
})
