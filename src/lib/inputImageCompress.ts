import imageCompression from 'browser-image-compression'

// 超过该体积的输入图在入库前压缩，避免超出部署平台（如 Vercel 4.5MB）的请求体上限
export const MAX_INPUT_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_INPUT_IMAGE_EDGE = 2048

export async function compressInputImageBlob(blob: Blob, filename = 'input'): Promise<Blob> {
  if (blob.size <= MAX_INPUT_IMAGE_BYTES) return blob
  try {
    const file = blob instanceof File ? blob : new File([blob], filename, { type: blob.type })
    const compressed = await imageCompression(file, {
      maxSizeMB: MAX_INPUT_IMAGE_BYTES / 1024 / 1024,
      maxWidthOrHeight: MAX_INPUT_IMAGE_EDGE,
      initialQuality: 0.88,
      fileType: 'image/webp',
      useWebWorker: true,
    })
    // 已高度压缩的图重编码后可能反而更大，此时保留原图
    return compressed.size < blob.size ? compressed : blob
  } catch (err) {
    console.warn('图片压缩失败，使用原图', err)
    return blob
  }
}
