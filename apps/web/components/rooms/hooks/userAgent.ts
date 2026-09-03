/** A phone or tablet browser — where "Open in Earth" makes sense (SCREEN 17, spec §112). */
export function isMobileUserAgent(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Android/i.test(userAgent)
}
