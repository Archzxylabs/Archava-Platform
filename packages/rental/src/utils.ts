/**
 * Generates cryptographically secure random hex string using standard Web Crypto API.
 * Works natively in both Node.js 18+ and modern browsers without 'node:crypto'.
 */
export function randomHex(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  }
  return hex
}
