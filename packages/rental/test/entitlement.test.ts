import { describe, it, expect, vi } from 'vitest'
import type { Address } from 'viem'
import { createRentalClient } from '../src/client.js'
import { EntitlementManager, InMemoryEntitlementStore } from '../src/entitlement.js'
import {
  AccessExpiredError,
  SessionLimitReachedError,
  UsageLimitReachedError,
} from '../src/errors.js'

describe('Entitlement & Concurrency Management', () => {
  const dummyContractAddress = '0x1234567890123456789012345678901234567890'
  const alice: Address = '0xaaaa111122223333444455556666777788889999'

  it('rejects access when onchain rental has expired', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(false)

    const manager = new EntitlementManager({ rentalClient: client })

    await expect(manager.acquireSessionCapability(alice)).rejects.toThrow(AccessExpiredError)
  })

  it('grants capability token and creates concurrency lease when access is active', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(true)

    const store = new InMemoryEntitlementStore()
    const manager = new EntitlementManager({
      rentalClient: client,
      store,
      leaseTimeoutMs: 30_000,
    })

    const capability = await manager.acquireSessionCapability(alice, 'archava-experience')

    expect(capability.capabilityToken).toMatch(/^archava_cap_[0-9a-f]+$/)
    expect(capability.wallet).toBe(alice)
    expect(capability.leaseId).toBeDefined()
    expect(capability.remainingMinutes).toBe(60)

    // Active lease is stored
    const activeLease = await store.getActiveLease(alice)
    expect(activeLease).not.toBeNull()
    expect(activeLease?.leaseId).toBe(capability.leaseId)
    expect(activeLease?.active).toBe(true)
  })

  it('enforces concurrent session limit (rejects second session while first is active)', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(true)

    const store = new InMemoryEntitlementStore()
    const manager = new EntitlementManager({
      rentalClient: client,
      store,
      leaseTimeoutMs: 30_000,
    })

    // First session succeeds
    await manager.acquireSessionCapability(alice)

    // Second session for same wallet must be rejected
    await expect(manager.acquireSessionCapability(alice)).rejects.toThrow(SessionLimitReachedError)
  })

  it('allows new session after lease is released', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(true)

    const store = new InMemoryEntitlementStore()
    const manager = new EntitlementManager({ rentalClient: client, store })

    const session1 = await manager.acquireSessionCapability(alice)

    // End session 1
    const ended = await manager.endSession(session1.leaseId)
    expect(ended).toBe(true)

    // Now session 2 should succeed
    const session2 = await manager.acquireSessionCapability(alice)
    expect(session2.leaseId).not.toBe(session1.leaseId)
  })

  it('heartbeat updates usage seconds and refreshes lease', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(true)

    const store = new InMemoryEntitlementStore()
    const manager = new EntitlementManager({
      rentalClient: client,
      store,
      leaseTimeoutMs: 10_000,
    })

    const session = await manager.acquireSessionCapability(alice)

    // Send heartbeat after 5 seconds elapsed
    const heartbeat = await manager.heartbeatSession(session.leaseId, 5)
    expect(heartbeat.active).toBe(true)
    expect(heartbeat.remainingSeconds).toBe(3600 - 5)

    const usage = await store.getUsage(alice)
    expect(usage.consumedSeconds).toBe(5)
  })

  it('enforces usage quota limit when exhausted', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    vi.spyOn(client, 'hasActiveAccess').mockResolvedValue(true)

    const store = new InMemoryEntitlementStore()
    const manager = new EntitlementManager({ rentalClient: client, store })

    // Simulate quota already exhausted
    const usage = await store.getUsage(alice)
    usage.consumedSeconds = usage.includedMinutes * 60

    await expect(manager.acquireSessionCapability(alice)).rejects.toThrow(UsageLimitReachedError)
  })
})
