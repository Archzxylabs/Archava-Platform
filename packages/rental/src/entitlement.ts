import type { Address } from 'viem'
import { randomHex } from './utils.js'
import type { RentalClient } from './client.js'
import {
  AccessExpiredError,
  SessionLimitReachedError,
  UsageLimitReachedError,
  RentalError,
} from './errors.js'

export interface SessionLease {
  readonly leaseId: string
  readonly wallet: Address
  readonly sessionType: string
  readonly startedAt: number
  lastHeartbeatAt: number
  leaseExpiresAt: number
  active: boolean
}

export interface WalletUsageRecord {
  readonly wallet: Address
  planId: string
  includedMinutes: number
  consumedSeconds: number
  updatedAt: number
}

export interface SessionCapability {
  readonly capabilityToken: string
  readonly leaseId: string
  readonly wallet: Address
  readonly sessionType: string
  readonly expiresAt: number
  readonly remainingSeconds: number
  readonly remainingMinutes: number
}

/**
 * Storage interface for offchain usage metering and session concurrency leases.
 * Distinct and separate from onchain time-based contract entitlement.
 */
export interface EntitlementStore {
  getUsage(wallet: Address): Promise<WalletUsageRecord>
  setPlan(wallet: Address, planId: string, includedMinutes: number): Promise<WalletUsageRecord>
  incrementUsage(wallet: Address, elapsedSeconds: number): Promise<WalletUsageRecord>
  getActiveLease(wallet: Address): Promise<SessionLease | null>
  createLease(wallet: Address, sessionType: string, leaseDurationMs: number): Promise<SessionLease>
  heartbeatLease(
    leaseId: string,
    leaseDurationMs: number,
    elapsedSeconds: number,
  ): Promise<SessionLease | null>
  releaseLease(leaseId: string): Promise<boolean>
}

/**
 * =============================================================================
 * IN-MEMORY DEMO ENTITLEMENT STORE
 * =============================================================================
 * WARNING: Non-persistent, local process memory only.
 * This adapter is designed exclusively for hackathon demonstration.
 * It is NOT horizontally scalable and will not survive process restarts.
 * In production, replace with a distributed Redis or database store.
 * =============================================================================
 */
export class InMemoryEntitlementStore implements EntitlementStore {
  private readonly usageRecords = new Map<string, WalletUsageRecord>()
  private readonly leases = new Map<string, SessionLease>() // leaseId => lease
  private readonly activeLeasesByWallet = new Map<string, string>() // wallet => leaseId

  getUsage(wallet: Address): Promise<WalletUsageRecord> {
    const key = wallet.toLowerCase()
    let record = this.usageRecords.get(key)
    if (!record) {
      record = {
        wallet,
        planId: 'default-package',
        includedMinutes: 60, // default 60 minutes included quota
        consumedSeconds: 0,
        updatedAt: Date.now(),
      }
      this.usageRecords.set(key, record)
    }
    return Promise.resolve(record)
  }

  async setPlan(
    wallet: Address,
    planId: string,
    includedMinutes: number,
  ): Promise<WalletUsageRecord> {
    const record = await this.getUsage(wallet)
    record.planId = planId
    record.includedMinutes = includedMinutes
    record.updatedAt = Date.now()
    return record
  }

  async incrementUsage(wallet: Address, elapsedSeconds: number): Promise<WalletUsageRecord> {
    const record = await this.getUsage(wallet)
    record.consumedSeconds += Math.max(0, elapsedSeconds)
    record.updatedAt = Date.now()
    return record
  }

  getActiveLease(wallet: Address): Promise<SessionLease | null> {
    const key = wallet.toLowerCase()
    const leaseId = this.activeLeasesByWallet.get(key)
    if (!leaseId) return Promise.resolve(null)

    const lease = this.leases.get(leaseId)
    if (!lease || !lease.active) {
      this.activeLeasesByWallet.delete(key)
      return Promise.resolve(null)
    }

    // Check lease timeout
    if (Date.now() > lease.leaseExpiresAt) {
      lease.active = false
      this.activeLeasesByWallet.delete(key)
      return Promise.resolve(null)
    }

    return Promise.resolve(lease)
  }

  createLease(
    wallet: Address,
    sessionType: string,
    leaseDurationMs: number,
  ): Promise<SessionLease> {
    const now = Date.now()
    const leaseId = randomHex(16)
    const lease: SessionLease = {
      leaseId,
      wallet,
      sessionType,
      startedAt: now,
      lastHeartbeatAt: now,
      leaseExpiresAt: now + leaseDurationMs,
      active: true,
    }

    this.leases.set(leaseId, lease)
    this.activeLeasesByWallet.set(wallet.toLowerCase(), leaseId)
    return Promise.resolve(lease)
  }

  async heartbeatLease(
    leaseId: string,
    leaseDurationMs: number,
    elapsedSeconds: number,
  ): Promise<SessionLease | null> {
    const lease = this.leases.get(leaseId)
    if (!lease || !lease.active) return null

    const now = Date.now()
    // Lease expired without heartbeat
    if (now > lease.leaseExpiresAt) {
      lease.active = false
      this.activeLeasesByWallet.delete(lease.wallet.toLowerCase())
      return null
    }

    lease.lastHeartbeatAt = now
    lease.leaseExpiresAt = now + leaseDurationMs

    // Meter usage
    if (elapsedSeconds > 0) {
      await this.incrementUsage(lease.wallet, elapsedSeconds)
    }

    return lease
  }

  releaseLease(leaseId: string): Promise<boolean> {
    const lease = this.leases.get(leaseId)
    if (!lease) return Promise.resolve(false)

    lease.active = false
    this.activeLeasesByWallet.delete(lease.wallet.toLowerCase())
    return Promise.resolve(true)
  }
}

export interface EntitlementManagerOptions {
  readonly rentalClient: Pick<RentalClient, 'hasActiveAccess'> & {
    readonly getIncludedMinutes?: (wallet: string) => Promise<number>
  }
  readonly store?: EntitlementStore
  readonly leaseTimeoutMs?: number // default 60s
  readonly defaultIncludedMinutes?: number // default 60m
}

export class EntitlementManager {
  readonly rentalClient: EntitlementManagerOptions['rentalClient']
  readonly store: EntitlementStore
  readonly leaseTimeoutMs: number
  readonly defaultIncludedMinutes: number

  constructor(options: EntitlementManagerOptions) {
    this.rentalClient = options.rentalClient
    this.store = options.store ?? new InMemoryEntitlementStore()
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 60_000 // 60 seconds lease TTL
    this.defaultIncludedMinutes = options.defaultIncludedMinutes ?? 60
  }

  /**
   * Enforces authoritative entitlement:
   * 1. Reads expiresAt(wallet) from BSC contract. Fails closed if expired or RPC fails.
   * 2. Checks offchain minute usage limits.
   * 3. Checks concurrent session lease limits (max 1 session per wallet).
   * 4. Acquires lease and issues capability token for session access.
   */
  async acquireSessionCapability(
    wallet: Address,
    sessionType = 'archava-experience',
  ): Promise<SessionCapability> {
    // 1. Authoritative BSC smart contract check
    const hasAccess = await this.rentalClient.hasActiveAccess(wallet)
    if (!hasAccess) {
      throw new AccessExpiredError(
        `Wallet ${wallet} has no active rental on BSC Testnet. Access expired.`,
      )
    }

    // 2. Offchain usage metering check
    const includedMinutes = this.rentalClient.getIncludedMinutes
      ? await this.rentalClient.getIncludedMinutes(wallet)
      : this.defaultIncludedMinutes
    const usage = await this.store.setPlan(
      wallet,
      `package-${includedMinutes}-minutes`,
      includedMinutes,
    )
    const maxAllowedSeconds = usage.includedMinutes * 60
    if (usage.consumedSeconds >= maxAllowedSeconds) {
      throw new UsageLimitReachedError(
        `Usage quota of ${usage.includedMinutes} minutes has been reached for wallet ${wallet}.`,
      )
    }

    // 3. Concurrency check (max 1 active session)
    const existingLease = await this.store.getActiveLease(wallet)
    if (existingLease && existingLease.active) {
      throw new SessionLimitReachedError(
        `Active session lease (${existingLease.leaseId}) already in progress for wallet ${wallet}.`,
      )
    }

    // 4. Create new lease
    const lease = await this.store.createLease(wallet, sessionType, this.leaseTimeoutMs)

    // Generate short-lived capability token
    const capabilityToken = `archava_cap_${randomHex(24)}`
    const remainingSeconds = Math.max(0, maxAllowedSeconds - usage.consumedSeconds)

    return {
      capabilityToken,
      leaseId: lease.leaseId,
      wallet,
      sessionType,
      expiresAt: lease.leaseExpiresAt,
      remainingSeconds,
      remainingMinutes: Math.ceil(remainingSeconds / 60),
    }
  }

  /**
   * Heartbeat to keep session lease alive and meter consumed seconds.
   */
  async heartbeatSession(
    leaseId: string,
    elapsedSeconds: number,
  ): Promise<{
    readonly active: boolean
    readonly leaseExpiresAt: number
    readonly remainingSeconds: number
  }> {
    const lease = await this.store.heartbeatLease(leaseId, this.leaseTimeoutMs, elapsedSeconds)
    if (!lease) {
      throw new RentalError('SESSION_LIMIT_REACHED', 'Session lease not found or expired', 410)
    }

    const usage = await this.store.getUsage(lease.wallet)
    const maxAllowedSeconds = usage.includedMinutes * 60
    const remainingSeconds = Math.max(0, maxAllowedSeconds - usage.consumedSeconds)

    if (remainingSeconds <= 0) {
      await this.store.releaseLease(leaseId)
      throw new UsageLimitReachedError('Usage limit reached during session')
    }

    return {
      active: true,
      leaseExpiresAt: lease.leaseExpiresAt,
      remainingSeconds,
    }
  }

  /**
   * Ends an active session lease idempotently.
   */
  async endSession(leaseId: string): Promise<boolean> {
    return this.store.releaseLease(leaseId)
  }
}
