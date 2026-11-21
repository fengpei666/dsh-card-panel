window.__ModuleLoader__.load({
  id: 'dsh-card-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useEffect, useMemo, useRef, useState } = react

    const PANEL_ID = 'card-panel'
    const API = '/dsh-card'
    const t = (zh) => zh

    /**
     * Warning thresholds for the remaining-time readout, in milliseconds.
     *
     * A day card is sold in 24-hour blocks, so "running out" has to be relative:
     * the amber band opens at two hours left and the red band at thirty minutes.
     * Red also covers an already-expired card, which the vendor reports as a
     * negative budget rather than an error.
     */
    const WARN_MS = 2 * 60 * 60 * 1000
    const DANGER_MS = 30 * 60 * 1000

    /**
     * Severity of a remaining-time budget.
     * @param {number|undefined} ms
     * @returns {'ok'|'warn'|'danger'}
     */
    function urgency(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'ok'
      if (ms <= DANGER_MS) return 'danger'
      if (ms <= WARN_MS) return 'warn'
      return 'ok'
    }

    /** Palette entry for a severity level. */
    const URGENCY_COLOR = {
      ok: 'var(--dsw-alias-label-secondary)',
      warn: '#c77700',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    /** Fetch JSON and never throw: every call site renders the failure. */
    async function getJson(url, init) {
      try {
        const res = await fetch(url, { cache: 'no-store', ...(init || {}) })
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
        return data
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    }

    /** Remaining-time text from a millisecond budget. */
    function fmtLeft(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms <= 0) return '已到期'
      const totalMin = Math.floor(ms / 60000)
      const d = Math.floor(totalMin / 1440)
      const hours = Math.floor((totalMin % 1440) / 60)
      const m = totalMin % 60
      if (d > 0) return `${d} 天 ${hours} 小时`
      if (hours > 0) return `${hours} 小时 ${m} 分`
      return `${m} 分`
    }

    /** Compact token counts. */
    function fmtTok(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
      if (n >= 1e4) return `${(n / 1e4).toFixed(0)} 万`
      return String(n)
    }

    const S = {
      page: {
        height: '100%',
        overflowY: 'auto',
        padding: '28px clamp(20px, 4vw, 56px) 56px',
        boxSizing: 'border-box',
      },
      wrap: { maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 },
      h1: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      h2: { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '22px' },
      intro: { margin: '6px 0 0', fontSize: 12.5, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-layer-2)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 116,
        resize: 'vertical',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'inherit',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 12,
        lineHeight: '18px',
        padding: '10px 12px',
        outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      btn: {
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 8,
        height: 30,
        padding: '0 12px',
        fontSize: 12.5,
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'inherit',
      },
      primary: {
        border: '0.5px solid transparent',
        borderRadius: 8,
        height: 30,
        padding: '0 14px',
        fontSize: 12.5,
        cursor: 'pointer',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontWeight: 500,
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 },
      tile: (active) => ({
        border: `0.5px solid ${active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)'}`,
        borderRadius: 12,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
      }),
      kv: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 },
      kvCell: { display: 'flex', flexDirection: 'column', gap: 2 },
      k: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
      v: { fontSize: 13.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums' },
      hint: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      msgOk: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', margin: 0 },
      msgErr: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', margin: 0 },
      frameBox: {
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 12,
        overflow: 'hidden',
        height: 620,
        background: '#fff',
      },
      dot: (state) => ({
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: state === 'err' ? '#e5534b' : state === 'off' ? '#999' : '#2ea043',
      }),
      statStrip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        fontSize: 11.5,
        lineHeight: '16px',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      statItem: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      statSep: { color: 'var(--dsw-alias-label-tertiary)', opacity: 0.6 },
      endpointBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 4,
        paddingTop: 12,
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 32,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'inherit',
        font: 'inherit',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 12,
        padding: '0 10px',
        outline: 'none',
      },
      chip: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-3)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: 11.5,
        lineHeight: '18px',
        color: 'inherit',
      },
      chart: {
        display: 'flex',
        alignItems: 'flex-end',
        gap: 3,
        height: 96,
        padding: '8px 0 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
      },
      chartCol: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        height: '100%',
      },
      chartBarTrack: {
        flex: 1,
        width: '100%',
        display: 'flex',
        alignItems: 'flex-end',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: 3,
        overflow: 'hidden',
      },
      chartBar: {
        width: '100%',
        background: 'var(--dsw-alias-state-business-primary)',
        borderRadius: 3,
        minHeight: 0,
      },
      chartLabel: {
        fontSize: 9.5,
        lineHeight: '12px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      fieldRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      inputNarrow: {
        width: 72,
        height: 30,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        padding: '0 8px',
        outline: 'none',
      },
      badge: {
        display: 'inline-block',
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-3)',
        fontSize: 10.5,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    function CardPanel() {
      const [cards, setCards] = useState([])
      const [selected, setSelected] = useState(null)
      const [usage, setUsage] = useState(null)
      const [usageLoading, setUsageLoading] = useState(false)
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [listError, setListError] = useState('')
      const [endpointDraft, setEndpointDraft] = useState(null)
      const [endpointBusy, setEndpointBusy] = useState(false)
      const [endpointNotice, setEndpointNotice] = useState('')
      const [modelBusy, setModelBusy] = useState(false)
      const [modelNotice, setModelNotice] = useState('')
      const [stats, setStats] = useState(null)
      const [statsWindow, setStatsWindow] = useState('24h')
      const [expiryHoursDraft, setExpiryHoursDraft] = useState('')
      const [expiryDateDraft, setExpiryDateDraft] = useState('')
      const [priceDraft, setPriceDraft] = useState('')
      const [expiryNotice, setExpiryNotice] = useState('')
      const [ctxReport, setCtxReport] = useState(null)
      const [ctxBusy, setCtxBusy] = useState(false)
      const [ctxNotice, setCtxNotice] = useState('')
      const alive = useRef(true)
      // Mirrors `selected` for helpers that run outside a render.
      const selectedRouteRef = useRef(null)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const loadCards = async () => {
        const data = await getJson(`${API}/cards`)
        if (!alive.current) return
        if (data.ok) {
          setCards(data.cards || [])
          setListError('')
          // The host owns the selection so the sidebar and composer strip keep
          // showing the same card across reloads.
          const stored = data.selected ?? null
          setSelected((prev) => {
            if (prev && (data.cards || []).some((c) => c.routeId === prev)) return prev
            if (stored && (data.cards || []).some((c) => c.routeId === stored)) return stored
            return data.cards?.[0]?.routeId ?? null
          })
        } else {
          setListError(data.error || '读取失败')
        }
      }

      /**
       * Select a card and persist the choice on the host.
       * @param {string} routeId
       */
      const selectCard = async (routeId) => {
        setSelected(routeId)
        render()
        try {
          await getJson(`${API}/select`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ routeId }),
          })
        } catch {
          /* the local selection still applies for this page */
        }
      }

      const loadUsage = async (routeId, force) => {
        if (!routeId) return
        setUsageLoading(true)
        const data = await getJson(
          `${API}/usage?route=${encodeURIComponent(routeId)}${force ? '&refresh=1' : ''}`,
        )
        if (!alive.current) return
        setUsage(data)
        setUsageLoading(false)
      }

      /** Read the context-window diagnosis for the selected card. */
      const loadContextReport = async (routeId) => {
        if (!routeId) return
        const data = await getJson(`${API}/context-fix?route=${encodeURIComponent(routeId)}`)
        if (!alive.current) return
        if (data.ok) setCtxReport(data.report?.[0] ?? null)
        render()
      }

      /**
       * Apply the provider-level context window fix.
       *
       * This is the one-click repair for "已达到输出 token 上限": DSH clamps the
       * output budget to `contextWindow - used`, so an unset provider window
       * (fallback 262144) makes the clamp go negative and min-clamp to 1.
       * @param {string} routeId
       */
      const applyContextFix = async (routeId) => {
        setCtxBusy(true)
        setCtxNotice('')
        const data = await getJson(`${API}/context-fix?route=${encodeURIComponent(routeId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ defaultContextWindow: 1000000, defaultMaxTokens: 64000 }),
        })
        if (!alive.current) return
        setCtxBusy(false)
        if (data.ok) {
          setCtxNotice(`OK 已写入 窗口 ${data.applied.defaultContextWindow} / 输出 ${data.applied.defaultMaxTokens}`)
          setCtxReport(data.report ?? null)
        } else {
          setCtxNotice(`修复失败：${data.error || '未知错误'}`)
        }
        await loadCards()
        render()
      }

      useEffect(() => {
        loadCards()
      }, [])

      // Local usage follows the selected card and window, refreshing while open.
      useEffect(() => {
        loadStats(statsWindow, selected)
        const timer = setInterval(() => loadStats(statsWindow, selected), 60_000)
        return () => clearInterval(timer)
      }, [statsWindow, selected])

      useEffect(() => {
        if (!selected) return
        setUsage(null)
        // Switching cards must not carry the previous card's endpoint draft.
        setEndpointDraft(null)
        setEndpointNotice('')
        loadUsage(selected, false)
        loadContextReport(selected)
        const timer = setInterval(() => loadUsage(selected, false), 30_000)
        return () => clearInterval(timer)
      }, [selected])

      const doImport = async () => {
        if (!text.trim()) {
          setNotice({ kind: 'err', text: '请先粘贴卡片信息' })
          return
        }
        setBusy(true)
        setNotice(null)
        const data = await getJson(`${API}/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!alive.current) return
        setBusy(false)
        if (data.ok) {
          setNotice({ kind: 'ok', text: `已导入 ${data.routeId}，凭据 ${data.keyRef}，模型配置已写入` })
          setText('')
          await loadCards()
          setSelected(data.routeId)
        } else {
          setNotice({ kind: 'err', text: `导入失败：${data.error || '未知错误'}` })
        }
      }

      /**
       * Persist a route's usage endpoint and probe it immediately.
       *
       * The probe result is reported verbatim so a wrong address is diagnosed in
       * place instead of showing a blank usage panel.
       * @param {string} routeId
       * @param {string} [override] - pass '' to clear the stored endpoint
       */
      const saveEndpoint = async (routeId, override) => {
        const value = override !== undefined ? override : (endpointDraft ?? '')
        setEndpointBusy(true)
        setEndpointNotice('')
        const data = await getJson(`${API}/usage-url`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routeId, usageUrl: value }),
        })
        if (!alive.current) return
        setEndpointBusy(false)
        if (!data.ok) {
          setEndpointNotice(`保存失败：${data.error || '未知错误'}`)
          render()
          return
        }
        setEndpointDraft(null)
        const probe = data.probe
        if (value === '') setEndpointNotice('已清除，回到默认规则')
        else if (probe?.ok && typeof probe.expiresAtMs === 'number') setEndpointNotice(`OK 读到到期时间 ${probe.expireAt || ''}`)
        else if (probe?.ok) setEndpointNotice('OK 能连通，但没解析出到期时间，请确认地址指向用量页')
        else setEndpointNotice(`读取失败：${probe?.error || '未知'}`)
        await loadCards()
        await loadUsage(routeId, true)
      }

      /**
       * Pull the gateway's model list and write it into this route.
       *
       * A relay's model id is its own spelling — the id in a pasted block often
       * belongs to a different reseller — so the gateway is asked directly and the
       * configured list is replaced wholesale.
       * @param {string} routeId
       */
      const syncModels = async (routeId) => {
        setModelBusy(true)
        setModelNotice('')
        const data = await getJson(`${API}/models`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routeId }),
        })
        if (!alive.current) return
        setModelBusy(false)
        if (data.ok) setModelNotice(`OK 已写入 ${data.models.length} 个模型：${data.models.join(', ')}`)
        else setModelNotice(`同步失败：${data.error || '未知错误'}`)
        await loadCards()
      }

      /**
       * Persist a route's expiry rule, hours or card price.
       * @param {string} routeId
       * @param {object} patch
       */
      const saveExpiry = async (routeId, patch) => {
        setExpiryNotice('')
        const data = await getJson(`${API}/expiry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routeId, ...patch }),
        })
        if (!alive.current) return
        if (!data.ok) {
          setExpiryNotice(`保存失败：${data.error || '未知错误'}`)
          render()
          return
        }
        setExpiryDateDraft('')
        setExpiryHoursDraft('')
        setPriceDraft('')
        setExpiryNotice('OK 已保存')
        await loadCards()
        await loadStats(statsWindow)
      }

      /**
       * Load the local usage ledger aggregates.
       * @param {string} window
       */
      /**
       * Load usage for one card.
       *
       * Scoped by route on purpose: the panels show "how much of THIS card is
       * used", so the hourly series must be this card's series, not a sum over
       * every configured route.
       * @param {string} window
       * @param {string} [routeId]
       */
      useEffect(() => {
        selectedRouteRef.current = selected
      }, [selected])

      const loadStats = async (window, routeId) => {
        const route = routeId ?? selectedRouteRef.current
        const query = `window=${encodeURIComponent(window)}${route ? `&route=${encodeURIComponent(route)}` : ''}`
        const data = await getJson(`${API}/stats?${query}`)
        if (!alive.current) return
        if (data.ok) setStats(data)
        render()
      }

      const doRemove = async (routeId) => {
        if (!window.confirm(`移除 ${routeId}？对应的密钥也会一并删除。`)) return
        const data = await getJson(`${API}/remove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ routeId, dropCredential: true }),
        })
        if (!alive.current) return
        if (!data.ok) {
          setNotice({ kind: 'err', text: `移除失败：${data.error || '未知错误'}` })
          return
        }
        setSelected(null)
        await loadCards()
      }

      const current = useMemo(() => cards.find((c) => c.routeId === selected) || null, [cards, selected])
      // Expiry/price figures for the selected card come from the stats payload,
      // which is the single place those are resolved on the host.
      const routeStats = useMemo(
        () => stats?.routes?.find((r) => r.routeId === selected) ?? null,
        [stats, selected],
      )

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.wrap },
          h('div', null, h('h1', { style: S.h1 }, t('无限量日卡')), h('p', { style: S.intro }, t('粘贴卡片信息即可写入模型配置，并在这里实时查看用量。'))),

          // ── import ────────────────────────────────────────────────
          h(
            'section',
            { style: S.card },
            h('h2', { style: S.h2 }, t('导入新卡')),
            h('textarea', {
              style: S.textarea,
              spellCheck: false,
              value: text,
              placeholder:
                '把整段卡片信息粘到这里：\n模型id：deepseek-v4.1-flash-day\nbase_url（首选 HTTP）：http://43.226.38.149:60015/v1\nkey：sk-xxxx\n用量查询：http://43.226.38.149:60014/usage?key=sk-xxxx',
              onChange: (event) => setText(event.target.value),
            }),
            h(
              'div',
              { style: S.row },
              h('button', { style: S.primary, onClick: doImport, disabled: busy }, busy ? t('导入中…') : t('解析并写入配置')),
              h(
                'button',
                { style: S.btn, onClick: () => { setText(''); setNotice(null) }, disabled: !text },
                t('清空'),
              ),
              h('span', { style: S.hint }, t('自动创建模型路由、保存密钥、开启用量查询')),
            ),
            notice ? h('p', { style: notice.kind === 'ok' ? S.msgOk : S.msgErr }, notice.text) : null,
          ),

          // ── list ──────────────────────────────────────────────────
          h(
            'section',
            { style: S.card },
            h(
              'div',
              { style: { ...S.row, justifyContent: 'space-between' } },
              h('h2', { style: S.h2 }, `${t('已配置的卡')}${cards.length ? `（${cards.length}）` : ''}`),
              h(
                'div',
                { style: S.row },
                h(
                  'span',
                  { style: { ...S.row, gap: 6, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
                  h('span', { style: S.dot(listError ? 'err' : 'on') }),
                  listError ? t('读取异常') : t('自动刷新中'),
                ),
                h('button', { style: S.btn, onClick: loadCards }, t('刷新')),
              ),
            ),
            listError ? h('p', { style: S.msgErr }, listError) : null,
            cards.length === 0
              ? h('p', { style: S.hint }, t('还没有配置任何日卡，把上面的卡片信息粘进去即可。'))
              : h(
                  'div',
                  { style: S.grid },
                  ...cards.map((card) =>
                    h(
                      'button',
                      {
                        key: card.routeId,
                        style: S.tile(card.routeId === selected),
                        onClick: () => selectCard(card.routeId),
                      },
                      h(
                        'span',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                        h(
                          'span',
                          { style: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          card.displayName || card.routeId,
                        ),
                        card.routeId === selected
                          ? h('span', { style: { ...S.badge, color: 'var(--dsw-alias-state-business-primary)' } }, t('已选中'))
                          : null,
                      ),
                      h(
                        'span',
                        { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--ds-font-family-code)' } },
                        (card.models || []).map((x) => x.id).join(', ') || '—',
                      ),
                      // Expiry is the headline fact for a day card, so it leads
                      // and carries the urgency colour.
                      (() => {
                        const ms = card.expiry?.expiresAtMs ? card.expiry.expiresAtMs - Date.now() : null
                        const level = ms === null ? 'ok' : ms <= 0 ? 'danger' : urgency(ms)
                        return h(
                          'span',
                          {
                            style: {
                              fontSize: 11.5,
                              color: URGENCY_COLOR[level],
                              fontWeight: level === 'ok' ? 400 : 600,
                            },
                          },
                          ms === null ? t('未开始计时') : ms <= 0 ? t('已到期') : `${t('剩')} ${fmtLeft(ms)}`,
                        )
                      })(),
                      h(
                        'span',
                        { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' } },
                        `${fmtTok(card.totals?.tokens ?? 0)} tok · ${card.totals?.requests ?? 0} ${t('次')}`,
                      ),
                      // Explicit control, so selecting a card is discoverable
                      // rather than hidden in "click the box".
                      card.routeId === selected
                        ? null
                        : h(
                            'span',
                            {
                              style: { ...S.badge, alignSelf: 'flex-start', color: 'var(--dsw-alias-state-business-primary)' },
                              // Nested clickable inside the tile: stop the bubble so
                              // the tile's own handler does not double-fire.
                              onClick: (event) => {
                                event.stopPropagation()
                                selectCard(card.routeId)
                              },
                            },
                            t('设为本卡'),
                          ),
                    ),
                  ),
                ),
          ),

          // ── usage ─────────────────────────────────────────────────
          current
            ? h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'space-between' } },
                  h('h2', { style: S.h2 }, `${current.displayName || current.routeId} · ${t('实时用量')}`),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: S.btn, onClick: () => loadUsage(current.routeId, true), disabled: usageLoading },
                      usageLoading ? t('刷新中…') : t('立即刷新'),
                    ),
                    h('button', { style: S.btn, onClick: () => doRemove(current.routeId) }, t('移除')),
                  ),
                ),
                usage && usage.ok
                  ? h(
                      'div',
                      { style: S.kv },
                      ...[
                        [t('卡片'), usage.cardName || '—'],
                        [t('剩余有效期'), fmtLeft(msLeftOf(usage))],
                        [t('到期时间'), usage.expireAt || '—'],
                        [t('额度'), usage.quota || '—'],
                        [t('请求次数'), usage.requests ?? '—'],
                        [t('输入 tok'), fmtTok(usage.inputTokens)],
                        [t('输出 tok'), fmtTok(usage.outputTokens)],
                        [t('合计 tok'), fmtTok(usage.totalTokens)],
                      ].map(([k, v], index) =>
                        h('div', { key: index, style: S.kvCell }, h('span', { style: S.k }, k), h('span', { style: S.v }, String(v))),
                      ),
                    )
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h(
                        'p',
                        { style: usageLoading ? S.hint : S.msgErr },
                        usageLoading ? t('正在读取用量…') : `${t('用量读取失败')}：${usage?.error || t('尚无数据')}`,
                      ),
                      // The common cause is a vendor whose usage page is not on the
                      // default rule; say so rather than leaving a bare error.
                      !usageLoading && !current.usageUrl
                        ? h('p', { style: S.hint }, t('该平台用量地址无法自动推断，请在下方「用量地址」填入卖家给的查询链接。'))
                        : null,
                      !usageLoading && current.usageUrl
                        ? h('p', { style: S.hint }, t('已记录的用量地址读取失败，可在下方修改或清除后重试。'))
                        : null,
                    ),
                // Model list: the gateway's own ids, with a one-click re-sync. A
                // reseller's id spelling differs from the next reseller's, so this
                // is the control that fixes a card whose requests 404.
                h(
                  'div',
                  { style: S.endpointBox },
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'space-between' } },
                    h('span', { style: S.k }, t('模型')),
                    h('span', { style: S.hint }, t('以平台实际提供的为准')),
                  ),
                  h(
                    'div',
                    { style: { ...S.row, gap: 6 } },
                    ...(current.models || []).map((m) =>
                      h(
                        'span',
                        { key: m.id, style: S.chip },
                        m.id,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: S.primary, disabled: modelBusy, onClick: () => syncModels(current.routeId) },
                      modelBusy ? t('获取中…') : t('同步平台模型'),
                    ),
                    h('span', { style: S.hint }, `${t('接口')} ${current.baseURL || '—'}`),
                    modelNotice ? h('span', { style: modelNotice.startsWith('OK') ? S.msgOk : S.msgErr }, modelNotice) : null,
                  ),
                ),

                // Expiry: an explicit value wins, else the vendor's own, else a
                // 24h window counted from the first call made through DSH.
                h(
                  'div',
                  { style: S.endpointBox },
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'space-between' } },
                    h('span', { style: S.k }, t('到期')),
                    h(
                      'span',
                      { style: S.badge },
                      `${
                        routeStats?.expirySource === 'manual'
                          ? t('手动指定')
                          : routeStats?.expirySource === 'vendor'
                            ? t('平台提供')
                            : routeStats?.expirySource === 'first-call'
                              ? t('首次调用起算')
                              : t('未知')
                      }`,
                    ),
                  ),
                  h(
                    'div',
                    { style: { ...S.row, gap: 10, fontSize: 12 } },
                    h(
                      'span',
                      { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 500 } },
                      routeStats?.expiresAtMs ? new Date(routeStats.expiresAtMs).toLocaleString() : t('尚未开始计时'),
                    ),
                    routeStats?.expiresAtMs
                      ? h('span', { style: { color: URGENCY_COLOR[urgency(routeStats.expiresAtMs - Date.now())] } }, fmtLeft(routeStats.expiresAtMs - Date.now()))
                      : null,
                  ),
                  h(
                    'p',
                    { style: S.hint },
                    routeStats?.firstCallAt
                      ? `${t('首次调用')} ${new Date(routeStats.firstCallAt).toLocaleString()}`
                      : t('还没有通过 DSH 调用过这张卡，首次调用后开始计时'),
                  ),

                  // auto rule
                  h(
                    'div',
                    { style: S.fieldRow },
                    h('span', { style: S.hint }, t('首次调用 +')),
                    h('input', {
                      style: S.inputNarrow,
                      inputMode: 'numeric',
                      placeholder: String(routeStats?.hours ?? 24),
                      value: expiryHoursDraft,
                      onChange: (event) => setExpiryHoursDraft(event.target.value),
                    }),
                    h('span', { style: S.hint }, t('小时')),
                    h(
                      'button',
                      {
                        style: S.btn,
                        onClick: () => saveExpiry(current.routeId, { hours: Number(expiryHoursDraft || routeStats?.hours || 24) }),
                      },
                      t('应用'),
                    ),
                    h(
                      'button',
                      { style: S.btn, onClick: () => saveExpiry(current.routeId, { expiresAtMs: null }) },
                      t('恢复自动'),
                    ),
                  ),

                  // manual datetime
                  h(
                    'div',
                    { style: S.fieldRow },
                    h('span', { style: S.hint }, t('手动指定')),
                    h('input', {
                      type: 'datetime-local',
                      style: { ...S.input, width: 190, height: 30 },
                      value: expiryDateDraft,
                      onChange: (event) => setExpiryDateDraft(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        style: S.primary,
                        disabled: !expiryDateDraft,
                        onClick: () => {
                          const at = new Date(expiryDateDraft).getTime()
                          if (Number.isFinite(at)) saveExpiry(current.routeId, { expiresAtMs: at })
                        },
                      },
                      t('保存'),
                    ),
                  ),

                  // card price, for the official-vs-actual comparison
                  h(
                    'div',
                    { style: S.fieldRow },
                    h('span', { style: S.hint }, t('卡价 ¥')),
                    h('input', {
                      style: S.inputNarrow,
                      inputMode: 'decimal',
                      placeholder: routeStats?.cardPrice ?? '—',
                      value: priceDraft,
                      onChange: (event) => setPriceDraft(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        style: S.btn,
                        disabled: priceDraft === '',
                        onClick: () => saveExpiry(current.routeId, { cardPrice: Number(priceDraft) }),
                      },
                      t('保存'),
                    ),
                    expiryNotice ? h('span', { style: expiryNotice.startsWith('OK') ? S.msgOk : S.msgErr }, expiryNotice) : null,
                  ),
                ),

                // Usage endpoint editor. Vendors share no convention, and the address
                // pasted at import time is the only reliable source — so a wrong or
                // missing one has to be repairable without re-importing the card.
                h(
                  'div',
                  { style: S.endpointBox },
                  h(
                    'div',
                    { style: { ...S.row, justifyContent: 'space-between' } },
                    h('span', { style: S.k }, t('用量地址')),
                    h('span', { style: S.hint }, t('导入时自动记下；平台不同可在此手动填写')),
                  ),
                  h('input', {
                    style: S.input,
                    spellCheck: false,
                    value: endpointDraft ?? current.usageUrl ?? '',
                    placeholder: `${t('例如')} https://你的平台/usage?key=sk-...`,
                    onChange: (event) => setEndpointDraft(event.target.value),
                  }),
                  h(
                    'div',
                    { style: S.row },
                    h(
                      'button',
                      { style: S.primary, disabled: endpointBusy, onClick: () => saveEndpoint(current.routeId) },
                      endpointBusy ? t('测试中…') : t('保存并测试'),
                    ),
                    h(
                      'button',
                      { style: S.btn, disabled: endpointBusy, onClick: () => saveEndpoint(current.routeId, '') },
                      t('清除'),
                    ),
                    endpointNotice
                      ? h('span', { style: endpointNotice.startsWith('OK') ? S.msgOk : S.msgErr }, endpointNotice)
                      : null,
                  ),
                ),
              )
            : null,

          // ── embedded page ─────────────────────────────────────────
          current && usage?.ok && usage.usageUrl
            ? h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'space-between' } },
                  h('h2', { style: S.h2 }, t('用量页面（内嵌）')),
                  h('span', { style: S.hint }, t('来自中转站自身的查询页')),
                ),
                h(
                  'div',
                  { style: S.frameBox },
                  h('iframe', {
                    src: usage.usageUrl,
                    title: 'vendor usage',
                    style: { border: 0, width: '100%', height: '100%', background: '#fff' },
                    sandbox: 'allow-same-origin allow-scripts allow-popups',
                    referrerPolicy: 'no-referrer',
                    loading: 'lazy',
                  }),
                ),
              )
            : null,

          // ── selected card overview ────────────────────────────────
          // The same figures the sidebar and composer strip show, gathered in one
          // place: a card with no vendor usage API is fully described by these.
          current && routeStats
            ? h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'space-between' } },
                  h('h2', { style: S.h2 }, `${t('已选中')} · ${current.displayName || current.routeId}`),
                  h('span', { style: S.badge }, t('侧边栏与输入框都跟随这张卡')),
                ),
                h(
                  'div',
                  { style: S.kv },
                  ...[
                    [
                      t('剩余时间'),
                      routeStats.expiresAtMs ? fmtLeft(routeStats.expiresAtMs - Date.now()) : t('未开始计时'),
                    ],
                    [t('到期时间'), routeStats.expiresAtMs ? new Date(routeStats.expiresAtMs).toLocaleString() : '—'],
                    [t('请求数'), String(routeStats.totals.requests)],
                    [t('输入 tok'), fmtTok(routeStats.totals.input + routeStats.totals.cache)],
                    [t('输出 tok'), fmtTok(routeStats.totals.output)],
                    [t('总 token'), fmtTok(routeStats.totals.tokens)],
                    [t('官方价'), `¥${routeStats.totals.cost.toFixed(4)}`],
                    [t('卡价'), routeStats.cardPrice > 0 ? `¥${routeStats.cardPrice.toFixed(2)}` : '—'],
                    [
                      t('省下'),
                      routeStats.totals.saved > 0
                        ? `¥${routeStats.totals.saved.toFixed(2)}`
                        : routeStats.cardPrice > 0 && routeStats.totals.cost > 0
                          ? t('未省钱')
                          : '—',
                    ],
                  ].map(([k, v], index) =>
                    h('div', { key: index, style: S.kvCell }, h('span', { style: S.k }, k), h('span', { style: S.v }, String(v))),
                  ),
                ),
              )
            : null,

          // ── context window health ─────────────────────────────────
          // The "已达到输出 token 上限" trap: DSH clamps the output budget to
          // contextWindow - used, so a route without an explicit window falls
          // back to 262144 and starts sending max_tokens=1 once a conversation
          // passes it. Repairing it is a single provider-level write.
          current && ctxReport
            ? h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'space-between' } },
                  h('h2', { style: S.h2 }, t('上下文窗口')),
                  h(
                    'span',
                    { style: { ...S.badge, color: ctxReport.healthy ? '#2ea043' : 'var(--dsw-alias-state-error-primary)' } },
                    ctxReport.healthy ? t('正常') : t('偏小，可能截断'),
                  ),
                ),
                h(
                  'div',
                  { style: S.kv },
                  ...[
                    [t('当前窗口'), ctxReport.defaultContextWindow ? fmtTok(ctxReport.defaultContextWindow) : `${fmtTok(262144)}（默认）`],
                    [t('最大输出'), ctxReport.defaultMaxTokens ? fmtTok(ctxReport.defaultMaxTokens) : `${fmtTok(32768)}（默认）`],
                    [t('模型数'), String(ctxReport.models.length)],
                  ].map(([k, v], index) =>
                    h('div', { key: index, style: S.kvCell }, h('span', { style: S.k }, k), h('span', { style: S.v }, String(v))),
                  ),
                ),
                !ctxReport.healthy
                  ? h(
                      'p',
                      { style: S.hint },
                      t('该路由没有设置足够的上下文窗口，长对话后 DSH 会向中转站发 max_tokens=1，表现为「已达到输出 token 上限」且发「继续」无效。'),
                    )
                  : null,
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    { style: ctxReport.healthy ? S.btn : S.primary, disabled: ctxBusy, onClick: () => applyContextFix(current.routeId) },
                    ctxBusy ? t('修复中…') : t('一键修复（设为 100 万 / 输出 6.4 万）'),
                  ),
                  h('span', { style: S.hint }, t('写 provider 级默认值，对之后新增的模型也生效')),
                  ctxNotice ? h('span', { style: ctxNotice.startsWith('OK') ? S.msgOk : S.msgErr }, ctxNotice) : null,
                ),
                ctxReport.problems?.length > 0
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                      ...ctxReport.problems.map((problem) =>
                        h(
                          'span',
                          { key: problem.model, style: S.hint },
                          `${problem.model} → 实际 ${fmtTok(problem.effectiveContextWindow)}（${problem.source === 'fallback' ? t('默认兜底') : problem.source}）`,
                        ),
                      ),
                    )
                  : null,
                h('p', { style: S.hint }, t('写入后需要完全退出 DSH（托盘右键退出）再打开，配置才会重新加载。')),
              )
            : null,

          // ── this card's usage ─────────────────────────────────────
          // Scoped to the selected card: a day card is bought for one route, so
          // "how much of THIS card is used" is the question that matters.
          // Summing every model together would answer a different one.
          current && routeStats
            ? h(
                'section',
                { style: S.card },
                h(
                  'div',
                  { style: { ...S.row, justifyContent: 'space-between' } },
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                    h('h2', { style: S.h2 }, `${t('本卡用量')} · ${current.displayName || current.routeId}`),
                    h('span', { style: S.hint }, (current.models || []).map((x) => x.id).join(', ') || '—'),
                  ),
                  h(
                    'div',
                    { style: S.row },
                    ...['24h', 'today', 'all'].map((key) =>
                      h(
                        'button',
                        { key, style: statsWindow === key ? S.primary : S.btn, onClick: () => setStatsWindow(key) },
                        key === '24h' ? t('近 24 小时') : key === 'today' ? t('今天') : t('全部'),
                      ),
                    ),
                  ),
                ),

                // This card's own totals — never the fleet-wide sum.
                h(
                  'div',
                  { style: S.kv },
                  ...[
                    [t('请求数'), String(routeStats.totals.requests)],
                    [t('总 token'), fmtTok(routeStats.totals.tokens)],
                    [t('输入'), fmtTok(routeStats.totals.input)],
                    [t('缓存命中'), fmtTok(routeStats.totals.cache)],
                    [t('输出'), fmtTok(routeStats.totals.output)],
                    [t('官方价'), `¥${routeStats.totals.cost.toFixed(4)}`],
                    [t('卡成本'), routeStats.cardPrice > 0 ? `¥${routeStats.cardPrice.toFixed(2)}` : '—'],
                    [
                      t('相对官方'),
                      routeStats.cardPrice > 0 && routeStats.totals.cost > 0
                        ? `${routeStats.totals.cost > routeStats.cardPrice ? t('省') : t('贵')} ${(
                            Math.abs(1 - routeStats.cardPrice / routeStats.totals.cost) * 100
                          ).toFixed(0)}%`
                        : '—',
                    ],
                  ].map(([k, v], index) =>
                    h('div', { key: index, style: S.kvCell }, h('span', { style: S.k }, k), h('span', { style: S.v }, String(v))),
                  ),
                ),

                // Hourly columns for this card only.
                h(
                  'div',
                  { style: S.chart },
                  ...(stats?.series ?? []).map((slot) => {
                    const series = stats?.series ?? []
                    const max = Math.max(...series.map((x) => x.tokens), 1)
                    const ratio = slot.tokens / max
                    return h(
                      'div',
                      {
                        key: slot.key,
                        style: S.chartCol,
                        title: `${slot.label} · ${fmtTok(slot.tokens)} tok · ${slot.requests} ${t('次')} · ¥${slot.cost.toFixed(4)}`,
                      },
                      h(
                        'div',
                        { style: S.chartBarTrack },
                        h('div', {
                          style: { ...S.chartBar, height: `${Math.max(ratio * 100, slot.tokens > 0 ? 3 : 0)}%` },
                        }),
                      ),
                      h('span', { style: S.chartLabel }, slot.label.slice(0, 2)),
                    )
                  }),
                ),
                h('p', { style: S.hint }, t('按 DeepSeek 官方峰谷价折算，非该卡实付金额；周末与夜间为半价。')),
              )
            : null,
        ),
      )
    }

    /**
     * Sidebar glyph for this panel.
     *
     * The sidebar renders a slot-owned component inside the row but only a plain
     * text label, so the countdown has to live here rather than in `label`. It
     * polls the cheap /cards endpoint (configuration only, no vendor calls) and
     * tints itself amber/red as the card approaches expiry.
     */
    function PanelIcon(props) {
      const size = props?.size ?? 18
      // A plain card glyph, drawn to the same metrics as the surrounding rows:
      // 18px in the wide sidebar, 16px in the collapsed rail. It deliberately
      // carries no state of its own — urgency is the countdown's job, and an
      // icon that recolours itself reads as a different icon, not a warning.
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2.5 }),
        h('path', { d: 'M3 10h18' }),
        h('path', { d: 'M7 14.5h4.5' }),
      )
    }

    /**
     * Composer-dock readout: card headroom plus the session's live token economy.
     *
     * Rows are shown only when the corresponding projection actually reports a
     * value, so a fresh session does not grow a strip of dashes. Numbers follow
     * the same units the app's own pills use (K/M for tokens, tok/s for speed).
     */
    function CardStatsPill(props) {
      const useProjection = props?.useProjection
      const usePerformanceUsage = props?.usePerformanceUsage
      const [summary, setSummary] = useState(null)

      // Which model this conversation is actually using. The strip must describe
      // THAT card — showing the card selected in the panel is what made the
      // numbers look wrong whenever the two disagreed.
      let activeModel
      try {
        const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
        activeModel = selection?.current?.model ?? selection?.model ?? undefined
      } catch {
        activeModel = undefined
      }

      useEffect(() => {
        let stop = false
        const poll = async () => {
          // Pass the model so the host resolves the owning route rather than
          // falling back to whatever the panel happens to have selected.
          const query = activeModel ? `?model=${encodeURIComponent(activeModel)}` : ''
          const data = await getJson(`${API}/summary${query}`)
          if (!stop && data?.ok) setSummary(data)
        }
        poll()
        const timer = setInterval(poll, 30_000)
        return () => {
          stop = true
          clearInterval(timer)
        }
      }, [activeModel])

      // Projections are optional: a host without them still renders the card band.
      let pressure
      let tokenUsage
      let perf
      try {
        pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined
        tokenUsage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
        perf = typeof usePerformanceUsage === 'function' ? usePerformanceUsage((value) => value) : undefined
      } catch {
        /* projections unavailable in this host build */
      }

      const items = []

      // ① card headroom — the card selected in the panel
      const cardMsLeft = typeof summary?.expiresAtMs === 'number' ? summary.expiresAtMs - Date.now() : undefined
      if (typeof cardMsLeft === 'number') {
        const level = cardMsLeft <= 0 ? 'danger' : urgency(cardMsLeft)
        items.push({
          key: 'card',
          label: cardMsLeft <= 0 ? t('日卡已到期') : `${t('日卡剩余')} ${fmtLeft(cardMsLeft)}`,
          color: URGENCY_COLOR[level],
          weight: level === 'ok' ? 400 : 600,
        })
      } else if (summary?.ok) {
        // A card counts from its first call, so before that it has no clock yet.
        items.push({ key: 'card', label: t('日卡未开始计时'), color: 'var(--dsw-alias-label-tertiary)' })
      }

      // ② this card's own tokens, in 亿/万 units
      const totals = summary?.totals
      if (totals && totals.tokens > 0) {
        items.push({
          key: 'tok',
          label: `${t('入')} ${fmtTok(totals.input + totals.cache)} · ${t('出')} ${fmtTok(totals.output)}`,
          color: 'var(--dsw-alias-label-secondary)',
        })
      }

      // ③ money: savings against official list price, when the card price is known
      if (totals && totals.cost > 0) {
        const saved = totals.saved
        items.push({
          key: 'money',
          label: saved > 0 ? `${t('省')} ¥${saved.toFixed(2)}` : `${t('官方价')} ¥${totals.cost.toFixed(2)}`,
          color: saved > 0 ? '#2ea043' : 'var(--dsw-alias-label-secondary)',
          weight: saved > 0 ? 600 : 400,
        })
      }

      // ④ throughput, when the host reports it
      const tps = typeof perf?.tokensPerSecond === 'number' ? perf.tokensPerSecond : undefined
      if (tps !== undefined) {
        items.push({
          key: 'tps',
          label: `${Math.round(tps)} tok/s`,
          color: 'var(--dsw-alias-label-secondary)',
        })
      }

      if (items.length === 0) return null
      if (perf === 'compact') {
        // Compact mode: keep only the two most valuable readings.
        return h(
          'span',
          { style: S.statStrip, 'data-card-stats': 'compact' },
          ...items.slice(0, 2).map((item) =>
            h('span', { key: item.key, style: { ...S.statItem, color: item.color, fontWeight: item.weight ?? 400 } }, item.label),
          ),
        )
      }

      return h(
        'span',
        { style: S.statStrip, 'data-card-stats': 'full' },
        ...items.map((item, index) =>
          h(
            react.Fragment,
            { key: item.key },
            index > 0 ? h('span', { style: S.statSep, 'aria-hidden': 'true' }, '·') : null,
            h('span', { style: { ...S.statItem, color: item.color, fontWeight: item.weight ?? 400 } }, item.label),
          ),
        ),
      )
    }

    /**
     * Remaining milliseconds for a usage payload.
     *
     * Prefers the absolute expiry instant so the reading never depends on when
     * the payload was fetched; falls back to a host-computed remainder.
     * @param {{ expiresAtMs?: number, msLeft?: number }|undefined} payload
     * @returns {number|undefined}
     */
    function msLeftOf(payload) {
      if (!payload) return undefined
      if (typeof payload.expiresAtMs === 'number') return payload.expiresAtMs - Date.now()
      return typeof payload.msLeft === 'number' ? payload.msLeft : undefined
    }

    /**
     * Ticking countdown text, HH:MM:SS below a day.
     * @param {number} ms
     * @returns {string}
     */
    function fmtCountdown(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      if (ms <= 0) return t('已到期')
      const totalSec = Math.floor(ms / 1000)
      const days = Math.floor(totalSec / 86400)
      const hours = Math.floor((totalSec % 86400) / 3600)
      const mins = Math.floor((totalSec % 3600) / 60)
      const secs = totalSec % 60
      const pad = (n) => String(n).padStart(2, '0')
      if (days > 0) return `${days}天 ${pad(hours)}:${pad(mins)}`
      return `${pad(hours)}:${pad(mins)}:${pad(secs)}`
    }

    /**
     * Attach a live countdown to the right of the panel's sidebar label.
     *
     * The sidebar renders `label` as a plain text node, so a coloured, ticking
     * readout cannot come from the slot contract. Instead this appends one span
     * beside the rendered title and keeps it alive across React re-renders with a
     * MutationObserver, re-creating it only when the row loses it.
     *
     * The countdown ticks locally every second and resynchronises with the host
     * every 30s, so it is accurate without polling the vendor on every tick.
     */
    function startSidebarCountdown() {
      // Hot reload re-runs apply(); without this guard every reload would add
      // another set of timers watching the same row.
      if (window.__dshCardCountdownStarted === true) return
      window.__dshCardCountdownStarted = true

      const MARK = 'data-card-countdown'
      const LABEL = t('无限量日卡')
      let deadline = null

      // Cached nodes: the steady-state tick must not query the DOM at all.
      let chip = null
      let titleEl = null
      // Last values actually written, so nothing is written twice. Kept in JS
      // rather than read back from the DOM: the browser normalises hex to rgb() and
      // currentColor to currentcolor, which would make every comparison "changed".
      let last = { text: null, color: null, opacity: null, display: null, title: null }

      /** The sidebar's panel list, or null before it mounts. */
      const panelList = () =>
        document.querySelector('nav[aria-label="全局面板"], nav[aria-label="Global panels"]')

      /**
       * This plugin's row.
       *
       * Scoped to the panel list and matched on the rendered label, so a
       * conversation bubble containing the same words can never be mistaken for the
       * row. A missing title means the sidebar is collapsed.
       * @returns {{ button: HTMLElement, title: HTMLElement } | null}
       */
      const findRow = () => {
        const list = panelList()
        if (!list) return null
        for (const button of list.querySelectorAll('button')) {
          for (const span of button.querySelectorAll('span')) {
            if (span.textContent === LABEL) return { button, title: span }
          }
        }
        return null
      }

      /** Forget cached nodes and the values written to them. */
      const forget = () => {
        chip = null
        titleEl = null
        last = { text: null, color: null, opacity: null, display: null, title: null }
      }

      /**
       * Whether the cached nodes are still usable.
       *
       * Uses only `isConnected` and identity checks — no querySelector — so the
       * per-frame path stays free even while the transcript streams.
       * @returns {boolean}
       */
      const stillAttached = () =>
        chip !== null &&
        chip.isConnected &&
        titleEl !== null &&
        titleEl.isConnected &&
        chip.parentElement === titleEl.parentElement

      /**
       * Ensure exactly one countdown sits after the title.
       *
       * Runs only when the cached references are stale, so its DOM work is paid on
       * layout changes instead of on every tick.
       * @returns {boolean} whether a chip is in place
       */
      const attach = () => {
        if (stillAttached()) return true
        forget()

        const row = findRow()
        // Remove strays left by an earlier render, or by collapsing.
        for (const node of document.querySelectorAll(`span[${MARK}]`)) {
          if (!row || node.parentElement !== row.button) node.remove()
        }
        if (!row) return false

        let node = row.button.querySelector(`span[${MARK}]`)
        if (!node) {
          node = document.createElement('span')
          node.setAttribute(MARK, 'true')
          node.setAttribute('aria-hidden', 'true')
          node.style.cssText = [
            'flex:0 0 auto',
            'margin-left:auto',
            'font-size:10.5px',
            'line-height:14px',
            'font-variant-numeric:tabular-nums',
            'font-weight:500',
            'white-space:nowrap',
            'letter-spacing:0.01em',
            'pointer-events:none',
            'transition:color .2s ease',
          ].join(';')
          row.button.appendChild(node)
        }

        // Let the label shrink first; that keeps the clock pinned to the right.
        // Written here because attach runs rarely, not once per tick.
        row.title.style.flex = '1 1 auto'
        row.title.style.minWidth = '0px'

        chip = node
        titleEl = row.title
        return true
      }

      /** Repaint the countdown, writing only what actually changed. */
      const paint = () => {
        if (!attach()) return

        const msLeft = deadline === null ? null : deadline - Date.now()

        // Unknown (no card, or one that has not started counting): show nothing
        // rather than a placeholder that reads like data.
        if (msLeft === null) {
          if (last.display !== 'none') {
            chip.style.display = 'none'
            last.display = 'none'
          }
          if (last.text !== '') {
            chip.textContent = ''
            last.text = ''
          }
          return
        }

        if (last.display !== '') {
          chip.style.display = ''
          last.display = ''
        }

        const level = msLeft <= 0 ? 'danger' : urgency(msLeft)
        const active = chip.parentElement?.getAttribute('aria-current') === 'page'
        // An active row is already tinted by the sidebar; following it keeps the
        // clock from looking like a second, competing accent colour.
        const nextColor = active ? 'currentColor' : URGENCY_COLOR[level]
        const nextOpacity = active ? '0.9' : '1'
        const nextText = msLeft <= 0 ? t('已到期') : fmtCountdown(msLeft)
        const nextTitle = msLeft <= 0 ? t('已到期') : `${t('剩余')} ${fmtLeft(msLeft)}`

        if (last.text !== nextText) {
          chip.textContent = nextText
          last.text = nextText
        }
        if (last.color !== nextColor) {
          chip.style.color = nextColor
          last.color = nextColor
        }
        if (last.opacity !== nextOpacity) {
          chip.style.opacity = nextOpacity
          last.opacity = nextOpacity
        }
        if (last.title !== nextTitle) {
          chip.title = nextTitle
          last.title = nextTitle
        }
      }

      /** Coalesce repaints into one animation frame. */
      let scheduled = false
      const schedulePaint = () => {
        if (scheduled) return
        scheduled = true
        const run = () => {
          scheduled = false
          paint()
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else setTimeout(run, 16)
      }

      /** Re-read the authoritative expiry instant from the host. */
      const sync = async () => {
        const data = await getJson(`${API}/summary`)
        if (!data?.ok) return
        if (typeof data.expiresAtMs === 'number') {
          // Absolute instant, adopted only when it really moved. Recalibrating on
          // every poll against a rounded "remaining" is what made the clock jump.
          if (deadline === null || Math.abs(deadline - data.expiresAtMs) > 1000) deadline = data.expiresAtMs
        } else {
          deadline = null
        }
        paint()
      }

      // Observe the sidebar only. Watching document.body put a full row scan on
      // every token of every streamed reply, which is what made the window crawl.
      let observed = null
      const observer = new MutationObserver((records) => {
        // Our own writes cannot change what we need to know: skip them.
        if (chip !== null && records.every((r) => r.target === chip || chip.contains(r.target))) return
        // Cheap path: if the chip survived the mutation, there is nothing to redo.
        if (stillAttached()) return
        schedulePaint()
      })

      /** Point the observer at the panel list, re-targeting if React replaced it. */
      const observePanelList = () => {
        const target = panelList() ?? document.body
        if (observed === target) return
        observer.disconnect()
        observer.observe(target, { childList: true, subtree: true })
        observed = target
      }

      observePanelList()
      sync()

      // One tick a second drives the clock; one poll every 30s re-reads the host.
      const tick = setInterval(paint, 1_000)
      const poll = setInterval(sync, 30_000)
      const reobserve = setInterval(() => {
        observePanelList()
        if (!stillAttached()) schedulePaint()
      }, 2_000)

      // A resize can collapse the rail without touching the row's children.
      const onResize = () => schedulePaint()
      window.addEventListener('resize', onResize)

      return () => {
        clearInterval(tick)
        clearInterval(poll)
        clearInterval(reobserve)
        window.removeEventListener('resize', onResize)
        observer.disconnect()
        for (const node of document.querySelectorAll(`span[${MARK}]`)) node.remove()
      }
    }

    function apply(ctx) {
      const tLocal = (key) => {
        try {
          return ctx.locale?.resolveText?.(key) ?? key
        } catch {
          return key
        }
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: () => tLocal(t('无限量日卡')),
            locale: 'card-panel',
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: 'card-panel',
          },
          CardPanel,
        ),
      )

      // Composer dock: the strip under the input box, beside the app's own pills.
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'card-stats',
            order: 5,
            locale: 'card-panel',
          },
          CardStatsPill,
        ),
      )

      // Live countdown beside the sidebar label. Not a slot: the label renders as
      // plain text, so the readout is attached to the rendered row instead.
      try {
        startSidebarCountdown()
      } catch {
        /* a sidebar that has not mounted yet is not an error */
      }
    }

    exports.apply = apply
    // `slots` + `layout` for the page and sidebar row; `conversation` hosts the
    // composer dock the stats strip renders into.
    exports.inject = ['slots', 'layout']
    exports.PANEL_ID = PANEL_ID
    exports.CardPanel = CardPanel
    return module.exports
  },
})
