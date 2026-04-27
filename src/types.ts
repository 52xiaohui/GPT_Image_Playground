// ===== 设置 =====

export interface AppSettings {
  baseUrl: string
  apiKey: string
  model: string
  responsesImageModel: string
  responsesTransport: ResponsesTransportMode
  responsesImageInputMode: ResponsesImageInputMode
  timeout: number
  apiProtocol: ApiProtocol
  requestMode: RequestMode
}

export type ApiProtocol = 'auto' | 'images' | 'responses'
export type RequestMode = 'direct' | 'local_proxy'
export type ResponsesTransportMode = 'auto' | 'stream' | 'json'
export type ResponsesImageInputMode = 'auto' | 'file_id'
export type TaskView = 'gallery' | 'trash'

export interface ProviderConfig extends AppSettings {
  id: string
  name: string
}

export interface CategoryConfig {
  id: string
  name: string
  createdAt: number
}

export const ALL_CATEGORY_FILTER = '__all__'
export const UNCATEGORIZED_CATEGORY_FILTER = '__uncategorized__'
export const UNCATEGORIZED_CATEGORY_NAME = '未分类'
export const UNKNOWN_TASK_PROVIDER_NAME = '未记录供应商'

const DEFAULT_BASE_URL = import.meta.env.VITE_DEFAULT_API_URL?.trim() || 'https://api.openai.com'
const DEFAULT_REQUEST_MODE: RequestMode = import.meta.env.DEV ? 'local_proxy' : 'direct'

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  model: 'gpt-image-2',
  responsesImageModel: 'gpt-image-2',
  responsesTransport: 'auto',
  responsesImageInputMode: 'auto',
  timeout: 300,
  apiProtocol: 'auto',
  requestMode: DEFAULT_REQUEST_MODE,
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** 可直接用于预览的图片地址（data URL 或公网 http(s) URL） */
  dataUrl: string
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  /** 任务提交时选中的供应商 ID */
  providerId?: string | null
  /** 任务提交时记录的供应商名称快照 */
  providerName?: string | null
  /** 任务提交时记录的分类 ID */
  categoryId?: string | null
  /** 任务提交时记录的分类名称快照 */
  categoryName?: string | null
  /** 移入回收站时间，null 表示仍在画廊 */
  deletedAt?: number | null
  prompt: string
  params: TaskParams
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  /** 可直接用于显示的图片地址（data URL 或公网 http(s) URL） */
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 */
  source?: 'upload' | 'generated'
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings: AppSettings
  providers?: ProviderConfig[]
  activeProviderId?: string
  categories?: CategoryConfig[]
  activeCategoryFilter?: string
  tasks: TaskRecord[]
  /** imageId → 图片信息 */
  imageFiles: Record<string, {
    path?: string
    url?: string
    createdAt?: number
    source?: 'upload' | 'generated'
  }>
}

export function resolveTaskProviderName(
  task: Pick<TaskRecord, 'providerId' | 'providerName'>,
  providers: ProviderConfig[],
): string {
  const snapshotName = task.providerName?.trim()
  if (snapshotName) return snapshotName

  if (task.providerId) {
    const provider = providers.find((item) => item.id === task.providerId)
    if (provider?.name?.trim()) {
      return provider.name.trim()
    }
  }

  return UNKNOWN_TASK_PROVIDER_NAME
}

export function resolveTaskCategoryName(
  task: Pick<TaskRecord, 'categoryId' | 'categoryName'>,
  categories: CategoryConfig[],
): string {
  if (task.categoryId) {
    const category = categories.find((item) => item.id === task.categoryId)
    if (category?.name?.trim()) {
      return category.name.trim()
    }
  }

  const snapshotName = task.categoryName?.trim()
  return snapshotName || UNCATEGORIZED_CATEGORY_NAME
}

export function resolveCategoryFilterName(
  filter: string,
  categories: CategoryConfig[],
): string {
  if (filter === ALL_CATEGORY_FILTER) return '全部分类'
  if (filter === UNCATEGORIZED_CATEGORY_FILTER) return UNCATEGORIZED_CATEGORY_NAME

  const category = categories.find((item) => item.id === filter)
  return category?.name?.trim() || UNCATEGORIZED_CATEGORY_NAME
}

export function isTaskInRecycleBin(task: Pick<TaskRecord, 'deletedAt'>): boolean {
  return typeof task.deletedAt === 'number' && Number.isFinite(task.deletedAt)
}
