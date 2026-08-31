import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createClient, type VercelKV } from '@vercel/kv'

// 计费参数（每 1M token 单价，美元）——与 GMI 公布价一致，可按需加价
const PRICES = {
  text_input: 5.0,
  cached_text_input: 1.25,
  image_input: 8.0,
  cached_image_input: 2.0,
  image_output: 30.0,
} as const

const GMI_BASE = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests/v1'
const STATS_FILE = join('/tmp', 'gmi-stats.json')
const STATS_KEY = 'gmi-stats'

export interface UsageEntry { images: number; cost: number; requests: number }
type StatsMap = Record<string, UsageEntry>

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
    mkdirSync('/tmp', { recursive: true })
    writeFileSync(STATS_FILE, JSON.stringify(stats))
  } catch (err) {
    console.warn('stats write failed', err)
  }
}

function getUsageCost(body: unknown): { images: number; cost: number } | null {
  if (!body || typeof body !== 'object') return null
  const usage = (body as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const details = (u.input_tokens_details ?? {}) as Record<string, number>
  const outDetails = (u.output_tokens_details ?? {}) as Record<string, number>
  const textIn = (details.text_tokens ?? 0) - (details.cached_text_tokens ?? details.text_tokens_cached ?? 0)
  const imgIn = (details.image_tokens ?? 0) - (details.cached_image_tokens ?? details.image_tokens_cached ?? 0)
  const cost =
    (textIn * PRICES.text_input + (details.cached_text_tokens ?? 0) * PRICES.cached_text_input
      + imgIn * PRICES.image_input + (details.cached_image_tokens ?? 0) * PRICES.cached_image_input
      + (outDetails.image_tokens ?? 0) * PRICES.image_output) / 1_000_000
  // data 数组条目数即图片张数；无 data 时按 0 计
  const data = Array.isArray((body as Record<string, unknown>).data) ? (body as Record<string, unknown>).data as unknown[] : []
  return { images: data.length, cost }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
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
      if (!expected || expected !== password) {
        return res.status(401).json({ error: '用户名或密码错误' })
      }
      const stats = await loadStats()
      const entry = stats[username] ?? { images: 0, cost: 0, requests: 0 }
      return res.status(200).json({ user: username, images: entry.images, requests: entry.requests, cost: Number(entry.cost.toFixed(4)) })
    }
    if (!getAdminToken() || auth !== `Bearer ${getAdminToken()}`) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="stats"')
      return res.status(401).json({ error: '需要 ADMIN_TOKEN 查询用量' })
    }
    const stats = await loadStats()
    const withTotal = Object.fromEntries(
      Object.entries(stats).map(([user, v]) => [user, { ...v, cost: Number(v.cost.toFixed(4)) }]),
    )
    const total = Object.values(stats).reduce((acc, v) => ({ images: acc.images + v.images, cost: acc.cost + v.cost, requests: acc.requests + v.requests }), { images: 0, cost: 0, requests: 0 })
    return res.status(200).json({ total: { ...total, cost: Number(total.cost.toFixed(4)) }, users: withTotal })
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
  if (!expected || expected !== password) {
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
  let payload: unknown
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: '请求体必须是 JSON' })
  }

  // GMI 的 gpt-image-2 不支持 size/quality = "auto"，做一层兜底：去掉或换成具体值
  if (payload && typeof payload === 'object') {
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
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGmiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('GMI upstream error', err)
    return res.status(502).json({ error: '上游 API 请求失败' })
  }

  const text = await upstream.text()
  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json')

  // 成功的生图响应才计数；失败不阻塞响应返回
  if (upstream.ok) {
    try {
      const body = JSON.parse(text)
      const usage = getUsageCost(body)
      if (usage) {
        const stats = await loadStats()
        const entry = stats[username] ?? { images: 0, cost: 0, requests: 0 }
        entry.images += usage.images
        entry.cost += usage.cost
        entry.requests += 1
        stats[username] = entry
        await saveStats(stats)
      }
    } catch {
      // 非 JSON 响应不计数
    }
  }
  return res.send(text)
}