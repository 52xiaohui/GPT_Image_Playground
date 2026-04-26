import { readFileSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { normalizeDevProxyConfig, normalizeProxyTargetBaseUrl } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const DEV_PROXY_TARGET_HEADER = 'x-dev-proxy-target'
const RESPONSE_HEADERS_TO_SKIP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const REQUEST_HEADERS_TO_SKIP = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  DEV_PROXY_TARGET_HEADER,
])

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function matchesProxyPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function joinTargetPath(basePath: string, path: string): string {
  const normalizedBasePath = trimTrailingSlashes(basePath || '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBasePath}${normalizedPath}` || '/'
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    return undefined
  }

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined))
    req.on('error', reject)
  })
}

function getProxyTargetHeader(req: IncomingMessage): string {
  const value = req.headers[DEV_PROXY_TARGET_HEADER]
  if (Array.isArray(value)) {
    return value[0] || ''
  }
  return typeof value === 'string' ? value : ''
}

function buildUpstreamHeaders(req: IncomingMessage, targetUrl: URL, changeOrigin: boolean): Headers {
  const headers = new Headers()

  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (REQUEST_HEADERS_TO_SKIP.has(name.toLowerCase())) continue

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item)
      }
    } else {
      headers.set(name, value)
    }
  }

  // 避免把压缩后的响应体原样转回浏览器，导致前端按 JSON 解析时报乱码。
  headers.set('accept-encoding', 'identity')

  if (changeOrigin) {
    if (headers.has('origin')) {
      headers.set('origin', targetUrl.origin)
    }
    if (headers.has('referer')) {
      headers.set('referer', `${targetUrl.origin}/`)
    }
  }

  return headers
}

function writeProxyResponse(res: ServerResponse, upstream: Response, body: Buffer): void {
  res.statusCode = upstream.status
  res.statusMessage = upstream.statusText

  upstream.headers.forEach((value, name) => {
    if (RESPONSE_HEADERS_TO_SKIP.has(name.toLowerCase())) return
    res.setHeader(name, value)
  })

  res.end(body)
}

async function proxyDevRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
  config: NonNullable<ReturnType<typeof loadDevProxyConfig>>,
): Promise<void> {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
  if (!matchesProxyPrefix(requestUrl.pathname, config.prefix)) {
    next()
    return
  }

  const requestedTarget = getProxyTargetHeader(req)
  const targetBaseUrl = normalizeProxyTargetBaseUrl(requestedTarget || config.target)
  if (!targetBaseUrl) {
    res.statusCode = 502
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('本地代理未配置有效的目标地址')
    return
  }

  const proxiedPath = requestUrl.pathname.slice(config.prefix.length) || '/'
  const targetUrl = new URL(targetBaseUrl)
  targetUrl.pathname = joinTargetPath(targetUrl.pathname, proxiedPath)
  targetUrl.search = requestUrl.search

  try {
    const body = await readRequestBody(req)
    const upstream = await fetch(targetUrl, {
      method: req.method || 'GET',
      headers: buildUpstreamHeaders(req, targetUrl, config.changeOrigin),
      body,
    })
    const responseBody = Buffer.from(await upstream.arrayBuffer())
    writeProxyResponse(res, upstream, responseBody)
  } catch (error) {
    res.statusCode = 502
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(`本地代理转发失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [
      react(),
      {
        name: 'dynamic-dev-proxy',
        configureServer(server) {
          if (!devProxyConfig?.enabled) return

          server.middlewares.use((req, res, next) => {
            void proxyDevRequest(req, res, next, devProxyConfig).catch(next)
          })
        },
      },
    ],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
    },
  }
})
