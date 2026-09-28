import { createHmac } from 'node:crypto'

/** A deployment secret retained for the entire replay lifetime of its rows. */
export function copyStorageKeySecret(secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new TypeError('An Act storage key secret of at least 32 bytes is required.')
  }
  return Uint8Array.from(secret)
}

/**
 * Store a stable, tenant/action-bound digest instead of the pipeline's raw key.
 * The raw key contains the canonical action inputs, which may contain PII.
 */
export function attemptStorageKey(
  secret: Uint8Array,
  tenantId: string,
  actionKind: string,
  rawIdempotencyKey: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['archava-act-attempt-key-v1', tenantId, actionKind, rawIdempotencyKey]))
    .digest('hex')
}
