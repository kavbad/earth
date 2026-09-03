/**
 * Browser-side measurements of a chosen file before upload (spec §30 `width`, `height`,
 * `duration_ms`). Never throws: an undecodable file measures as `null` and still uploads.
 */
export interface MediaDimensions {
  readonly width: number
  readonly height: number
  readonly durationMs: number | null
}

function withObjectUrl<T>(file: Blob, run: (url: string) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(file)
  return run(url).finally(() => URL.revokeObjectURL(url))
}

export function measureImage(file: Blob): Promise<MediaDimensions | null> {
  if (typeof URL === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null)
  return withObjectUrl(
    file,
    (url) =>
      new Promise((resolve) => {
        const image = new Image()
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight, durationMs: null })
        image.onerror = () => resolve(null)
        image.src = url
      }),
  )
}

export function measureVideo(file: Blob): Promise<MediaDimensions | null> {
  if (typeof URL === 'undefined' || typeof document === 'undefined') return Promise.resolve(null)
  return withObjectUrl(
    file,
    (url) =>
      new Promise((resolve) => {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        video.onloadedmetadata = () =>
          resolve({
            width: video.videoWidth,
            height: video.videoHeight,
            durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
          })
        video.onerror = () => resolve(null)
        video.src = url
      }),
  )
}
