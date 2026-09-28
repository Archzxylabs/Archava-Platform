import { describe, expect, test } from 'vitest'

import { attemptStorageKey, copyStorageKeySecret } from '../src/storage-key.js'

const SECRET = new Uint8Array(32).fill(7)
const RAW_KEY = JSON.stringify({ inputs: { customerRef: 'visitor-123' }, sessionId: 'session-9' })

describe('SQL idempotency identity', () => {
  test('is stable for the same deployment key and raw attempt', () => {
    const first = attemptStorageKey(SECRET, 'tenant-1', 'booking', RAW_KEY)
    expect(attemptStorageKey(SECRET, 'tenant-1', 'booking', RAW_KEY)).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain('visitor-123')
  })

  test('separates tenants, actions, and raw attempts', () => {
    const first = attemptStorageKey(SECRET, 'tenant-1', 'booking', RAW_KEY)
    expect(attemptStorageKey(SECRET, 'tenant-2', 'booking', RAW_KEY)).not.toBe(first)
    expect(attemptStorageKey(SECRET, 'tenant-1', 'email', RAW_KEY)).not.toBe(first)
    expect(attemptStorageKey(SECRET, 'tenant-1', 'booking', `${RAW_KEY}!`)).not.toBe(first)
  })

  test('requires a substantial secret and copies it', () => {
    expect(() => copyStorageKeySecret(new Uint8Array(31))).toThrow(/at least 32 bytes/)
    const original = Uint8Array.from(SECRET)
    const copy = copyStorageKeySecret(original)
    original[0] = 0
    expect(copy[0]).toBe(7)
  })
})
