/**
 * dsh-card-panel — host side.
 *
 * Exposes these routes under /dsh-card/:
 *   POST /dsh-card/import     parse a pasted card block, write the credential + llm-pi-ai route
 *   GET  /dsh-card/cards      list configured routes and their card metadata
 *   GET  /dsh-card/usage      proxy + parse the vendor's usage page into structured JSON
 *   GET  /dsh-card/summary    soonest expiry across cards, for countdowns
 *   POST /dsh-card/usage-url  set or clear one route's usage endpoint (manual repair)
 *   POST /dsh-card/remove     drop a route (and optionally its credential)
 *
 * The card block looks like:
 *   模型id：deepseek-v4.1-flash-day
 *   base_url（首选 HTTP）：http://host:60015/v1
 *   key：sk-...
 *   用量查询：http://host:60014/usage?key=sk-...
 *
 * The usage endpoint cannot be guessed across vendors: the block's 用量查询 URL is
 * persisted per route, with the port-60014 convention only as a last-resort
 * default, and the panel can repair it by hand when a vendor differs.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE_PREFIX = '/dsh-card'
const SERVICE_ID = 'cardPanel'

/** Vendor usage-page host defaults, used when the block omits an explicit usage URL. */
const DEFAULT_USAGE_PORT = 60014

/** Harness home, matching how the rest of the product locates user state. */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** Plugin-owned state: per-route usage endpoints that must survive restarts. */
const STATE_FILE = join(DSH_HOME, '.dsh-card-panel.json')

/**
 * Read the plugin state file.
 *
 * `selected` is the card the user picked in the panel; the sidebar countdown and
 * the composer strip both follow it, so it has to outlive a page reload.
 * @returns {{ routes: Record<string, { usageUrl?: string, modelId?: string, displayName?: string, importedAt?: number }>, selected?: string }}
 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.routes && typeof parsed.routes === 'object') {
      return {
        routes: parsed.routes,
        selected: typeof parsed.selected === 'string' ? parsed.selected : undefined,
      }
    }
  } catch {
    /* absent or unreadable: start fresh */
  }
  return { routes: {} }
}

/**
 * Persist the plugin state file atomically enough for a single-writer panel.
 * @param {{ routes: Record<string, object> }} state
 */
function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    /* a read-only home must not take the panel down */
  }
}

/**
 * Replace the `key` query parameter of a usage URL with the current credential.
 *
 * Vendors embed the key in the pasted 用量查询 link; re-deriving it at fetch time
 * is what lets a rotated key keep working without editing the stored URL.
 * @param {string} template - stored usage URL, possibly carrying an old key
 * @param {string} key - current API key
 * @returns {string}
 */
function applyKeyToUsageUrl(template, key) {
  try {
    const url = new URL(template)
    if (url.searchParams.has('key')) url.searchParams.set('key', key)
    else if (/key=/.test(template)) url.searchParams.set('key', key)
    return url.toString()
  } catch {
    return template
  }
}

/**
 * Strip a trailing `/v1` so `/v1`-suffixed and bare bases resolve to the same origin.
 * @param {string} url
 * @returns {string}
 */
function originOf(url) {
  const u = new URL(url)
  return `${u.protocol}//${u.host}`
}

/**
 * Normalize a base URL to end with a single `/v1`.
 * @param {string} raw
 * @returns {string|undefined}
 */
function normalizeBaseUrl(raw) {
  if (!raw) return undefined
  let s = String(raw).trim().replace(/[)\]}'"，,。；;]+$/, '').replace(/["'“”‘’]/g, '')
  if (!/^https?:\/\//i.test(s)) return undefined
  s = s.replace(/\/+$/, '')
  if (!/\/v1$/i.test(s)) s += '/v1'
  return s
}

/**
 * Read the first `label： value` occurrence for any of the given label fragments.
 * Labels in these vendor blocks are Chinese/English with full-width colons, and
 * the value often runs to the end of the line.
 * @param {string} text
 * @param {string[]} fragments
 * @returns {string|undefined}
 */
function pick(text, fragments) {
  for (const line of text.split(/\r?\n/)) {
    for (const frag of fragments) {
      const idx = line.indexOf(frag)
      if (idx < 0) continue
      const rest = line.slice(idx + frag.length)
      const m = /^[\s:：=]*([^\s，,。；;]+)/.exec(rest)
      if (m && m[1]) return m[1]
    }
  }
  return undefined
}

/**
 * Read the whole remainder of the first line matching any label fragment.
 * Used for descriptive fields ("规格：日卡 24 小时不限量") where the value is a
 * phrase rather than a single token.
 * @param {string} text
 * @param {string[]} fragments
 * @returns {string|undefined}
 */
function pickLine(text, fragments) {
  for (const line of text.split(/\r?\n/)) {
    for (const frag of fragments) {
      const idx = line.indexOf(frag)
      if (idx < 0) continue
      const rest = line
        .slice(idx + frag.length)
        .replace(/^[\s:：=]+/, '')
        .replace(/[，,。；;]+$/, '')
        .trim()
      if (rest) return rest
    }
  }
  return undefined
}

/**
 * Parse one pasted card block into route metadata.
 * @param {string} raw
 * @returns {{ ok: true, card: object } | { ok: false, error: string }}
 */
/**
 * Normalize a label for comparison.
 *
 * Sellers write the same field many ways — "模型 ID" / "模型id" / "模型ID：" — and
 * they mix full-width punctuation, spaces and letter case. Comparing normalized
 * labels is what makes the parser survive that, instead of demanding one exact
 * spelling per field.
 * @param {string} value
 * @returns {string}
 */
function normalizeLabel(value) {
  return String(value || '')
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/[：:]/g, '')
    .replace(/[（）()【】\[\]]/g, '')
    .toLowerCase()
}

/**
 * Split a pasted block into label/value pairs.
 *
 * A line may carry several "label：value" pairs, and values may contain colons
 * (URLs do), so each line is split on the FIRST colon only. Lines without a colon
 * are kept as bare text so callers can still regex the whole block.
 * @param {string} text
 * @returns {{ label: string, norm: string, value: string, line: string }[]}
 */
function parseLabeledLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^([^:：]{1,40})[:：](.*)$/.exec(trimmed)
    if (!m) {
      out.push({ label: '', norm: '', value: '', line: trimmed })
      continue
    }
    const label = m[1].trim()
    const value = m[2].trim()
    out.push({ label, norm: normalizeLabel(label), value, line: trimmed })
  }
  return out
}

/**
 * Find the value of the first line whose normalized label contains any token.
 * @param {{ norm: string, value: string }[]} rows
 * @param {string[]} tokens - normalized tokens to look for
 * @returns {string|undefined}
 */
function valueOfLabel(rows, tokens) {
  for (const row of rows) {
    if (!row.norm) continue
    for (const token of tokens) {
      if (row.norm.includes(token)) {
        const value = row.value.replace(/^[\s:：=]+/, '').trim()
        if (value) return value
      }
    }
  }
  return undefined
}

/** Full-width punctuation a seller may have used inside a URL. */
const URL_PUNCTUATION = {
  '\uFF1F': '?', // full-width question mark
  '\uFF1A': ':', // full-width colon
  '\uFF1D': '=', // full-width equals
  '\uFF06': '&', // full-width ampersand
  '\uFF0F': '/', // full-width solidus
}

/**
 * Repair the characters sellers actually type into a URL.
 *
 * Delivery messages often write "usage？key=sk-…" with a full-width question mark
 * and an ellipsis standing in for the key. Feeding that to the URL parser yields
 * a mangled query, so normalize first and drop the placeholder key afterwards.
 * @param {string} raw
 * @returns {string}
 */
function normalizeUrlText(raw) {
  return String(raw || '')
    .replace(/[\uFF1F\uFF1A\uFF1D\uFF06\uFF0F]/g, (c) => URL_PUNCTUATION[c] ?? c)
    .replace(/[，,。；;）)】\]]+$/, '')
    .replace(/["'“”‘’]/g, '')
    .trim()
}

/**
 * Parse one pasted card block.
 *
 * Sellers' delivery messages are free-form: labels vary ("模型 ID" vs "模型id"),
 * punctuation is mixed, and optional lines come and go. The parser therefore
 * works on normalized labels and heuristics rather than a fixed template, and
 * asks the gateway for the authoritative model list right after import.
 *
 * @param {string} raw
 * @returns {{ ok: true, card: object } | { ok: false, error: string }}
 */
export function parseCardBlock(raw) {
  const text = String(raw || '')
  if (!text.trim()) return { ok: false, error: '粘贴内容为空' }

  const rows = parseLabeledLines(text)
  const textNormalized = normalizeUrlText(text)

  // ── model id ───────────────────────────────────────────────────────────────
  // Labelled first; the value may be any casing the seller used.
  let modelId =
    valueOfLabel(rows, ['模型id', 'modelid', '模型名称', 'model']) ||
    (() => {
      const m = /\b([A-Za-z0-9][A-Za-z0-9._-]*deepseek[A-Za-z0-9._-]*)\b/i.exec(text)
      return m ? m[1] : undefined
    })()
  if (!modelId) modelId = 'deepseek-v4.1-flash-day'
  modelId = modelId.replace(/[，,。；;\s]+$/, '').trim()

  // ── api key ────────────────────────────────────────────────────────────────
  const keyMatch = /(sk-[A-Za-z0-9_-]{16,})/.exec(text)
  const apiKey = keyMatch ? keyMatch[1] : undefined
  if (!apiKey) return { ok: false, error: '没找到 API key（形如 sk-...）' }

  // ── urls ───────────────────────────────────────────────────────────────────
  const allUrls = [...textNormalized.matchAll(/https?:\/\/[^\s，,。；;)"'）】]+/g)].map((m) => m[0])

  /** Whether a URL points at a usage/quota page rather than the API base. */
  const isUsageUrl = (u) => /\/usage(\b|\?|\/)|\busage\b|\/quota\b/i.test(u) || /:60014\b/.test(u)

  const usageCandidates = allUrls.filter(isUsageUrl)
  const baseCandidates = allUrls.filter((u) => !isUsageUrl(u))

  // The labelled base URL wins, preferring the "首选 HTTP" line when present.
  const preferredBase = valueOfLabel(rows, ['首选http', '首选', 'baseurl', '基础url', '接口地址'])
  let baseUrl = normalizeBaseUrl(preferredBase) || normalizeBaseUrl(baseCandidates[0])
  if (!baseUrl && baseCandidates.length > 0) baseUrl = normalizeBaseUrl(baseCandidates[0])
  if (!baseUrl) return { ok: false, error: '没找到可用的 base_url（需要 http(s)://...）' }

  // ── usage endpoint ─────────────────────────────────────────────────────────
  // Only a link the seller actually wrote is worth persisting; our port guess
  // would otherwise outlive the rule that knows how to improve it.
  const explicitUsage = usageCandidates.length > 0 ? normalizeUrlText(usageCandidates[0]) : undefined
  const usageUrlExplicit = Boolean(explicitUsage)

  let usageUrl
  if (explicitUsage) {
    // Drop a placeholder key (sk-…) so the real credential can be attached later.
    usageUrl = explicitUsage.replace(/([?&]key=)sk-[^&\s]*/i, '$1')
    if (!/(^|[?&])key=/.test(usageUrl)) usageUrl += (usageUrl.includes('?') ? '&' : '?') + 'key='
    usageUrl = usageUrl.replace(/[?&]$/, '')
  } else {
    const u = new URL(baseUrl)
    usageUrl = `${u.protocol}//${u.hostname}:${DEFAULT_USAGE_PORT}/usage?key=`
  }

  // ── descriptive lines (informational) ──────────────────────────────────────
  const spec = valueOfLabel(rows, ['规格'])
  const concurrency = valueOfLabel(rows, ['并发'])
  const speed = valueOfLabel(rows, ['速度'])
  const version = valueOfLabel(rows, ['版本'])
  const rateLimit = valueOfLabel(rows, ['限速', '限制'])

  return {
    ok: true,
    card: {
      modelId,
      apiKey,
      baseUrl,
      usageUrl,
      usageUrlExplicit,
      origin: originOf(baseUrl),
      spec: spec || '日卡 24 小时不限量',
      concurrency: concurrency || '单个 key 最多 2 个同时请求',
      speed: speed || '最高 200 token/秒',
      rateLimit: rateLimit || undefined,
      version: version || '1017',
      importedAt: Date.now(),
    },
  }
}

/**
 * Derive a stable, lowercase-hyphen route id from the card's origin + a short key
 * fingerprint, so re-importing a rotated key for the same vendor reuses the route.
 * @param {{ origin: string, modelId: string }} card
 * @returns {string}
 */
function routeIdFor(card) {
  const host = new URL(card.origin).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  return `card-${host}`.toLowerCase().slice(0, 40)
}

/**
 * Pull `label：value` pairs out of the vendor's usage HTML.
 * The page is a simple server-rendered table, so a tag-stripping pass plus
 * label-driven extraction is enough and stays robust to markup changes.
 * @param {string} html
 * @returns {object}
 */
export function parseUsageHtml(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  const flat = text.join(' | ')
  const after = (label) => {
    const i = text.indexOf(label)
    return i >= 0 && i + 1 < text.length ? text[i + 1] : undefined
  }
  /**
   * Same as {@link after} but tries several vendor spellings of one field.
   * Relays label the same concept differently ("到期时间" vs "过期时间"), so the
   * parser has to accept the whole family rather than one canonical string.
   * @param {string[]} labels
   * @returns {string|undefined}
   */
  const afterAny = (labels) => {
    for (const label of labels) {
      const hit = after(label)
      if (hit !== undefined && hit !== '') return hit
    }
    return undefined
  }

  const cardName = text.find((t) => /^[a-z0-9][a-z0-9._-]*-[a-z0-9._-]+$/i.test(t) && /day|card|manual/i.test(t))
  const expireAt = afterAny(['到期时间', '过期时间', '有效期至', '到期', '有效期'])
  // "剩余" and its value are one cell ("剩余 0 天 21 小时 26 分"), so read the
  // neighbouring line pairs rather than assuming a standalone value line.
  let remaining
  const remIdx = text.findIndex((t) => /^剩余/.test(t))
  if (remIdx >= 0) remaining = text[remIdx].replace(/^剩余\s*/, '').trim()
  const quota = afterAny(['额度', '总量', '容量'])
  const requests = afterAny(['请求次数', '调用次数', '请求数'])
  const inputTok = afterAny(['输入 tok', '输入tok', '输入 Token'])
  const outputTok = afterAny(['输出 tok', '输出tok', '输出 Token'])
  const cacheTok = afterAny(['缓存命中 tok', '缓存命中tok', '缓存 tok'])
  const totalTok = afterAny(['合计 tok', '总计 tok', '合计tok', '总 tok'])

  /** Turn "1722 次" / "2.21 亿 tok" into numbers where possible. */
  const num = (v) => {
    if (!v) return undefined
    const s = String(v).replace(/,/g, '').trim()
    const yi = /^([\d.]+)\s*亿/.exec(s)
    if (yi) return Math.round(parseFloat(yi[1]) * 1e8)
    const wan = /^([\d.]+)\s*万/.exec(s)
    if (wan) return Math.round(parseFloat(wan[1]) * 1e4)
    const plain = /^([\d.]+)/.exec(s)
    return plain ? Number(plain[1]) : undefined
  }

  /**
   * Absolute expiry instant from 到期时间 ("YYYY-MM-DD HH:mm").
   *
   * This is the value everything downstream counts down from: the vendor's own
   * "剩余 X 小时 Y 分" is rounded to the minute and changes between reads, so
   * recalibrating against it makes the countdown jump. The expiry instant is
   * stable, so the client can tick locally from it forever.
   * @returns {number|undefined} epoch milliseconds
   */
  const computeExpiresAtMs = () => {
    if (!expireAt) return undefined
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(expireAt)
    if (!m) return undefined
    // The vendor reports Beijing time; parse it as such explicitly.
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`
    const at = Date.parse(iso)
    if (Number.isNaN(at)) return undefined
    return at
  }

  const expiresAtMs = computeExpiresAtMs()

  return {
    ok: true,
    raw: flat.slice(0, 600),
    cardName: cardName || undefined,
    remaining: remaining || undefined,
    expireAt: expireAt || undefined,
    expiresAtMs,
    quota: quota || undefined,
    requests: num(requests),
    inputTokens: num(inputTok),
    outputTokens: num(outputTok),
    cacheTokens: num(cacheTok),
    totalTokens: num(totalTok),
    fetchedAt: Date.now(),
  }
}

/**
 * Extract usage facts from a JSON usage endpoint.
 *
 * Relays expose quota either as HTML or as JSON with vendor-specific key names,
 * so this matches on key name families rather than a fixed schema, and reports
 * which keys it used so a wrong guess is diagnosable from the panel.
 *
 * @param {unknown} value - parsed JSON body
 * @returns {object}
 */
export function parseUsageJson(value) {
  /** Leaf paths to primitive values, so nested payloads are searchable. */
  const leaves = []
  const walk = (node, path) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}.${key}` : key)
      return
    }
    leaves.push([path, node])
  }
  walk(value, '')

  const matched = {}
  /** First leaf whose path matches a field family, recorded for the raw summary. */
  const pick = (name, pattern, convert) => {
    for (const [path, raw] of leaves) {
      if (!pattern.test(path)) continue
      const converted = convert(raw)
      if (converted === undefined) continue
      matched[name] = path
      return converted
    }
    return undefined
  }

  const toNumber = (raw) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw !== 'string') return undefined
    const s = raw.trim()
    const yi = /^([\d.]+)\s*亿/.exec(s)
    if (yi) return Math.round(parseFloat(yi[1]) * 1e8)
    const wan = /^([\d.]+)\s*万/.exec(s)
    if (wan) return Math.round(parseFloat(wan[1]) * 1e4)
    const plain = /^-?\d+(\.\d+)?/.exec(s)
    return plain ? Number(plain[0]) : undefined
  }

  const toEpochMs = (raw) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Seconds vs milliseconds: 1e11 ms is 1973, so anything smaller is seconds.
      return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw)
    }
    if (typeof raw !== 'string') return undefined
    const s = raw.trim()
    if (/^\d+$/.test(s)) return toEpochMs(Number(s))
    const direct = Date.parse(s)
    if (!Number.isNaN(direct)) return direct
    // "YYYY-MM-DD HH:mm" without a zone, as relays commonly print it (Beijing).
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s)
    if (m) {
      const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`)
      if (!Number.isNaN(at)) return at
    }
    return undefined
  }

  const expiresAtMs = pick('expiresAtMs', /expire|expired_at|end_?time|valid_?(until|to|end)|due_?(at|time)|deadline|到期/i, toEpochMs)
  const remainingMs = pick('remainingMs', /remain(ing)?_?(ms|time|seconds)|left_?(ms|time|seconds)|ttl/i, (raw) => {
    const n = toNumber(raw)
    if (n === undefined) return undefined
    // A bare TTL is seconds unless it is obviously milliseconds.
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
  })
  // A remaining window in the payload is relative to the read, not an anchor: it
  // is turned into an absolute instant here so callers still count down locally.
  if (expiresAtMs === undefined && remainingMs !== undefined) {
    matched.expiresAtMs = `${matched.remainingMs} (relative)`
  }

  const num = (name, pattern) => pick(name, pattern, toNumber)
  const remainingText = (() => {
    const raw = pick('remaining', /remain(ing)?|left|余额|剩余/i, (v) => (typeof v === 'string' ? v : undefined))
    return raw
  })()

  // Key-name families, not a fixed schema: relays say quota_left, remain_quota,
  // balance, available, credit_left ... in any order and any nesting.
  const LEFT = /(quota|credit|balance|额度)[._-]?(left|remain(ing)?|available|free)|(left|remain(ing)?|available|free)[._-]?(quota|credit|balance)|^balance$|remain(ing)?$/i
  const TOTAL = /(quota|credit|balance)[._-]?(total|max|limit)|(total|max|hard)[._-]?(quota|credit|balance)|^total$/i
  const USED = /used|consumed|spent|已用/i

  const quotaLeft = num('quotaLeft', LEFT)
  const quotaTotal = num('quotaTotal', TOTAL)
  const used = num('used', USED)

  return {
    ok: true,
    raw: JSON.stringify(value).slice(0, 600),
    format: 'json',
    matchedKeys: Object.keys(matched).length > 0 ? matched : undefined,
    remaining: remainingText || undefined,
    expiresAtMs: expiresAtMs ?? (remainingMs !== undefined ? Date.now() + remainingMs : undefined),
    quota:
      quotaLeft !== undefined && quotaTotal !== undefined
        ? `${quotaLeft} / ${quotaTotal}`
        : quotaLeft !== undefined
          ? String(quotaLeft)
          : quotaTotal !== undefined
            ? String(quotaTotal)
            : undefined,
    usedTokens: used,
    fetchedAt: Date.now(),
  }
}

// ── official pricing ─────────────────────────────────────────────────────────

/**
 * DeepSeek official list prices, CNY per million tokens, off-peak.
 *
 * Peak windows and the weekend rule mirror the vendor's own schedule: peak is
 * 09:00–12:00 and 14:00–18:00 Beijing time on weekdays, everything else (nights
 * and the whole weekend) is billed at half of peak. Costing is therefore
 * time-sensitive, which is why buckets carry their own hour.
 */
const OFFICIAL_PRICE_CNY = {
  flash: { hit: 0.02, miss: 1, out: 4 },
  pro: { hit: 0.15, miss: 4.5, out: 13.5 },
}

const BEIJING_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/**
 * Beijing hour-of-day for an instant.
 * @param {number} ms
 * @returns {number} 0–23
 */
function beijingHour(ms) {
  return Math.floor(((((ms + BEIJING_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000)
}

/**
 * Beijing weekday for an instant.
 * @param {number} ms
 * @returns {number} 0 = Sunday
 */
function beijingWeekday(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).getUTCDay()
}

/**
 * Whether an instant bills at off-peak rates.
 * @param {number} ms
 * @returns {boolean}
 */
function isOffPeak(ms) {
  const weekday = beijingWeekday(ms)
  if (weekday === 0 || weekday === 6) return true // weekends are all valley
  const hour = beijingHour(ms)
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  return !peak
}

/**
 * Official price triples for one model at one instant.
 * @param {string} model
 * @param {number} atMs
 * @returns {{ hit: number, miss: number, out: number }} CNY per million tokens
 */
function officialPriceFor(model, atMs) {
  const name = String(model || '').toLowerCase()
  const base = /pro/.test(name) ? OFFICIAL_PRICE_CNY.pro : OFFICIAL_PRICE_CNY.flash
  const multiplier = isOffPeak(atMs) ? 1 : 2
  return { hit: base.hit * multiplier, miss: base.miss * multiplier, out: base.out * multiplier }
}

/**
 * What a bucket would cost at official list prices.
 * @param {{ input?: number, cache?: number, output?: number }} bucket
 * @param {string} model
 * @param {number} atMs
 * @returns {number} CNY
 */
function officialCostOf(bucket, model, atMs) {
  const price = officialPriceFor(model, atMs)
  return (
    ((bucket.input ?? 0) / 1e6) * price.miss +
    ((bucket.cache ?? 0) / 1e6) * price.hit +
    ((bucket.output ?? 0) / 1e6) * price.out
  )
}

// ── local usage ledger ───────────────────────────────────────────────────────

/** Plugin-owned usage ledger: hourly token buckets plus each card's first call. */
const USAGE_FILE = join(DSH_HOME, '.dsh-card-panel-usage.json')
/** Flush at most this often; the file is small but written on every turn otherwise. */
const LEDGER_FLUSH_MS = 15_000

/**
 * @typedef {{ input: number, cache: number, output: number, requests: number }} UsageBucket
 * @typedef {{ firstCallAt?: number, cardPrice?: number, hours?: number, expiresAtMs?: number | null, buckets: Record<string, UsageBucket> }} RouteUsage
 */

/** In-memory ledger, loaded lazily and flushed on a timer. */
let ledgerCache
let ledgerDirtySince = 0
let ledgerTimer

/**
 * Load the ledger from disk once per process.
 * @returns {{ version: number, routes: Record<string, RouteUsage> }}
 */
function readLedger() {
  if (ledgerCache !== undefined) return ledgerCache
  try {
    const parsed = JSON.parse(readFileSync(USAGE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.routes && typeof parsed.routes === 'object') {
      ledgerCache = { version: 1, routes: parsed.routes }
      return ledgerCache
    }
  } catch {
    /* absent or corrupt: start empty rather than refusing to record */
  }
  ledgerCache = { version: 1, routes: {} }
  return ledgerCache
}

/**
 * Persist the ledger if it changed.
 * @param {boolean} force
 */
function flushLedger(force = false) {
  if (!ledgerCache) return
  if (!force && Date.now() - ledgerDirtySince < LEDGER_FLUSH_MS) return
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true })
    writeFileSync(USAGE_FILE, `${JSON.stringify(ledgerCache, null, 2)}\n`, 'utf8')
    ledgerDirtySince = 0
  } catch {
    /* a read-only home must not break usage accounting */
  }
}

/**
 * Hour key in Beijing time, e.g. "2026-11-07T15".
 * @param {number} ms
 * @returns {string}
 */
function hourKey(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}`
}

// ── request trust fence ─────────────────────────────────────────────────────
//
// The web server dispatches plugin routes BEFORE its own authentication, so a
// registered handler answers unauthenticated requests. These routes read and
// write model credentials, so answering a cross-site request would let any page
// the user visits rewrite their API keys. Every handler therefore passes through
// this fence first: loopback Host, no cross-site fetch metadata, and Origin (when
// present) same-origin with Host.

/** Extra authorities a deployment may trust, comma separated. */
const TRUSTED_AUTHORITIES = String(process.env.DSH_CARD_TRUSTED_HOSTS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)

/**
 * Whether a hostname is loopback.
 *
 * Checked segment-wise so look-alikes such as "127.0.0.1.evil.com" do not pass.
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return false
  return octets[0] === 127
}

/**
 * Decide whether a request must be refused before it reaches a handler.
 * @param {import('node:http').IncomingMessage} req
 * @param {any} connection - optional DSH connection service
 * @returns {{ rejected: boolean, status?: number, reason?: string }}
 */
function fenceRejects(req, connection) {
  const headers = req.headers || {}
  const hostHeader = String(headers.host || '').toLowerCase()
  const authority = hostHeader.split(':')[0]

  if (!authority) return { rejected: true, status: 403, reason: 'missing host' }
  if (!isLoopbackHostname(authority) && !TRUSTED_AUTHORITIES.includes(hostHeader) && !TRUSTED_AUTHORITIES.includes(authority)) {
    return { rejected: true, status: 403, reason: 'host is not loopback' }
  }

  // A cross-site fetch is the shape of a drive-by request from another page.
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return { rejected: true, status: 403, reason: 'cross-site request' }
  }

  const origin = headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host.toLowerCase() !== hostHeader) {
        return { rejected: true, status: 403, reason: 'origin does not match host' }
      }
    } catch {
      return { rejected: true, status: 403, reason: 'unparseable origin' }
    }
  }

  // Delegate to the host's own guard when this build provides one; refuse if it
  // throws rather than falling open.
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const verdict = connection.requestRejection(req)
      if (verdict) return { rejected: true, status: 403, reason: 'host guard' }
    } catch {
      return { rejected: true, status: 403, reason: 'host guard failed' }
    }
  }

  return { rejected: false }
}

export const name = 'card-panel'

export function apply(ctx, config) {
  const log = ctx.logger ?? console

  // The client half is served by the host's own client-module system from
  // `dsh.client` in package.json + lib/client.js — no index injection needed.
  // This entry only owns the HTTP API the page talks to.
  ctx.inject(['webServer'], (child) => startup(child, config, log))
}

/**
 * Register the API routes the panel page calls.
 * @param {any} ctx child context with `webServer`
 * @param {any} config plugin config
 * @param {any} log logger
 */
function startup(ctx, config, log) {

  /** In-memory usage cache: route id -> { at, payload }. */
  const usageCache = new Map()
  const USAGE_TTL_MS = (() => {
    const n = Number(config?.usageCacheMs)
    return Number.isFinite(n) && n >= 0 ? n : 20_000
  })()

  /**
   * Absolute-expiry cache: route id -> { at, expiresAtMs, remaining, expireAt }.
   *
   * A card's expiry is fixed, so it is re-read from the vendor rarely (or never,
   * once known) and every countdown is derived from `expiresAtMs` locally. This
   * is what keeps the readout from jumping: the vendor's own "剩余" text is
   * rounded to the minute and must not be used to recalibrate a ticking clock.
   */
  const expiryCache = new Map()
  /** Cards whose expiry read failed: route id -> timestamp, to avoid hammering dead hosts. */
  const expiryFailures = new Map()
  const EXPIRY_TTL_MS = 10 * 60_000
  const EXPIRY_FAIL_TTL_MS = 5 * 60_000

  // ── local usage accounting ────────────────────────────────────────────────
  // A relay may expose no usage endpoint at all, so the panel keeps its own
  // ledger from the session event stream: every assistant message carries the
  // authoritative token usage DSH already metered.

  /**
   * Map a model id back to the route that serves it.
   * @param {string} model
   * @returns {string|undefined} route id
   */
  const routeForModel = (model) => {
    const target = String(model || '').toLowerCase()
    if (!target) return undefined
    let fallback
    for (const card of listCards()) {
      if (card.models.some((m) => String(m.id).toLowerCase() === target)) return card.routeId
      // Vendors echo their upstream name ("DeepSeek-V4.1-Flash") rather than the
      // id we requested, so fall back to a prefix/substring match.
      if (!fallback && card.models.some((m) => target.includes(String(m.id).toLowerCase()) || String(m.id).toLowerCase().includes(target))) {
        fallback = card.routeId
      }
    }
    return fallback
  }

  /**
   * Add one request's tokens to a route's hourly bucket, and stamp the route's
   * first call — which is what a card without a vendor expiry counts from.
   * @param {string} routeId
   * @param {{ input: number, cache: number, output: number }} usage
   * @param {number} at
   */
  const recordUsage = (routeId, usage, at) => {
    const ledger = readLedger()
    const entry = (ledger.routes[routeId] ??= { buckets: {} })
    entry.buckets ??= {}
    if (entry.firstCallAt === undefined) entry.firstCallAt = at
    const key = hourKey(at)
    const bucket = (entry.buckets[key] ??= { input: 0, cache: 0, output: 0, requests: 0 })
    bucket.input += usage.input
    bucket.cache += usage.cache
    bucket.output += usage.output
    bucket.requests += 1
    ledgerDirtySince ||= Date.now()
    flushLedger()
  }

  /**
   * Resolve when a card expires, in priority order:
   *   1. an explicit value the user set,
   *   2. the vendor's own expiry when it publishes one,
   *   3. `firstCallAt + hours` for cards that publish nothing.
   * @param {{ routeId: string, baseURL?: string, keyRef?: string }} card
   * @returns {{ expiresAtMs?: number, source: 'manual'|'vendor'|'first-call'|'unknown' }}
   */
  const resolveExpiry = (card) => {
    const usage = readLedger().routes[card.routeId] ?? {}

    // ① explicit override (null means "use the automatic rule")
    if (typeof usage.expiresAtMs === 'number') return { expiresAtMs: usage.expiresAtMs, source: 'manual' }

    // ② the vendor's own expiry, when it publishes one
    const vendor = expiryCache.get(card.routeId)
    if (vendor && typeof vendor.expiresAtMs === 'number') return { expiresAtMs: vendor.expiresAtMs, source: 'vendor' }

    // ③ cards that publish nothing: count from the first call made through DSH
    if (typeof usage.firstCallAt === 'number') {
      const hours = typeof usage.hours === 'number' && usage.hours > 0 ? usage.hours : 24
      return { expiresAtMs: usage.firstCallAt + hours * 3_600_000, source: 'first-call' }
    }
    return { source: 'unknown' }
  }

  /**
   * Local usage totals for one card, from the plugin's own ledger.
   *
   * This is what lets a card with no vendor usage endpoint still report tokens,
   * cost and savings in the sidebar and the composer strip.
   *
   * @param {{ routeId: string, models?: { id: string }[] }} card
   * @returns {{ input: number, cache: number, output: number, tokens: number, requests: number, cost: number, cardPrice: number, saved: number }}
   */
  const localTotals = (card) => {
    const entry = readLedger().routes[card.routeId] ?? {}
    const model = card.models?.[0]?.id ?? ''
    const totals = { input: 0, cache: 0, output: 0, tokens: 0, requests: 0, cost: 0, cardPrice: 0, saved: 0 }
    for (const [key, bucket] of Object.entries(entry.buckets ?? {})) {
      const at = Date.parse(`${key}:00:00+08:00`)
      totals.input += bucket.input ?? 0
      totals.cache += bucket.cache ?? 0
      totals.output += bucket.output ?? 0
      totals.requests += bucket.requests ?? 0
      if (Number.isFinite(at)) totals.cost += officialCostOf(bucket, model, at)
    }
    totals.tokens = totals.input + totals.cache + totals.output
    totals.cardPrice = typeof entry.cardPrice === 'number' ? entry.cardPrice : 0
    // Savings only mean something once the user has said what the card cost.
    totals.saved = totals.cardPrice > 0 ? Math.max(0, totals.cost - totals.cardPrice) : 0
    return totals
  }

  /**
   * Answer one HTTP request with a JSON body.
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /**
   * Read a request body as UTF-8 text, bounded to avoid unbounded buffering.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<string>}
   */
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      const LIMIT = 1 << 20
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > LIMIT) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  /**
   * Resolve the llm-pi-ai settings namespace entry id from the live loader tree,
   * so the plugin works even when the entry was renamed from its default id.
   * @returns {string|undefined}
   */
  const findPiAiEntryId = () => {
    const loader = ctx.get('loader')
    const rows = loader?.entries?.()
    if (!rows) return undefined
    for (const row of rows) {
      const id = row?.options?.id
      const pkg = row?.options?.name
      if (typeof pkg === 'string' && pkg.includes('llm-pi-ai') && typeof id === 'string') return id
    }
    return undefined
  }

  /**
   * Write one route into the llm-pi-ai settings document, replacing any route
   * with the same key. Credentials go to the credential store, never to YAML.
   * @param {object} card
   */
  const persistRoute = async (card) => {
    const routeId = routeIdFor(card)
    const keyRef = `${routeId.toUpperCase().replace(/-/g, '_')}_API_KEY`

    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error('凭据服务不可用')
    await credentials.set(keyRef, card.apiKey)

    const settings = ctx.get('settings')
    if (!settings) throw new Error('设置服务不可用')
    const resolved = piAiDescriptor()
    if (!resolved) throw new Error('找不到可配置的 llm-pi-ai 条目')

    // Ask the gateway what it serves rather than trusting the pasted model id:
    // resellers use their own id spelling, and a stale id fails every request.
    let models
    let modelSource = 'block'
    let modelError
    try {
      const raw = await fetchVendorModels({ baseURL: card.baseUrl }, card.apiKey)
      if (raw.length > 0) {
        models = raw.map(modelEntryFrom)
        modelSource = 'gateway'
      }
    } catch (error) {
      modelError = String(error?.message || error)
    }
    if (!models) {
      models = [
        {
          id: card.modelId,
          name: card.modelId,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ]
    }

    // Preserve settings a previous import or the one-click repair established.
    // Re-importing a card must not silently reset a repaired context window back
    // to the adapter fallback — that would reintroduce the truncation bug.
    const existing = providersOf(resolved.descriptor)[routeId] ?? {}
    const route = {
      ...existing,
      displayName: existing.displayName ?? `中转卡 ${new URL(card.origin).hostname}`,
      apiKeyEnv: keyRef,
      api: 'openai-completions',
      baseURL: card.baseUrl,
      models,
    }
    // A repaired window is a deliberate value; keep it, and only let the gateway
    // list replace the model entries.
    if (typeof existing.defaultContextWindow === 'number') route.defaultContextWindow = existing.defaultContextWindow
    if (typeof existing.defaultMaxTokens === 'number') route.defaultMaxTokens = existing.defaultMaxTokens

    // One atomic edit: set the whole provider dict entry.
    await settings.mutate(
      resolved.ns,
      [{ op: 'set', path: ['providers', routeId], value: route }],
      resolved.descriptor.revision,
    )

    // The vendor's usage endpoint is ours to remember: the model profile schema
    // has no field for it, and it cannot be derived from the base URL across
    // vendors. Stored with the key placeholder restored so a rotated key still
    // resolves against the current credential.
    const state = readState()
    state.routes[routeId] = {
      ...(state.routes[routeId] ?? {}),
      // Keep a previously recorded endpoint when the new block does not carry one.
      usageUrl: card.usageUrlExplicit ? card.usageUrl : state.routes[routeId]?.usageUrl,
      modelId: card.modelId,
      displayName: route.displayName,
      importedAt: Date.now(),
    }
    writeState(state)

    return { routeId, keyRef, models, modelSource, modelError }
  }

  /**
   * Read the llm-pi-ai settings descriptor.
   * @returns {{ ns: string, descriptor: any } | undefined}
   */
  const piAiDescriptor = () => {
    const settings = ctx.get('settings')
    if (!settings) return undefined
    const ns = findPiAiEntryId() ?? 'llm-pi-ai'
    const descriptor = settings.describe().find((row) => row.ns === ns)
    return descriptor ? { ns, descriptor } : undefined
  }

  /**
   * The provider dict currently in force for a descriptor.
   * @param {any} descriptor
   * @returns {Record<string, any>}
   */
  const providersOf = (descriptor) => {
    const value = descriptor?.value ?? {}
    const providers = value.providers
    return providers && typeof providers === 'object' ? providers : {}
  }

  /**
   * List the models a route's gateway actually serves.
   *
   * Relays resell the same upstream under different ids — "deepseek-v4.1-flash"
   * here, "deepseek-v4.1-flash-day" there — so the id in a pasted block is only a
   * hint. The gateway's own /models is the authority.
   *
   * @param {{ baseURL?: string }} card
   * @param {string} key - resolved API key
   * @returns {Promise<object[]>} raw entries from the gateway
   */
  const fetchVendorModels = async (card, key) => {
    const base = String(card.baseURL || '').replace(/\/+$/, '')
    if (!base) throw new Error('该路由没有 baseURL')
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) throw new Error(`模型列表返回 HTTP ${res.status}`)
    const body = await res.json()
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    return list
      .map((item) => (typeof item === 'string' ? { id: item } : item))
      .filter((item) => item && typeof item.id === 'string' && item.id.length > 0)
  }

  /** DSH thinking levels, used to translate a gateway's own effort vocabulary. */
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  /**
   * Turn one gateway model entry into a pi-ai model profile.
   *
   * Reasonable capacities are assumed unless the gateway advertises them; the
   * capability fields it does publish (modalities, reasoning efforts) are carried
   * over so the model selector offers the right controls.
   *
   * @param {object} raw
   * @returns {object}
   */
  const modelEntryFrom = (raw) => {
    const entry = {
      id: raw.id,
      name: raw.display_name || raw.name || raw.id,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    }

    const capabilities = raw.capabilities
    if (capabilities && Array.isArray(capabilities.input_modalities)) {
      entry.input = capabilities.input_modalities.includes('image') ? ['text', 'image'] : ['text']
    }

    const efforts = Array.isArray(raw.reasoning_efforts) ? raw.reasoning_efforts : []
    if (efforts.length > 0) {
      const map = {}
      for (const value of efforts) {
        const level = String(value).toLowerCase()
        // "none" is the gateway's spelling of "not thinking"; `off` sends nothing.
        if (level === 'none' || level === 'off' || level === 'disabled') map.off = null
        else if (THINKING_LEVELS.includes(level)) map[level] = level
      }
      if (Object.keys(map).some((level) => level !== 'off')) entry.reasoningEfforts = map
    }

    return entry
  }

  /**
   * Resolve a route's API key from the credential store.
   * @param {{ keyRef?: string }} card
   * @returns {Promise<string|undefined>}
   */
  const keyFor = async (card) => {
    const credentials = ctx.get('credentials')
    if (!card?.keyRef || !credentials) return undefined
    const hit = await credentials.resolve(card.keyRef)
    return hit?.value || undefined
  }

  const listCards = () => {
    const resolved = piAiDescriptor()
    if (!resolved) return []
    const providers = providersOf(resolved.descriptor)
    const state = readState()
    const out = []
    for (const [routeId, profile] of Object.entries(providers)) {
      if (!profile || typeof profile !== 'object') continue
      if (!Array.isArray(profile.models) || profile.models.length === 0) continue
      out.push({
        routeId,
        displayName: profile.displayName ?? routeId,
        baseURL: profile.baseURL,
        keyRef: profile.apiKeyEnv,
        models: profile.models,
        usageUrl: state.routes[routeId]?.usageUrl,
      })
    }
    return out.sort((a, b) => a.routeId.localeCompare(b.routeId))
  }

  /**
   * Cache key for one card's usage payload.
   *
   * Keyed on the route, not on the vendor's port convention: two cards can share
   * a host, and a hand-repaired usage URL must not collide with a derived one.
   * @param {{ routeId?: string, baseURL?: string }} card
   * @returns {string}
   */
  const stripKey = (card) => card.routeId || String(card.baseURL || '')

  /**
   * Fetch the vendor usage page and parse it, with a short in-memory cache.
   * @param {string} usageUrl
   * @param {boolean} force
   */
  const fetchUsage = async (usageUrl, force = false, cacheKeyHint) => {
    const cacheKey = cacheKeyHint ?? usageUrl
    const hit = usageCache.get(cacheKey)
    if (!force && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.payload

    // One retry: the host's fetch goes through the shared dispatcher, and a vendor
    // that briefly refuses a connection should not render the card as broken.
    // The timeout is deliberately short — this runs behind a UI spinner.
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(usageUrl, {
          headers: { 'user-agent': 'dsh-card-panel/0.1' },
          redirect: 'follow',
          signal: AbortSignal.timeout(8_000),
        })
        const text = await res.text()
        if (!res.ok) {
          const payload = { ok: false, error: `用量页返回 HTTP ${res.status}`, status: res.status }
          usageCache.set(cacheKey, { at: Date.now(), payload })
          return payload
        }
        // Relays answer with either a rendered page or a JSON document, and the
        // JSON ones carry no content-type promise, so sniff the body as well.
        const contentType = res.headers.get('content-type') ?? ''
        let payload
        if (/json/i.test(contentType) || /^\s*[{[]/.test(text)) {
          try {
            payload = parseUsageJson(JSON.parse(text))
          } catch {
            payload = parseUsageHtml(text)
          }
        } else {
          payload = parseUsageHtml(text)
        }
        // A JSON body with no recognisable quota field is worth one fallback pass:
        // the vendor may serve an HTML fragment with a JSON content type.
        if (payload.format === 'json' && payload.expiresAtMs === undefined && payload.quota === undefined) {
          const fallback = parseUsageHtml(text)
          if (fallback.expiresAtMs !== undefined) payload = fallback
        }
        usageCache.set(cacheKey, { at: Date.now(), payload })
        return payload
      } catch (error) {
        lastError = error
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600))
      }
    }
    const payload = { ok: false, error: String(lastError?.message || lastError) }
    // Cache failures briefly so a burst of panel renders does not hammer the vendor.
    usageCache.set(cacheKey, { at: Date.now() - USAGE_TTL_MS + 5_000, payload })
    return payload
  }

  /**
   * Recover the usage URL for a stored route: the credential carries the key, and
   * the convention puts the usage page on the base host's :60014.
   * @param {{ baseURL?: string, keyRef?: string }} profile
   */
  const usageUrlForProfile = async (profile) => {
    if (!profile?.baseURL) return undefined
    const credentials = ctx.get('credentials')
    const ref = profile.keyRef
    const hit = ref && credentials ? await credentials.resolve(ref) : undefined
    const key = hit?.value
    if (!key) return undefined

    // ① A usage endpoint recorded at import time (or repaired by hand) wins: it is
    //    the vendor's own link, which is the only value that generalises.
    if (profile.usageUrl) return applyKeyToUsageUrl(profile.usageUrl, key)

    // ② Legacy fallback for cards imported before the endpoint was persisted: the
    //    port-60014 convention used by the new-api family.
    const u = new URL(profile.baseURL)
    return `${u.protocol}//${u.hostname}:${DEFAULT_USAGE_PORT}/usage?key=${encodeURIComponent(key)}`
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/summary`,
      handler: async (req, res) => {
        try {
          // Aggregate for the sidebar glyph and the composer strip.
          const modelHint = new URL(req.url || '/', 'http://localhost').searchParams.get('model') ?? undefined
          //
          // The authoritative value is the card's absolute expiry instant, which
          // the callers count down from locally. It is read from the vendor at most
          // once per EXPIRY_TTL_MS — and seeded for free from the usage cache the
          // panel already fills — so a 30s poll costs no vendor traffic and the
          // readout cannot jump between rounded readings.
          const cards = listCards()
          const probes = []

          for (const card of cards) {
            const cached = usageCache.get(stripKey(card))?.payload
            if (cached?.ok && typeof cached.expiresAtMs === 'number') {
              expiryCache.set(card.routeId, {
                at: Date.now(),
                expiresAtMs: cached.expiresAtMs,
                remaining: cached.remaining,
                expireAt: cached.expireAt,
                routeId: card.routeId,
              })
            }
          }

          for (const card of cards) {
            const entry = expiryCache.get(card.routeId)
            const fresh = entry !== undefined && Date.now() - entry.at < EXPIRY_TTL_MS
            const cooling = expiryFailures.get(card.routeId)
            const coolingDown = cooling !== undefined && Date.now() - cooling < EXPIRY_FAIL_TTL_MS
            if (fresh || coolingDown) continue
            probes.push(
              (async () => {
                try {
                  const url = await usageUrlForProfile(card)
                  if (!url) return
                  const payload = await fetchUsage(url, true, stripKey(card))
                  if (payload.ok && typeof payload.expiresAtMs === 'number') {
                    expiryCache.set(card.routeId, {
                      at: Date.now(),
                      expiresAtMs: payload.expiresAtMs,
                      remaining: payload.remaining,
                      expireAt: payload.expireAt,
                      routeId: card.routeId,
                    })
                    expiryFailures.delete(card.routeId)
                  } else {
                    expiryFailures.set(card.routeId, Date.now())
                  }
                } catch {
                  expiryFailures.set(card.routeId, Date.now())
                }
              })(),
            )
          }
          if (probes.length > 0) await Promise.allSettled(probes)

          // Resolution order for the surface:
          //   ① the model the conversation is actually using (composer strip),
          //   ② the card selected in the panel (sidebar countdown),
          //   ③ the soonest expiry, so something useful shows before any choice.
          // Without ① the strip reports a different card's numbers than the one
          // the request is running on, which is exactly what looked wrong.
          const requestedModel = modelHint
          /**
           * Whether a card's resolved expiry has already passed.
           *
           * A stale selection (a card replaced weeks ago) must not pin the surface
           * to "expired" forever while a live card sits right beside it — that is
           * exactly the bug of showing 日卡已到期 with a fresh card configured.
           * @param {object} card
           * @returns {boolean}
           */
          const isExpired = (card) => {
            const resolved = resolveExpiry(card)
            return typeof resolved.expiresAtMs === 'number' && resolved.expiresAtMs <= Date.now()
          }

          let shown = requestedModel ? cards.find((c) => c.routeId === routeForModel(requestedModel)) : undefined
          const wanted = readState().selected
          if (!shown) shown = wanted ? cards.find((c) => c.routeId === wanted) : undefined
          // Fall through when the chosen card is expired but a live one exists.
          if (shown && isExpired(shown) && cards.some((c) => !isExpired(c))) shown = undefined
          if (!shown) {
            let soonest
            for (const card of cards) {
              // Prefer a card that has not expired; expiry order only breaks ties
              // among live cards.
              if (isExpired(card)) continue
              const resolved = resolveExpiry(card)
              if (typeof resolved.expiresAtMs !== 'number') continue
              if (soonest === undefined || resolved.expiresAtMs < soonest.expiresAtMs) {
                soonest = { expiresAtMs: resolved.expiresAtMs, card }
              }
            }
            shown = soonest?.card ?? cards[0]
          }
          if (!shown) {
            return sendJson(res, 200, { ok: true, expiresAtMs: null, msLeft: null, expired: false })
          }

          const expiry = resolveExpiry(shown)
          const totals = localTotals(shown)
          const msLeft = typeof expiry.expiresAtMs === 'number' ? expiry.expiresAtMs - Date.now() : null
          return sendJson(res, 200, {
            ok: true,
            routeId: shown.routeId,
            displayName: shown.displayName,
            expiresAtMs: expiry.expiresAtMs ?? null,
            msLeft,
            expired: msLeft !== null && msLeft <= 0,
            source: expiry.source,
            hours: readLedger().routes[shown.routeId]?.hours ?? 24,
            firstCallAt: readLedger().routes[shown.routeId]?.firstCallAt ?? null,
            // Local figures stand in for cards whose vendor exposes no usage API.
            totals,
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/select`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          const { routeId } = JSON.parse(raw || '{}')
          if (!routeId) return sendJson(res, 400, { ok: false, error: '缺少 routeId' })
          if (!listCards().some((c) => c.routeId === routeId)) {
            return sendJson(res, 404, { ok: false, error: `没有路由 ${routeId}` })
          }
          const state = readState()
          state.selected = routeId
          writeState(state)
          return sendJson(res, 200, { ok: true, selected: routeId })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/import`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          let text = raw
          try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed.text === 'string') text = parsed.text
          } catch {
            /* not JSON: treat the whole body as the pasted block */
          }
          const parsed = parseCardBlock(text)
          if (!parsed.ok) return sendJson(res, 400, parsed)
          const written = await persistRoute(parsed.card)
          // Drop cached usage so the new card reports immediately.
          usageCache.clear()
          return sendJson(res, 200, {
            ok: true,
            routeId: written.routeId,
            keyRef: written.keyRef,
            modelSource: written.modelSource,
            modelError: written.modelError,
            models: written.models.map((m) => m.id),
            card: { ...parsed.card, apiKey: undefined },
          })
        } catch (error) {
          log.warn?.(`card-panel: import failed: ${error?.message}`)
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/cards`,
      handler: async (_req, res) => {
        try {
          // Configuration only. Usage is fetched per card on demand by /usage:
          // an unreachable vendor endpoint must never stall the whole list.
          const cards = listCards().map((card) => ({
            routeId: card.routeId,
            displayName: card.displayName,
            baseURL: card.baseURL,
            keyRef: card.keyRef,
            usageUrl: card.usageUrl,
            models: card.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
            usage: usageCache.get(stripKey(card))?.payload,
            totals: localTotals(card),
            expiry: resolveExpiry(card),
          }))
          // Repair a stale selection here rather than only in the panel: the
          // sidebar reads this too, and a dangling id would silently fall back to
          // array order — which is how an expired card kept being shown.
          const live = cards.filter((c) => !(c.expiry?.expiresAtMs && c.expiry.expiresAtMs <= Date.now()))
          const stored = readState().selected
          let selected = stored && cards.some((c) => c.routeId === stored) ? stored : null
          const storedCard = selected ? cards.find((c) => c.routeId === selected) : undefined
          if (storedCard && storedCard.expiry?.expiresAtMs && storedCard.expiry.expiresAtMs <= Date.now() && live.length > 0) {
            selected = null
          }
          if (!selected) selected = (live[0] ?? cards[0])?.routeId ?? null
          if (selected && selected !== stored) {
            const state = readState()
            state.selected = selected
            writeState(state)
          }
          return sendJson(res, 200, { ok: true, cards, selected })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/usage`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const routeId = url.searchParams.get('route')
          const force = url.searchParams.get('refresh') === '1'
          const card = listCards().find((c) => c.routeId === routeId)
          if (!card) return sendJson(res, 404, { ok: false, error: `没有路由 ${routeId}` })
          const usageUrl = await usageUrlForProfile(card)
          if (!usageUrl) return sendJson(res, 400, { ok: false, error: '该路由没有可用的凭据' })
          const payload = await fetchUsage(usageUrl, force, stripKey(card))
          // When nothing was recorded and the port convention failed, say so: this
          // vendor simply has no usage endpoint, which is not a malfunction.
          if (!payload.ok && !card.usageUrl) {
            return sendJson(res, 200, {
              ...payload,
              needsEndpoint: true,
              error: '该平台没有可自动发现的用量接口，请在「用量地址」填入卖家给的查询链接',
              usageUrl,
              routeId,
            })
          }
          // The raw page is what the embedded view shows; the parsed fields drive the summary.
          return sendJson(res, 200, { ...payload, usageUrl, routeId })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/models`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          let body = {}
          if (req.method === 'POST') {
            const raw = await readBody(req)
            try {
              body = JSON.parse(raw || '{}')
            } catch {
              /* an empty body means "sync from the gateway" */
            }
          }
          // GET carries the route in the query; POST carries it in the body.
          const routeId = url.searchParams.get('route') ?? body.routeId
          const card = listCards().find((c) => c.routeId === routeId)
          if (!card) return sendJson(res, 404, { ok: false, error: `没有路由 ${routeId}` })

          if (req.method === 'GET') {
            const key = await keyFor(card)
            if (!key) return sendJson(res, 400, { ok: false, error: '该路由没有可用的凭据' })
            try {
              const raw = await fetchVendorModels(card, key)
              return sendJson(res, 200, {
                ok: true,
                configured: card.models.map((m) => m.id),
                available: raw.map((m) => ({ id: m.id, name: m.display_name || m.name || m.id })),
              })
            } catch (error) {
              return sendJson(res, 200, {
                ok: false,
                configured: card.models.map((m) => m.id),
                error: String(error?.message || error),
              })
            }
          }

          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

          const key = await keyFor(card)
          if (!key) return sendJson(res, 400, { ok: false, error: '该路由没有可用的凭据' })

          let entries
          if (Array.isArray(body.models) && body.models.length > 0) {
            entries = body.models.map((m) => (typeof m === 'string' ? modelEntryFrom({ id: m }) : modelEntryFrom(m)))
          } else {
            const vendor = await fetchVendorModels(card, key)
            if (vendor.length === 0) return sendJson(res, 200, { ok: false, error: '平台没有返回任何模型' })
            entries = vendor.map(modelEntryFrom)
          }

          const resolved = piAiDescriptor()
          const settings = ctx.get('settings')
          if (!resolved || !settings) return sendJson(res, 500, { ok: false, error: '找不到可配置的 llm-pi-ai 条目' })
          const profile = providersOf(resolved.descriptor)[routeId]
          if (!profile) return sendJson(res, 404, { ok: false, error: `配置里没有路由 ${routeId}` })

          // Replace rather than merge: a model the gateway dropped must stop being
          // offered, otherwise the selector keeps advertising an id that 404s.
          await settings.mutate(
            resolved.ns,
            [{ op: 'set', path: ['providers', routeId, 'models'], value: entries }],
            resolved.descriptor.revision,
          )
          return sendJson(res, 200, { ok: true, models: entries.map((m) => m.id) })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stats`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const window = url.searchParams.get('window') ?? '24h'
          const only = url.searchParams.get('route')
          const ledger = readLedger()
          const now = Date.now()

          // Window start: the running hour counts as the 24th bucket so "24h"
          // always shows 24 columns.
          const currentHourStart = Date.parse(`${hourKey(now)}:00:00+08:00`)
          let since
          if (window === 'today') {
            const todayKey = hourKey(now).slice(0, 10)
            since = Date.parse(`${todayKey}T00:00:00+08:00`)
          } else if (window === 'all') {
            since = Number.NEGATIVE_INFINITY
          } else {
            since = currentHourStart - 23 * 3_600_000
          }

          /** Hour key back to the instant its bucket starts. */
          const hourStart = (key) => Date.parse(`${key}:00:00+08:00`)

          const totals = { input: 0, cache: 0, output: 0, tokens: 0, requests: 0, cost: 0 }
          const byHour = new Map()
          const routes = []

          for (const card of listCards()) {
            if (only && card.routeId !== only) continue
            const entry = ledger.routes[card.routeId] ?? { buckets: {} }
            const model = card.models?.[0]?.id ?? ''
            const routeTotals = { input: 0, cache: 0, output: 0, tokens: 0, requests: 0, cost: 0 }

            for (const [key, bucket] of Object.entries(entry.buckets ?? {})) {
              const at = hourStart(key)
              if (!Number.isFinite(at)) continue
              const cost = officialCostOf(bucket, model, at)
              // Per-route totals always cover the whole card (that is the number a
              // day card is judged by); only the series and the grand totals clip.
              routeTotals.input += bucket.input ?? 0
              routeTotals.cache += bucket.cache ?? 0
              routeTotals.output += bucket.output ?? 0
              routeTotals.requests += bucket.requests ?? 0
              routeTotals.cost += cost

              if (at < since) continue
              const slot = byHour.get(key) ?? { input: 0, cache: 0, output: 0, requests: 0, cost: 0 }
              slot.input += bucket.input ?? 0
              slot.cache += bucket.cache ?? 0
              slot.output += bucket.output ?? 0
              slot.requests += bucket.requests ?? 0
              slot.cost += cost
              byHour.set(key, slot)
            }

            routeTotals.tokens = routeTotals.input + routeTotals.cache + routeTotals.output
            const expiry = resolveExpiry(card)
            routes.push({
              routeId: card.routeId,
              displayName: card.displayName,
              model,
              firstCallAt: entry.firstCallAt ?? null,
              hours: entry.hours ?? 24,
              expiresAtMs: expiry.expiresAtMs ?? null,
              expirySource: expiry.source,
              manualExpiry: typeof entry.expiresAtMs === 'number' ? entry.expiresAtMs : null,
              cardPrice: entry.cardPrice ?? null,
              totals: routeTotals,
            })
          }

          // Grand totals follow the selected window.
          for (const slot of byHour.values()) {
            totals.input += slot.input
            totals.cache += slot.cache
            totals.output += slot.output
            totals.requests += slot.requests
            totals.cost += slot.cost
          }
          totals.tokens = totals.input + totals.cache + totals.output

          // Always an explicit dense series: 24 hourly columns ending now.
          const series = []
          const columns = window === 'today' ? beijingHour(now) + 1 : 24
          for (let i = columns - 1; i >= 0; i -= 1) {
            const at = currentHourStart - i * 3_600_000
            const key = hourKey(at)
            const slot = byHour.get(key) ?? { input: 0, cache: 0, output: 0, requests: 0, cost: 0 }
            series.push({
              key,
              at,
              label: `${String(beijingHour(at)).padStart(2, '0')}:00`,
              input: slot.input,
              cache: slot.cache,
              output: slot.output,
              tokens: slot.input + slot.cache + slot.output,
              requests: slot.requests,
              cost: slot.cost,
            })
          }

          const cardPriceTotal = routes.reduce((sum, r) => sum + (typeof r.cardPrice === 'number' ? r.cardPrice : 0), 0)
          return sendJson(res, 200, {
            ok: true,
            window,
            series,
            totals: { ...totals, cardPrice: cardPriceTotal },
            routes,
            generatedAt: now,
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      // One-click repair for the "已达到输出 token 上限" trap.
      //
      // The pi-ai adapter clamps the per-request output budget to
      // `contextWindow - used`. When a relay is configured without a
      // `defaultContextWindow`, the fallback is 262144 — so once a long
      // conversation passes that, the clamp goes negative and min-clamps to 1,
      // and the relay answers "hit the limit". Typing "继续" cannot help because
      // the arithmetic has not changed.
      //
      // GET diagnoses every route; POST writes the fix at provider level, which is
      // where the adapter reads it from.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/context-fix`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const routeId = url.searchParams.get('route')
          const resolved = piAiDescriptor()
          if (!resolved) return sendJson(res, 404, { ok: false, error: '找不到 llm-pi-ai 条目' })
          const providers = providersOf(resolved.descriptor)
          const settings = ctx.get('settings')

          // The adapter's own fallbacks, mirrored so the diagnosis states the
          // number DSH will really use.
          const FALLBACK_CONTEXT = 262144
          const FALLBACK_MAX_TOKENS = 32768

          /** Diagnose one route. */
          const diagnose = (id, profile) => {
            const providerContext = profile.defaultContextWindow
            const models = Array.isArray(profile.models) ? profile.models : []
            const problems = []
            for (const model of models) {
              const effective = model.contextWindow ?? providerContext ?? FALLBACK_CONTEXT
              // Below the adapter fallback means DSH will clamp far too early.
              if (effective <= FALLBACK_CONTEXT) {
                problems.push({
                  model: model.id,
                  effectiveContextWindow: effective,
                  source: model.contextWindow ? 'model' : providerContext ? 'provider' : 'fallback',
                })
              }
            }
            return {
              routeId: id,
              displayName: profile.displayName ?? id,
              baseURL: profile.baseURL,
              defaultContextWindow: providerContext ?? null,
              defaultMaxTokens: profile.defaultMaxTokens ?? null,
              models: models.map((m) => ({
                id: m.id,
                contextWindow: m.contextWindow ?? null,
                maxTokens: m.maxTokens ?? null,
              })),
              problems,
              healthy: problems.length === 0,
            }
          }

          if (req.method === 'GET') {
            const report = Object.entries(providers)
              .filter(([id]) => !routeId || id === routeId)
              .map(([id, profile]) => diagnose(id, profile))
            return sendJson(res, 200, {
              ok: true,
              report,
              applyTo: routeId ?? null,
              suggestion: { defaultContextWindow: 1_000_000, defaultMaxTokens: 64_000 },
            })
          }

          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

          if (!settings) return sendJson(res, 500, { ok: false, error: '设置服务不可用' })
          const raw = await readBody(req)
          let body = {}
          try {
            body = JSON.parse(raw || '{}')
          } catch {
            /* defaults below */
          }
          const target = routeId ?? body.routeId
          if (!target) return sendJson(res, 400, { ok: false, error: '缺少 routeId' })
          if (!providers[target]) return sendJson(res, 404, { ok: false, error: `没有路由 ${target}` })

          const contextWindow = Number(body.defaultContextWindow ?? 1_000_000)
          const maxTokens = Number(body.defaultMaxTokens ?? 64_000)
          if (!Number.isFinite(contextWindow) || contextWindow < 1024 || contextWindow > 4_000_000) {
            return sendJson(res, 400, { ok: false, error: '上下文窗口不在合理范围（1024 – 4000000）' })
          }
          if (!Number.isFinite(maxTokens) || maxTokens < 256 || maxTokens > contextWindow) {
            return sendJson(res, 400, { ok: false, error: '最大输出不在合理范围（256 至上下文窗口之间）' })
          }

          // Provider level, not model level: the adapter reads
          // entry.contextWindow ?? provider.defaultContextWindow, and a provider
          // default also covers models added later.
          await settings.mutate(
            resolved.ns,
            [
              { op: 'set', path: ['providers', target, 'defaultContextWindow'], value: Math.round(contextWindow) },
              { op: 'set', path: ['providers', target, 'defaultMaxTokens'], value: Math.round(maxTokens) },
            ],
            resolved.descriptor.revision,
          )

          const fresh = piAiDescriptor()
          const after = fresh ? diagnose(target, providersOf(fresh.descriptor)[target] ?? {}) : undefined
          return sendJson(res, 200, {
            ok: true,
            routeId: target,
            applied: { defaultContextWindow: Math.round(contextWindow), defaultMaxTokens: Math.round(maxTokens) },
            report: after,
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/expiry`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          const body = JSON.parse(raw || '{}')
          const routeId = body.routeId
          if (!routeId) return sendJson(res, 400, { ok: false, error: '缺少 routeId' })
          const card = listCards().find((c) => c.routeId === routeId)
          if (!card) return sendJson(res, 404, { ok: false, error: `没有路由 ${routeId}` })

          const ledger = readLedger()
          const entry = (ledger.routes[routeId] ??= { buckets: {} })

          // `expiresAtMs: null` clears the override and returns to the auto rule.
          if ('expiresAtMs' in body) {
            if (body.expiresAtMs === null || body.expiresAtMs === '') delete entry.expiresAtMs
            else {
              const at = Number(body.expiresAtMs)
              if (!Number.isFinite(at)) return sendJson(res, 400, { ok: false, error: '到期时间无效' })
              entry.expiresAtMs = Math.round(at)
            }
          }
          if ('hours' in body) {
            const hours = Number(body.hours)
            if (Number.isFinite(hours) && hours > 0 && hours <= 24 * 30) entry.hours = hours
            else if (body.hours === null) delete entry.hours
          }
          if ('cardPrice' in body) {
            const price = Number(body.cardPrice)
            if (Number.isFinite(price) && price >= 0) entry.cardPrice = price
            else if (body.cardPrice === null) delete entry.cardPrice
          }
          if (body.resetFirstCall === true) delete entry.firstCallAt

          ledgerDirtySince ||= Date.now()
          flushLedger(true)

          const expiry = resolveExpiry(card)
          return sendJson(res, 200, {
            ok: true,
            routeId,
            expiresAtMs: expiry.expiresAtMs ?? null,
            source: expiry.source,
            firstCallAt: entry.firstCallAt ?? null,
            hours: entry.hours ?? 24,
            cardPrice: entry.cardPrice ?? null,
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/usage-url`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          const { routeId, usageUrl } = JSON.parse(raw || '{}')
          if (!routeId) return sendJson(res, 400, { ok: false, error: '缺少 routeId' })
          const card = listCards().find((c) => c.routeId === routeId)
          if (!card) return sendJson(res, 404, { ok: false, error: `没有路由 ${routeId}` })

          const state = readState()
          const trimmed = typeof usageUrl === 'string' ? usageUrl.trim() : ''
          if (trimmed === '') {
            // Clearing falls back to the port convention.
            delete state.routes[routeId]?.usageUrl
            if (state.routes[routeId] && Object.keys(state.routes[routeId]).length === 0) delete state.routes[routeId]
            writeState(state)
            usageCache.delete(routeId)
            expiryCache.delete(routeId)
            expiryFailures.delete(routeId)
            return sendJson(res, 200, { ok: true, usageUrl: null })
          }

          let parsed
          try {
            parsed = new URL(trimmed)
          } catch {
            return sendJson(res, 400, { ok: false, error: '地址不是合法的 http(s) URL' })
          }
          if (!/^https?:$/.test(parsed.protocol)) {
            return sendJson(res, 400, { ok: false, error: '只支持 http/https' })
          }

          state.routes[routeId] = { ...(state.routes[routeId] ?? {}), usageUrl: trimmed }
          writeState(state)
          // Invalidate so the next read reflects the new endpoint immediately.
          usageCache.delete(routeId)
          expiryFailures.delete(routeId)

          // Probe once and report what it yields, so the user learns immediately
          // whether the address is right.
          const resolved = await usageUrlForProfile({ baseURL: card.baseURL, keyRef: card.keyRef, usageUrl: trimmed })
          const payload = resolved ? await fetchUsage(resolved, true, routeId) : { ok: false, error: '没有可用凭据' }
          if (payload?.ok && typeof payload.expiresAtMs === 'number') {
            expiryCache.set(routeId, {
              at: Date.now(),
              expiresAtMs: payload.expiresAtMs,
              remaining: payload.remaining,
              expireAt: payload.expireAt,
              routeId,
            })
          }
          return sendJson(res, 200, { ok: true, usageUrl: trimmed, probe: payload })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/remove`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          const { routeId, dropCredential } = JSON.parse(raw || '{}')
          if (!routeId) return sendJson(res, 400, { ok: false, error: '缺少 routeId' })
          const settings = ctx.get('settings')
          const resolved = piAiDescriptor()
          if (!settings || !resolved) return sendJson(res, 404, { ok: false, error: '找不到 llm-pi-ai 条目' })
          const profile = providersOf(resolved.descriptor)[routeId]
          await settings.mutate(
            resolved.ns,
            [{ op: 'unset', path: ['providers', routeId] }],
            resolved.descriptor.revision,
          )
          if (dropCredential && profile?.apiKeyEnv) {
            const credentials = ctx.get('credentials')
            if (credentials) await credentials.unset(profile.apiKeyEnv)
          }
          usageCache.clear()
          return sendJson(res, 200, { ok: true })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    },
  ]

  const disposers = []
  // ── usage recording ───────────────────────────────────────────────────────
  // Subscribe to the session event stream: each `assistant/message` carries the
  // metered usage of one step, which is the only per-request truth available for
  // a vendor that publishes no usage endpoint.
  try {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'assistant/message') return
          const data = event.data
          if (!data || typeof data !== 'object') return
          const usage = data.usage
          if (!usage || typeof usage !== 'object') return
          const model = data.message?.source?.model ?? data.source?.model ?? ''
          const routeId = routeForModel(model)
          if (!routeId) return
          const input = Number(usage.inputTokens) || 0
          const cache = Number(usage.cacheReadTokens) || 0
          // DSH guarantees reasoningTokens ⊆ outputTokens, so output is already
          // the billed figure and must not be summed with reasoning again.
          const output = Number(usage.outputTokens) || 0
          if (input + cache + output === 0) return
          recordUsage(routeId, { input, cache, output }, Date.now())
        } catch {
          /* a recording failure must never break the event stream */
        }
      }),
    )
  } catch (error) {
    log.warn?.(`card-panel: usage recording unavailable: ${error?.message}`)
  }

  // Periodic flush keeps the ledger current without writing on every single step.
  try {
    const timer = setInterval(() => flushLedger(true), 30_000)
    timer.unref?.()
    ctx.effect(() => () => {
      clearInterval(timer)
      flushLedger(true)
    })
  } catch {
    /* timers unavailable: the ledger still flushes on the next record */
  }

  const connection = ctx.get('connection')
  for (const route of routes) {
    // Wrapped here rather than per handler so a route added later cannot forget
    // the fence.
    const inner = route.handler
    const guarded = {
      ...route,
      handler: async (req, res) => {
        const verdict = fenceRejects(req, connection)
        if (verdict.rejected) {
          res.writeHead(verdict.status ?? 403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: `请求被拒绝：${verdict.reason}` }))
          return undefined
        }
        return inner(req, res)
      },
    }
    try {
      disposers.push(ctx.webServer.register(guarded))
    } catch (error) {
      log.warn?.(`card-panel: failed to register ${route.path}: ${error?.message}`)
    }
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })
}

export default { name, apply }
