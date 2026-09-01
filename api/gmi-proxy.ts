import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { timingSafeEqual as _timingSafeEqual } from 'crypto'
import { createClient, type VercelKV } from '@vercel/kv'

// 计费参数（每 1M token 单价，美元）——与 GMI 公布价一致，用于内部成本核算
const PRICES = {
  text_input: 5.0,
  cached_text_input: 1.25,
  image_input: 8.0,
  cached_image_input: 2.0,
  image_output: 30.0,
} as const

// 用户侧计价：0.2 元人民币/张；每人前 FREE_IMAGES 张免费
const PRICE_PER_IMAGE_CNY = 0.2
const FREE_IMAGES = 20

const GMI_BASE = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests/v1'
const STATS_FILE = join('/tmp', 'gmi-stats.json')
const STATS_KEY = 'gmi-stats'

export interface UsageEntry {
  images: number
  cost: number
  requests: number
  // 每日用量：{'YYYY-MM-DD': 张数}
  daily?: Record<string, number>
}
type StatsMap = Record<string, UsageEntry>

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

// 密码错误时连续失败限速（实例内限速；Serverless 多实例下仅尽力而为）
const failCounts = new Map<string, { count: number; until: number }>()

function getUsers() {
  // 环境变量格式：user1:password1,user2:password2
  const raw = process.env.ACCESS_USERS ?? ''
  const users = new Map<string, string>()
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    users.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  return users
}

function getGmiKey() {
  return process.env.GMI_API_KEY ?? ''
}

function getAdminToken() {
  return process.env.ADMIN_TOKEN ?? ''
}

// 密码校验：timingSafeEqual 防时序攻击
function verifyPassword(expected: string | undefined, password: string): boolean {
  if (!expected) return false
  const a = Buffer.from(password, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // 长度不同也做一次比较，保持耗时相似
    _timingSafeEqual(a, a)
    return false
  }
  return _timingSafeEqual(a, b)
}

// 配置了 KV 环境变量时用 Vercel KV（持久），否则降级到 /tmp 文件（实例生命周期内有效）
function getKv(): VercelKV | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null
  return createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  })
}

async function loadStats(): Promise<StatsMap> {
  const kv = getKv()
  if (kv) {
    try {
      const data = await kv.get<StatsMap>(STATS_KEY)
      return data ?? {}
    } catch (err) {
      console.warn('KV read failed, fallback to temp file', err)
    }
  }
  try {
    return JSON.parse(readFileSync(STATS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveStats(stats: StatsMap) {
  const kv = getKv()
  if (kv) {
    try {
      await kv.set(STATS_KEY, stats)
      return
    } catch (err) {
      console.warn('KV write failed', err)
    }
  }
  try {
    writeFileSync(STATS_FILE, JSON.stringify(stats))
  } catch (err) {
    console.warn('stats write failed', err)
  }
}

function getUsageCost(body: unknown): { images: number; cost: number } | null {
  if (!body || typeof body !== 'object') return null
  // 计费只认"确定性成功"：data 数组里每张图必须有 b64_json 或可访问的 url
  const data = Array.isArray((body as Record<string, unknown>).data)
    ? (body as Record<string, unknown>).data as unknown[]
    : []
  let images = 0
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.b64_json === 'string' && record.b64_json.length > 0) images += 1
    else if (typeof record.url === 'string' && record.url.startsWith('http')) images += 1
  }
  if (data.length === 0) return null // 无 data → 不计费
  if (images === 0) return null // 有 data 但没有一张有效图 → 不计

  // 成本按 token 精确核算（供内部对账；用户侧按张计价）
  let cost = 0
  const usage = (body as Record<string, unknown>).usage
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    const details = (u.input_tokens_details ?? {}) as Record<string, number>
    const outDetails = (u.output_tokens_details ?? {}) as Record<string, number>
    const textIn = Math.max(0, (details.text_tokens ?? 0) - (details.cached_text_tokens ?? details.text_tokens_cached ?? 0))
    const imgIn = Math.max(0, (details.image_tokens ?? 0) - (details.cached_image_tokens ?? details.image_tokens_cached ?? 0))
    cost =
      (textIn * PRICES.text_input + (details.cached_text_tokens ?? 0) * PRICES.cached_text_input
        + imgIn * PRICES.image_input + (details.cached_image_tokens ?? 0) * PRICES.cached_image_input
        + (outDetails.image_tokens ?? 0) * PRICES.image_output) / 1_000_000
  }
  return { images, cost }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS 预检：只允许同源（前端与函数同域名部署），防止第三方站点借用计费代理
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin ?? ''
    if (process.env.VERCEL_URL && origin.endsWith(`https://${process.env.VERCEL_URL}`)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    return res.status(204).end()
  }

  // GET /api/gmi-proxy?usage=me → 用户查询自己的用量（Bearer 用户名:密码）
  // GET /api/gmi-proxy → 查询全部用量（需 ADMIN_TOKEN）
  if (req.method === 'GET') {
    const auth = req.headers.authorization ?? ''
    const queryUsage = String((req.query as Record<string, unknown>).usage ?? '')
    if (queryUsage === 'me') {
      // 用户自查：校验自己的用户名密码后返回本人用量
      const token = auth.replace(/^Bearer\s+/i, '')
      const sepIdx = token.indexOf(':')
      const username = sepIdx > 0 ? token.slice(0, sepIdx) : token
      const password = sepIdx > 0 ? token.slice(sepIdx + 1) : ''
      const expected = getUsers().get(username)
      if (!verifyPassword(expected, password)) {
        return res.status(401).json({ error: '用户名或密码错误' })
      }
      const stats = await loadStats()
      const entry = stats[username] ?? { images: 0, cost: 0, requests: 0, daily: {} }
      const today = todayKey()
      const todayImages = entry.daily?.[today] ?? 0
      const billable = Math.max(0, entry.images - FREE_IMAGES)
      const todayBillable = Math.max(0, todayImages - 0) // 每日展示为当天总张数；免费额度按总量算
      return res.status(200).json({
        user: username,
        images: entry.images,
        requests: entry.requests,
        todayImages,
        freeQuota: FREE_IMAGES,
        remaining: Math.max(0, FREE_IMAGES - entry.images),
        pricePerImage: PRICE_PER_IMAGE_CNY,
        billableImages: billable,
        amount: Number((billable * PRICE_PER_IMAGE_CNY).toFixed(2)),
        cost: Number(entry.cost.toFixed(4)),
      })
    }
    if (!getAdminToken() || !verifyPassword(getAdminToken(), auth.replace(/^Bearer\s+/i, ''))) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="stats"')
      return res.status(401).json({ error: '需要 ADMIN_TOKEN 查询用量' })
    }
    const stats = await loadStats()
    const today = todayKey()
    const withTotal = Object.fromEntries(
      Object.entries(stats).map(([user, v]) => [user, {
        ...v,
        todayImages: v.daily?.[today] ?? 0,
        amount: Number((Math.max(0, v.images - FREE_IMAGES) * PRICE_PER_IMAGE_CNY).toFixed(2)),
        cost: Number(v.cost.toFixed(4)),
      }]),
    )
    const total = Object.values(stats).reduce((acc, v) => ({ images: acc.images + v.images, cost: acc.cost + v.cost, requests: acc.requests + v.requests }), { images: 0, cost: 0, requests: 0 })
    return res.status(200).json({ freeQuota: FREE_IMAGES, total: { ...total, cost: Number(total.cost.toFixed(4)) }, users: withTotal })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // —— 密码门禁：Authorization: Bearer <用户名:密码> ——
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const sep = auth.indexOf(':')
  const username = sep > 0 ? auth.slice(0, sep) : auth
  const password = sep > 0 ? auth.slice(sep + 1) : ''
  const users = getUsers()
  const now = Date.now()
  const fail = failCounts.get(username)
  if (fail && fail.until > now) {
    res.setHeader('Retry-After', Math.ceil((fail.until - now) / 1000))
    return res.status(429).json({ error: `失败次数过多，请 ${Math.ceil((fail.until - now) / 60000)} 分钟后再试` })
  }

  const expected = users.get(username)
  if (!verifyPassword(expected, password)) {
    const entry = failCounts.get(username) ?? { count: 0, until: 0 }
    entry.count += 1
    if (entry.count >= 5) {
      entry.count = 0
      entry.until = now + 10 * 60 * 1000
    }
    failCounts.set(username, entry)
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  failCounts.delete(username)

  // —— 转发到 GMI ——
  // 优先从 URL 提取 /api/gmi-proxy/ 后面的真实子路径（不依赖 rewrite 的 query 传参）
  const rawUrl = req.url ?? ''
  const marker = '/api/gmi-proxy/'
  const markerIdx = rawUrl.indexOf(marker)
  const subPath = markerIdx >= 0 ? rawUrl.slice(markerIdx + marker.length).split('?')[0] : ''
  // 兜底：rewrite 传入的 ?gmiPath= 或 ?path=（字符串或数组）
  const readQueryPath = (key: string) => {
    const value = (req.query as Record<string, unknown>)[key]
    return Array.isArray(value) ? value.join('/') : typeof value === 'string' ? value : ''
  }
  const gmiPath = (subPath || readQueryPath('gmiPath') || readQueryPath('path')).replace(/^\/+/, '')
  // GMI_BASE 已含 /v1，前端 baseUrl 按 OpenAI 惯例带 /v1/ —— 剥掉重复的版本前缀
  const gmiRelPath = gmiPath.startsWith('v1/') ? gmiPath.slice(3) : gmiPath
  const target = `${GMI_BASE}/${gmiRelPath}`
  const isEdits = gmiRelPath === 'images/edits'
  // multipart（图生图）：透传原始 body 与 Content-Type（含 boundary），不解析 JSON
  const upstreamContentType = req.headers['content-type'] ?? ''
  const isMultipart = upstreamContentType.startsWith('multipart/')
  let payload: unknown
  let upstreamBody: BodyInit
  if (isMultipart) {
    payload = { multipart: true }
    upstreamBody = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk as Buffer))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
    void payload
  } else {
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    } catch {
      return res.status(400).json({ error: '请求体必须是 JSON' })
    }
    upstreamBody = JSON.stringify(payload)
  }

  // GMI 的 gpt-image-2 不支持 size/quality = "auto"，做一层兜底：去掉或换成具体值
  if (!isMultipart && payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    // 请求体可能是 {model, prompt, payload: {...}}（GMI 原生封装）或纯 OpenAI 格式
    const inner = (record.payload && typeof record.payload === 'object' ? record.payload : record) as Record<string, unknown>
    // size: auto → 删除该字段让 GMI 用默认 1024x1024
    if (inner.size == null || inner.size === 'auto' || inner.size === '') delete inner.size
    // quality: auto → medium（GMI 默认质量，价格可预期）
    if (inner.quality === 'auto') inner.quality = 'medium'
    // background: auto → 删除走 GMI 默认
    if (inner.background === 'auto') delete inner.background
    if (inner.moderation === 'auto') delete inner.moderation
    // size 必须为 16 倍数的 WxH；否则规整到 16 倍数（保持宽高比尽量接近），上限 4096
    if (typeof inner.size === 'string' && /^\d+x\d+$/.test(inner.size)) {
      const [wRaw, hRaw] = inner.size.split('x').map(Number)
      const snap = (v: number) => Math.min(3840, Math.max(16, Math.round(v / 16) * 16))
      const snapped = `${snap(wRaw)}x${snap(hRaw)}`
      if (snapped !== inner.size) inner.size = snapped
    } else if (typeof inner.size !== 'string' || !/^\d+x\d+$/.test(String(inner.size))) {
      delete inner.size
    }
    upstreamBody = JSON.stringify(payload)
  }
  // 只允许转发到生图/生图编辑两个端点，防止被当作任意转发器
  if (gmiRelPath !== 'images/generations' && gmiRelPath !== 'images/edits') {
    return res.status(404).json({ error: '不支持的接口路径' })
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGmiKey()}`,
        'Content-Type': isMultipart ? upstreamContentType : 'application/json',
      },
      body: upstreamBody,
    })
  } catch (err) {
    console.error('GMI upstream error', err)
    return res.status(502).json({ error: '上游 API 请求失败' })
  }

  const text = await upstream.text()
  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')

  // 只统计确定性成功的生图：data 里每张必须有 b64_json 或 url；无图不计费
  if (upstream.ok) {
    try {
      const body = JSON.parse(text)
      const usage = getUsageCost(body)
      if (usage && usage.images > 0) {
        const stats = await loadStats()
        const entry = stats[username] ?? { images: 0, cost: 0, requests: 0, daily: {} }
        entry.images += usage.images
        entry.cost += usage.cost
        entry.requests += 1
        // 每日用量记录（保留最近 30 天，防止无限增长）
        const day = todayKey()
        const daily = entry.daily ?? {}
        daily[day] = (daily[day] ?? 0) + usage.images
        const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
        for (const key of Object.keys(daily)) {
          if (key < cutoff) delete daily[key]
        }
        entry.daily = daily
        stats[username] = entry
        await saveStats(stats)
      }
    } catch {
      // 非 JSON 响应不计数
    }
  }
  return res.send(text)
}
