/**
 * `wss://livekit.example` → `https://livekit.example`: the origin a `<link rel="preconnect">` on
 * the Guest page warms so the first media connection skips DNS/TLS (SCREEN 17: link tap to
 * conversation in under 15 s). `null` when the URL is not something a browser can preconnect to.
 */
export function preconnectOrigin(livekitUrl: string): string | null {
  try {
    const url = new URL(livekitUrl)
    const protocol =
      url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return null
    return `${protocol}//${url.host}`
  } catch {
    return null
  }
}
