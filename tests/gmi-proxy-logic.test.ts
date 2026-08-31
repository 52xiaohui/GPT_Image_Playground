import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'

process.env.ACCESS_USERS = 'alice:pass1,bob:pass2'
process.env.GMI_API_KEY = 'gmi-test-key'
process.env.ADMIN_TOKEN = 'admin-token'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

import handler from '../api/gmi-proxy'

type ReqLike = { method: string; headers: Record<string, string>; query: Record<string, string>; body?: unknown }
function makeRes() {
  const res: Record<string, unknown> = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown }
  ;(res as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => { (res.headers as Record<string, string>)[k] = v }
  ;(res as { status: (n: number) => unknown }).status = (n) => { res.statusCode = n; return res }
  ;(res as { send: (b: unknown) => void }).send = (b) => { res.body = b }
  ;(res as { json: (b: unknown) => void }).json = (b) => { res.body = b }
  ;(res as { end: () => void }).end = () => {}
  return res as { statusCode: number; headers: Record<string, string>; body: unknown }
}

const STATS_FILE = '/tmp/gmi-stats.json'
const upstreamCalls: Array<{ url: string; init: RequestInit }> = []
let failLockUser = false

// KV 模拟：实现 Upstash REST 协议（GET/SET/pipeline），写入内存 Map（跨请求保持，模拟持久化）
const kvStore = new Map<string, string>()
let kvServer: Server | null = null
let kvPort = 0

// Upstash 默认 responseEncoding=base64，响应需 base64 编码
const encodeResult = (value: string | null): string | null =>
  value === null ? null : Buffer.from(value, 'utf8').toString('base64')

async function startKvServer() {
  kvStore.clear()
  kvServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      res.setHeader('content-type', 'application/json')
      // 单命令：POST /get/key、/set/key（body 为含 key/value 的 JSON 数组）
      if (parts[0] === 'set' && parts[1]) {
        const args = JSON.parse(body || '[]') as unknown[]
        kvStore.set(String(args[0] ?? parts[1]), args[1] == null ? '' : String(args[1]))
        res.end(JSON.stringify({ result: encodeResult('OK') }))
        return
      }
      if (parts[0] === 'get' && parts[1]) {
        const value = kvStore.get(parts.slice(1).join('/'))
        res.end(JSON.stringify({ result: encodeResult(value ?? null) }))
        return
      }
      // 管道：POST /pipeline，body 为命令数组的 JSON，如 [["set","k","v"],["get","k"]]
      if (parts[0] === 'pipeline') {
        const commands = JSON.parse(body || '[]') as unknown[][]
        const results = commands.map((cmd) => {
          const name = String(cmd[0]).toLowerCase()
          if (name === 'set') {
            const key = String(cmd[1])
            const value = cmd[2] == null ? '' : String(cmd[2])
            kvStore.set(key, value)
            return { result: encodeResult('OK'), error: null }
          }
          if (name === 'get') {
            const raw = kvStore.get(String(cmd[1]))
            return { result: encodeResult(raw ?? null), error: null }
          }
          return { result: null, error: `unsupported command: ${name}` }
        })
        res.end(JSON.stringify(results))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => kvServer!.listen(0, '127.0.0.1', () => resolve()))
  const addr = kvServer?.address() as { port: number }
  kvPort = addr.port
  process.env.KV_REST_API_URL = `http://127.0.0.1:${kvPort}`
  process.env.KV_REST_API_TOKEN = 'test-token'
}

function stopKvServer() {
  if (!kvServer) return
  return new Promise<void>((resolve) => kvServer!.close(() => resolve()))
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  upstreamCalls.length = 0
  failLockUser = false
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    // KV 模拟服务器走真实 fetch，只有 GMI 上游请求被 mock
    if (kvPort && String(url).includes(`127.0.0.1:${kvPort}`)) {
      return originalFetch(url, init)
    }
    upstreamCalls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({
      created: 1, data: [{ b64_json: 'img' }, { b64_json: 'img' }],
      usage: { input_tokens: 10, input_tokens_details: { text_tokens: 10, image_tokens: 0 }, output_tokens: 200, output_tokens_details: { image_tokens: 200 }, total_tokens: 210 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  rmSync(STATS_FILE, { force: true })
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  rmSync(STATS_FILE, { force: true })
  await stopKvServer()
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
})

describe('gmi-proxy 鉴权与转发', () => {
  it('拒绝错误密码', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer alice:wrong' }, query: { path: 'images/generations' }, body: {} } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(401)
    expect(upstreamCalls).toHaveLength(0)
  })

  it('空用户名被拒绝', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer :x' }, query: { path: 'images/generations' }, body: {} } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(401)
  })

  it('正确密码转发到 GMI 并带上真实 Key，/tmp 模式计数 2 张', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer alice:pass1' }, query: { path: 'images/generations' }, body: { model: 'gpt-image-2', prompt: 'fox', n: 1 } } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(200)
    expect(upstreamCalls[0].url).toBe('https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests/v1/images/generations')
    expect((upstreamCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer gmi-test-key')

    const stats = JSON.parse(readFileSync(STATS_FILE, 'utf8'))
    expect(stats.alice.images).toBe(2)
    // 成本：(10*5 + 200*30) / 1e6 = 0.00605
    expect(stats.alice.cost).toBeCloseTo(0.00605, 6)
  })

  it('GET 用量接口需要 ADMIN_TOKEN', async () => {
    const req = { method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(401)

    const req2 = { method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: {} } as unknown as import('@vercel/node').VercelRequest
    const res2 = makeRes()
    await handler(req2, res2 as never)
    expect(res2.statusCode).toBe(200)
    expect((res2.body as { total?: unknown }).total).toBeDefined()
  })
})

describe('gmi-proxy KV 模式', () => {
  it('KV 可用时读写持久化存储', async () => {
    await startKvServer()
    process.env.KV_REST_API_URL = `http://127.0.0.1:${kvPort}`
    process.env.KV_REST_API_TOKEN = 'test'
    rmSync(STATS_FILE, { force: true })

    const req = { method: 'POST', headers: { authorization: 'Bearer bob:pass2' }, query: { path: 'images/generations' }, body: { model: 'gpt-image-2', prompt: 'cat' } } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(200)

    const stored = JSON.parse(kvStore.get('gmi-stats') ?? '{}')
    expect(stored.bob.images).toBe(2)
    expect(stored.bob.requests).toBe(1)
  })
})
describe('gmi-proxy auto 参数兜底', () => {
  it('size=auto 被移除，quality=auto 转为 medium', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer alice:pass1' }, query: { path: 'images/generations' }, body: { model: 'gpt-image-2', prompt: 'fox', size: 'auto', quality: 'auto', background: 'auto', n: 1 } } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    const sentBody = JSON.parse(String(upstreamCalls[0].init.body)) as Record<string, unknown>
    expect(sentBody.size).toBeUndefined()
    expect(sentBody.quality).toBe('medium')
    expect(sentBody.background).toBeUndefined()
    expect(sentBody.prompt).toBe('fox')
  })

  it('明确的 quality 保留 + size 规整到 16 倍数', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer alice:pass1' }, query: { path: 'images/generations' }, body: { model: 'gpt-image-2', prompt: 'cat', size: '1920x1080', quality: 'high' } } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(200)
    const sentBody = JSON.parse(String(upstreamCalls[0].init.body))
    expect(sentBody.size).toBe('1920x1088')
    expect(sentBody.quality).toBe('high')
  })
})

describe('gmi-proxy size 规整', () => {
  it('非 16 倍数的 size 被规整（1920x1080 → 1920x1088）', async () => {
    const req = { method: 'POST', headers: { authorization: 'Bearer alice:pass1' }, query: { path: 'images/generations' }, body: { model: 'gpt-image-2', prompt: 'x', size: '1920x1080' } } as unknown as import('@vercel/node').VercelRequest
    const res = makeRes()
    await handler(req, res as never)
    expect(res.statusCode).toBe(200)
    const sentBody = JSON.parse(String(upstreamCalls[0].init.body))
    expect(sentBody.size).toBe('1920x1088')
  })
})
