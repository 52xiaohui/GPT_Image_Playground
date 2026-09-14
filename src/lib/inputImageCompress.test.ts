import { describe, expect, it, vi, beforeEach } from 'vitest'
import imageCompression from 'browser-image-compression'
import { compressInputImageBlob, MAX_INPUT_IMAGE_BYTES } from './inputImageCompress'

vi.mock('browser-image-compression', () => ({ default: vi.fn() }))

function blobOfSize(size: number, type = 'image/png'): Blob {
  return new Blob([new Uint8Array(size)], { type })
}

beforeEach(() => {
  vi.mocked(imageCompression).mockReset()
})

describe('compressInputImageBlob', () => {
  it('returns the original blob unchanged when within the size limit', async () => {
    const blob = blobOfSize(1024)
    expect(await compressInputImageBlob(blob)).toBe(blob)
    expect(imageCompression).not.toHaveBeenCalled()
  })

  it('compresses oversized images to webp within the size cap', async () => {
    const blob = blobOfSize(MAX_INPUT_IMAGE_BYTES + 1)
    const compressed = new File([new Uint8Array(100)], 'input.webp', { type: 'image/webp' })
    vi.mocked(imageCompression).mockResolvedValue(compressed)

    expect(await compressInputImageBlob(blob)).toBe(compressed)
    expect(imageCompression).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({
      maxSizeMB: 2,
      maxWidthOrHeight: 2048,
      fileType: 'image/webp',
    }))
  })

  it('keeps the original when compression produces a larger result', async () => {
    const blob = blobOfSize(MAX_INPUT_IMAGE_BYTES + 1)
    vi.mocked(imageCompression).mockResolvedValue(new File([new Uint8Array(MAX_INPUT_IMAGE_BYTES + 2)], 'input.webp'))

    expect(await compressInputImageBlob(blob)).toBe(blob)
  })

  it('falls back to the original when compression throws', async () => {
    const blob = blobOfSize(MAX_INPUT_IMAGE_BYTES + 1)
    vi.mocked(imageCompression).mockRejectedValue(new Error('no canvas'))

    expect(await compressInputImageBlob(blob)).toBe(blob)
  })
})
