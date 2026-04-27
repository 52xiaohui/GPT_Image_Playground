import type { ApiProtocol, AppSettings, ImageApiResponse, TaskParams } from '../types'
import { buildApiUrl, normalizeProxyTargetBaseUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const RESPONSES_INLINE_IMAGE_MAX_DIMENSION = 1280
const RESPONSES_INLINE_IMAGE_TARGET_BYTES = 700 * 1024
const RESPONSES_INLINE_IMAGE_TOTAL_TARGET_BYTES = 1500 * 1024
const RESPONSES_INLINE_IMAGE_MIN_TARGET_BYTES = 220 * 1024
const RESPONSES_INLINE_IMAGE_MIN_DIMENSION = 768
const RESPONSES_INLINE_IMAGE_MIN_QUALITY = 0.55

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value)
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

function getDataUrlByteSize(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] || ''
  const paddingLength = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - paddingLength)
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('参考图解析失败'))
    image.src = src
  })
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('参考图压缩失败'))
        return
      }
      resolve(blob)
    }, type, quality)
  })
}

async function shrinkDataUrlForResponses(
  dataUrl: string,
  targetBytes = RESPONSES_INLINE_IMAGE_TARGET_BYTES,
): Promise<string> {
  const originalBytes = getDataUrlByteSize(dataUrl)
  const image = await loadImageElement(dataUrl)
  const largestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height)

  if (
    originalBytes <= targetBytes &&
    largestSide <= RESPONSES_INLINE_IMAGE_MAX_DIMENSION
  ) {
    return dataUrl
  }

  let scale = Math.min(1, RESPONSES_INLINE_IMAGE_MAX_DIMENSION / Math.max(largestSide, 1))
  let quality = 0.82
  let bestDataUrl = dataUrl
  let bestBytes = originalBytes

  for (let attempt = 0; attempt < 5; attempt++) {
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      return dataUrl
    }

    context.drawImage(image, 0, 0, width, height)

    const blob = await canvasToBlob(canvas, 'image/webp', quality)
    const nextDataUrl = await blobToDataUrl(blob, 'image/webp')
    const nextBytes = getDataUrlByteSize(nextDataUrl)

    if (nextBytes < bestBytes) {
      bestDataUrl = nextDataUrl
      bestBytes = nextBytes
    }

    if (nextBytes <= targetBytes) {
      return nextDataUrl
    }

    const currentLargestSide = Math.max(width, height)
    if (
      currentLargestSide <= RESPONSES_INLINE_IMAGE_MIN_DIMENSION &&
      quality <= RESPONSES_INLINE_IMAGE_MIN_QUALITY
    ) {
      break
    }

    scale *= 0.82
    quality = Math.max(RESPONSES_INLINE_IMAGE_MIN_QUALITY, quality - 0.08)
  }

  return bestDataUrl
}

function getFileExtensionFromMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.toLowerCase()
  if (!subtype) return 'png'
  if (subtype === 'jpeg') return 'jpg'
  return subtype
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
}

type ApiError = Error & {
  status?: number
}

function createApiError(message: string, status?: number): ApiError {
  const error = new Error(message) as ApiError
  if (status != null) {
    error.status = status
  }
  return error
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

interface ParsedSseEvent {
  event: string
  dataText: string
  json?: unknown
}

function parseSseEvents(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = []
  const lines = text.split(/\r?\n/)
  let currentEvent = ''
  let dataLines: string[] = []

  const flush = () => {
    if (!currentEvent && dataLines.length === 0) return

    const dataText = dataLines.join('\n')
    events.push({
      event: currentEvent,
      dataText,
      json: tryParseJson(dataText),
    })

    currentEvent = ''
    dataLines = []
  }

  for (const line of lines) {
    if (!line) {
      flush()
      continue
    }

    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }

  flush()
  return events
}

function extractErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null

  const directMessage = payload.message
  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage
  }

  const directDetail = payload.detail
  if (typeof directDetail === 'string' && directDetail.trim()) {
    return directDetail
  }
  if (Array.isArray(directDetail)) {
    const detailText = directDetail
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (isRecord(item)) {
          const nestedDetail = item.msg
          if (typeof nestedDetail === 'string') return nestedDetail.trim()
        }
        return ''
      })
      .filter(Boolean)
      .join('；')

    if (detailText) {
      return detailText
    }
  }

  const error = payload.error
  if (isRecord(error)) {
    const nestedMessage = error.message
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage
    }
  }

  return null
}

async function buildApiErrorFromResponse(response: Response): Promise<ApiError> {
  if (response.status === 524) {
    return createApiError(
      '上游站点处理超时（Cloudflare 524）。如果这次带了本地参考图，请优先改用公网图片 URL，或减少参考图数量后重试。',
      524,
    )
  }

  let errorMsg = `HTTP ${response.status}`

  try {
    const payload = await response.json()
    errorMsg = extractErrorMessage(payload) || errorMsg
  } catch {
    try {
      const text = await response.text()
      if (text.trim()) {
        errorMsg = text
      }
    } catch {
      /* ignore */
    }
  }

  return createApiError(errorMsg, response.status)
}

async function appendImageFromItem(
  images: string[],
  item: unknown,
  fallbackMime: string,
  signal: AbortSignal,
) {
  if (!isRecord(item)) return

  const b64 = item.b64_json
  if (typeof b64 === 'string' && b64) {
    images.push(normalizeBase64Image(b64, fallbackMime))
    return
  }

  const result = item.result
  if (typeof result === 'string' && result) {
    images.push(normalizeBase64Image(result, fallbackMime))
    return
  }

  if (isHttpUrl(item.url)) {
    images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime, signal))
    return
  }

  if (isHttpUrl(item.image_url)) {
    images.push(await fetchImageUrlAsDataUrl(item.image_url, fallbackMime, signal))
    return
  }

  const content = item.content
  if (Array.isArray(content)) {
    for (const contentItem of content) {
      await appendImageFromItem(images, contentItem, fallbackMime, signal)
    }
  }
}

async function parseImagesFromPayload(
  payload: unknown,
  fallbackMime: string,
  signal: AbortSignal,
): Promise<string[]> {
  const images: string[] = []
  if (!isRecord(payload)) return images

  const data = payload.data
  if (Array.isArray(data)) {
    for (const item of data) {
      await appendImageFromItem(images, item, fallbackMime, signal)
    }
  }

  const output = payload.output
  if (Array.isArray(output)) {
    for (const item of output) {
      await appendImageFromItem(images, item, fallbackMime, signal)
    }
  }

  const item = payload.item
  if (isRecord(item)) {
    await appendImageFromItem(images, item, fallbackMime, signal)
  }

  const response = payload.response
  if (isRecord(response)) {
    const nestedImages = await parseImagesFromPayload(response, fallbackMime, signal)
    images.push(...nestedImages)
  }

  return images
}

function shouldFallbackToResponses(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const status = (error as ApiError).status
  if (status != null && [404, 405, 501].includes(status)) {
    return true
  }

  return /(?:not found|no route|unknown endpoint|unsupported|not implemented|only .*responses|use .*responses|images\/(?:generations|edits))/i.test(
    error.message,
  )
}

interface SharedRequestContext {
  controller: AbortController
  requestHeaders: Record<string, string>
  proxyConfig: ReturnType<typeof readClientDevProxyConfig>
  mime: string
  forceProxy: boolean
}

interface ResponsesInputImage {
  type: 'input_image'
  image_url?: string
  file_id?: string
}

type ResponsesInputContent =
  | {
      type: 'input_text'
      text: string
    }
  | ResponsesInputImage

type ResponsesInputPayloadMode = 'compact-string' | 'message-list'

type ResponsesBodyMode =
  | 'edit-with-tool-choice'
  | 'edit-basic'
  | 'generate-with-tool-choice'
  | 'generate-basic'
  | 'generate-list-with-tool-choice'
  | 'generate-list-basic'

function getApiProtocol(settings: AppSettings): ApiProtocol {
  return settings.apiProtocol || 'auto'
}

function getResponsesImageModel(settings: AppSettings): string {
  return settings.responsesImageModel?.trim() || 'gpt-image-2'
}

function buildRequestUrl(baseUrl: string, path: string, ctx: SharedRequestContext): string {
  return buildApiUrl(baseUrl, path, ctx.proxyConfig, { forceProxy: ctx.forceProxy })
}

function shouldRetryResponsesWithCompatibility(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const status = (error as ApiError).status
  if (status === 524) {
    return false
  }
  if (status != null && status >= 500) {
    return true
  }

  return /(?:HTTP 5\d{2}|tool(?:_choice)?|image_generation|response|internal|server error|input must be a list|input.*array|expected.*list|expected.*array)/i.test(
    error.message,
  )
}

async function readResponsesPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  const directJson = tryParseJson(text)
  if (directJson !== undefined) {
    return directJson
  }

  const sseEvents = parseSseEvents(text)
  if (!sseEvents.length) {
    throw createApiError('Responses API 返回了非 JSON 响应，且不是可解析的 SSE 数据', response.status)
  }

  const jsonPayloads = sseEvents
    .map((event) => event.json)
    .filter((payload): payload is Record<string, unknown> => isRecord(payload))
  const outputItems = jsonPayloads
    .filter((payload) => payload.type === 'response.output_item.done' && isRecord(payload.item))
    .map((payload) => payload.item as Record<string, unknown>)

  const failedPayload = [...jsonPayloads].reverse().find((payload) => {
    if (payload.type === 'response.failed') return true
    const nestedResponse = payload.response
    return isRecord(nestedResponse) && nestedResponse.status === 'failed'
  })

  if (failedPayload) {
    const nestedResponse = isRecord(failedPayload.response) ? failedPayload.response : null
    const message =
      extractErrorMessage(failedPayload) ||
      (nestedResponse ? extractErrorMessage(nestedResponse) : null) ||
      'Responses API 处理失败'
    throw createApiError(message, response.status)
  }

  const completedPayload = [...jsonPayloads].reverse().find(
    (payload) => payload.type === 'response.completed' && isRecord(payload.response),
  )
  if (completedPayload && isRecord(completedPayload.response)) {
    const completedResponse = completedPayload.response as Record<string, unknown>
    const existingOutput = Array.isArray(completedResponse.output) ? completedResponse.output : []
    if (existingOutput.length > 0 || outputItems.length === 0) {
      return completedResponse
    }

    return {
      ...completedResponse,
      output: outputItems,
    }
  }

  if (outputItems.length > 0) {
    return {
      output: outputItems,
    }
  }

  const lastJsonPayload = [...jsonPayloads].reverse().find(Boolean)
  if (lastJsonPayload) {
    return lastJsonPayload
  }

  throw createApiError('Responses API 返回了 SSE，但未包含可解析的 JSON 事件', response.status)
}

async function callImagesApi(
  opts: CallApiOptions,
  ctx: SharedRequestContext,
): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  let response: Response

  if (isEdit) {
    const formData = new FormData()
    formData.append('model', settings.model)
    formData.append('prompt', prompt)
    formData.append('size', params.size)
    formData.append('quality', params.quality)
    formData.append('output_format', params.output_format)
    formData.append('moderation', params.moderation)

    if (params.output_format !== 'png' && params.output_compression != null) {
      formData.append('output_compression', String(params.output_compression))
    }

    for (let i = 0; i < inputImageDataUrls.length; i++) {
      const dataUrl = inputImageDataUrls[i]
      const blob = await dataUrlToBlob(dataUrl)
      const ext = blob.type.split('/')[1] || 'png'
      formData.append('image[]', blob, `input-${i + 1}.${ext}`)
    }

    response = await fetch(buildRequestUrl(settings.baseUrl, 'images/edits', ctx), {
      method: 'POST',
      headers: ctx.requestHeaders,
      cache: 'no-store',
      body: formData,
      signal: ctx.controller.signal,
    })
  } else {
    const body: Record<string, unknown> = {
      model: settings.model,
      prompt,
      size: params.size,
      quality: params.quality,
      output_format: params.output_format,
      moderation: params.moderation,
    }

    if (params.output_format !== 'png' && params.output_compression != null) {
      body.output_compression = params.output_compression
    }
    if (params.n > 1) {
      body.n = params.n
    }

    response = await fetch(buildRequestUrl(settings.baseUrl, 'images/generations', ctx), {
      method: 'POST',
      headers: {
        ...ctx.requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: ctx.controller.signal,
    })
  }

  if (!response.ok) {
    throw await buildApiErrorFromResponse(response)
  }

  const payload = await response.json() as ImageApiResponse
  const images = await parseImagesFromPayload(payload, ctx.mime, ctx.controller.signal)
  if (!images.length) {
    throw createApiError('接口未返回可用图片数据', response.status)
  }

  return { images }
}

async function uploadInputImageAsFileId(
  baseUrl: string,
  dataUrl: string,
  index: number,
  ctx: SharedRequestContext,
): Promise<string> {
  const blob = await dataUrlToBlob(dataUrl)
  const ext = getFileExtensionFromMime(blob.type)
  const formData = new FormData()
  formData.append('purpose', 'vision')
  formData.append('file', blob, `input-${index + 1}.${ext}`)

  const response = await fetch(buildRequestUrl(baseUrl, 'files', ctx), {
    method: 'POST',
    headers: ctx.requestHeaders,
    cache: 'no-store',
    body: formData,
    signal: ctx.controller.signal,
  })

  if (!response.ok) {
    throw await buildApiErrorFromResponse(response)
  }

  const payload = await response.json()
  if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id) {
    throw createApiError('文件上传成功，但未返回 file_id')
  }

  return payload.id
}

async function deleteUploadedFile(baseUrl: string, fileId: string, ctx: SharedRequestContext): Promise<void> {
  try {
    await fetch(buildRequestUrl(baseUrl, `files/${fileId}`, ctx), {
      method: 'DELETE',
      headers: ctx.requestHeaders,
      cache: 'no-store',
      signal: ctx.controller.signal,
    })
  } catch {
    /* ignore cleanup errors */
  }
}

async function prepareResponsesInputImages(
  baseUrl: string,
  inputImageDataUrls: string[],
  ctx: SharedRequestContext,
): Promise<{ inputImages: ResponsesInputImage[]; uploadedFileIds: string[] }> {
  if (!inputImageDataUrls.length) {
    return { inputImages: [], uploadedFileIds: [] }
  }

  const inputImages: ResponsesInputImage[] = []
  const uploadedFileIds: string[] = []
  const localDataUrlCount = inputImageDataUrls.filter((value) => isDataUrl(value)).length
  const inlineImageTargetBytes =
    localDataUrlCount > 0
      ? Math.max(
          RESPONSES_INLINE_IMAGE_MIN_TARGET_BYTES,
          Math.min(
            RESPONSES_INLINE_IMAGE_TARGET_BYTES,
            Math.floor(RESPONSES_INLINE_IMAGE_TOTAL_TARGET_BYTES / localDataUrlCount),
          ),
        )
      : RESPONSES_INLINE_IMAGE_TARGET_BYTES

  for (let i = 0; i < inputImageDataUrls.length; i++) {
    const inputImage = inputImageDataUrls[i]
    if (isHttpUrl(inputImage)) {
      inputImages.push({
        type: 'input_image',
        image_url: inputImage,
      })
      continue
    }

    if (isDataUrl(inputImage)) {
      // Responses API 支持把 data URL 直接作为 input_image.image_url 传入，
      // 这样可避免依赖部分中转站未实现的 /v1/files。
      const optimizedDataUrl = await shrinkDataUrlForResponses(inputImage, inlineImageTargetBytes)
      inputImages.push({
        type: 'input_image',
        image_url: optimizedDataUrl,
      })
      continue
    }

    if (!isDataUrl(inputImage)) {
      throw createApiError('不支持的参考图格式，请使用本地图片或公网图片 URL')
    }
  }

  return { inputImages, uploadedFileIds }
}

function buildResponsesInput(prompt: string, inputImages: ResponsesInputImage[]) {
  const content: ResponsesInputContent[] = []

  if (prompt.trim()) {
    content.push({ type: 'input_text', text: prompt })
  }

  for (const inputImage of inputImages) {
    content.push(inputImage)
  }

  return [
    {
      role: 'user',
      content,
    },
  ]
}

function buildResponsesInputPayload(
  prompt: string,
  inputImages: ResponsesInputImage[],
  mode: ResponsesInputPayloadMode,
) {
  if (mode === 'compact-string' && !inputImages.length && prompt.trim()) {
    return prompt.trim()
  }

  return buildResponsesInput(prompt, inputImages)
}

function buildResponsesBody(
  opts: CallApiOptions,
  inputImages: ResponsesInputImage[],
  mode: ResponsesBodyMode,
): Record<string, unknown> {
  const { settings, prompt, params } = opts
  const hasReferenceImages = inputImages.length > 0
  const inputPayloadMode: ResponsesInputPayloadMode =
    hasReferenceImages || mode === 'generate-list-with-tool-choice' || mode === 'generate-list-basic'
      ? 'message-list'
      : 'compact-string'
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    model: getResponsesImageModel(settings),
  }

  if (params.size) {
    tool.size = params.size
  }
  if (params.quality) {
    tool.quality = params.quality
  }
  if (params.output_format) {
    tool.output_format = params.output_format
  }
  if (params.moderation) {
    tool.moderation = params.moderation
  }
  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }
  tool.action = hasReferenceImages ? 'edit' : 'generate'

  const body: Record<string, unknown> = {
    model: settings.model,
    input: buildResponsesInputPayload(prompt, inputImages, inputPayloadMode),
    tools: [tool],
  }

  if (
    mode === 'edit-with-tool-choice' ||
    mode === 'generate-with-tool-choice' ||
    mode === 'generate-list-with-tool-choice'
  ) {
    body.tool_choice = { type: 'image_generation' }
  }

  return body
}

function buildResponsesBodies(
  opts: CallApiOptions,
  inputImages: ResponsesInputImage[],
): Array<Record<string, unknown>> {
  const modes: ResponsesBodyMode[] =
    inputImages.length > 0
      ? ['edit-with-tool-choice', 'edit-basic']
      : [
          'generate-with-tool-choice',
          'generate-basic',
          'generate-list-with-tool-choice',
          'generate-list-basic',
        ]

  return modes.map((mode) => buildResponsesBody(opts, inputImages, mode))
}

async function callResponsesApi(
  opts: CallApiOptions,
  ctx: SharedRequestContext,
): Promise<CallApiResult> {
  const requestCount = Math.max(1, opts.params.n || 1)
  const images: string[] = []
  const { inputImages, uploadedFileIds } = await prepareResponsesInputImages(
    opts.settings.baseUrl,
    opts.inputImageDataUrls,
    ctx,
  )
  const requestBodies = buildResponsesBodies(opts, inputImages)

  try {
    for (let i = 0; i < requestCount; i++) {
      let lastError: unknown = null

      for (let bodyIndex = 0; bodyIndex < requestBodies.length; bodyIndex++) {
        try {
          const response = await fetch(buildRequestUrl(opts.settings.baseUrl, 'responses', ctx), {
            method: 'POST',
            headers: {
              ...ctx.requestHeaders,
              'Content-Type': 'application/json',
            },
            cache: 'no-store',
            body: JSON.stringify(requestBodies[bodyIndex]),
            signal: ctx.controller.signal,
          })

          if (!response.ok) {
            throw await buildApiErrorFromResponse(response)
          }

          const payload = await readResponsesPayload(response)
          const parsedImages = await parseImagesFromPayload(payload, ctx.mime, ctx.controller.signal)
          if (!parsedImages.length) {
            throw createApiError('Responses API 未返回可用图片数据')
          }

          images.push(...parsedImages)
          lastError = null
          break
        } catch (error) {
          lastError = error
          const isLastBody = bodyIndex === requestBodies.length - 1
          if (isLastBody || !shouldRetryResponsesWithCompatibility(error)) {
            throw error
          }
        }
      }

      if (lastError) {
        throw lastError
      }
    }
  } finally {
    await Promise.all(uploadedFileIds.map((fileId) => deleteUploadedFile(opts.settings.baseUrl, fileId, ctx)))
  }

  if (!images.length) {
    throw createApiError('Responses API 未返回可用图片数据')
  }

  return { images }
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, params } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const forceProxy = settings.requestMode === 'local_proxy'

  if (forceProxy && !proxyConfig?.enabled) {
    throw createApiError(
      '本地代理模式已启用，但未检测到可用的开发代理。请确认 dev-proxy.config.json 存在，并重启 npm run dev。',
    )
  }

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${settings.apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }

  if (forceProxy) {
    const proxyTargetBaseUrl = normalizeProxyTargetBaseUrl(settings.baseUrl)
    if (!proxyTargetBaseUrl) {
      throw createApiError('API URL 无效，请检查设置中的 API URL')
    }
    requestHeaders['X-Dev-Proxy-Target'] = proxyTargetBaseUrl
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    const ctx: SharedRequestContext = {
      controller,
      requestHeaders,
      proxyConfig,
      mime,
      forceProxy,
    }
    const apiProtocol = getApiProtocol(settings)

    if (apiProtocol === 'responses') {
      return await callResponsesApi(opts, ctx)
    }

    if (apiProtocol === 'images') {
      return await callImagesApi(opts, ctx)
    }

    try {
      return await callImagesApi(opts, ctx)
    } catch (error) {
      if (!shouldFallbackToResponses(error)) {
        throw error
      }
    }

    return await callResponsesApi(opts, ctx)
  } finally {
    clearTimeout(timeoutId)
  }
}
