import { verifyMessage, isAddress, getAddress, type Address, type Hex } from 'viem'
import { randomHex } from './utils.js'
import { RentalError } from './errors.js'

export interface AuthSession {
  readonly sessionId: string
  readonly wallet: Address
  readonly chainId: number
  readonly issuedAt: number // Unix timestamp ms
  readonly expiresAt: number // Unix timestamp ms
}

/**
 * Explicit storage interface for wallet authentication nonces and sessions.
 * Production implementations should back this interface with Redis or PostgreSQL.
 */
export interface AuthStore {
  /**
   * Stores a single-use nonce with a time-to-live.
   */
  createNonce(ttlSeconds?: number): Promise<string>

  /**
   * Consumes a single-use nonce. Returns true if valid and consumed; false if missing or already consumed.
   */
  consumeNonce(nonce: string): Promise<boolean>

  /**
   * Saves an active authenticated session.
   */
  saveSession(session: AuthSession): Promise<void>

  /**
   * Retrieves a session by ID. Returns null if not found or expired.
   */
  getSession(sessionId: string): Promise<AuthSession | null>

  /**
   * Explicitly terminates a session.
   */
  destroySession(sessionId: string): Promise<void>
}

/**
 * =============================================================================
 * IN-MEMORY DEMO AUTH STORE
 * =============================================================================
 * WARNING: Non-persistent, local process memory only.
 * This adapter is designed exclusively for demo and hackathon evaluation.
 * It is NOT horizontally scalable and will be lost on process restart.
 * In production, replace with a distributed Redis or database store.
 * =============================================================================
 */
export class InMemoryAuthStore implements AuthStore {
  private readonly nonces = new Map<string, number>() // nonce => expiryTimestampMs
  private readonly sessions = new Map<string, AuthSession>()

  createNonce(ttlSeconds = 300): Promise<string> {
    const nonce = randomHex(16)
    const expiresAt = Date.now() + ttlSeconds * 1000
    this.nonces.set(nonce, expiresAt)
    return Promise.resolve(nonce)
  }

  consumeNonce(nonce: string): Promise<boolean> {
    const expiresAt = this.nonces.get(nonce)
    if (expiresAt === undefined) return Promise.resolve(false)

    // Invalidate immediately upon consumption (single-use)
    this.nonces.delete(nonce)

    if (Date.now() > expiresAt) {
      return Promise.resolve(false) // expired
    }
    return Promise.resolve(true)
  }

  saveSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.sessionId, session)
    return Promise.resolve()
  }

  getSession(sessionId: string): Promise<AuthSession | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve(null)

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId)
      return Promise.resolve(null)
    }

    return Promise.resolve(session)
  }

  destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    return Promise.resolve()
  }

  /**
   * Helper for tests to clean up expired entries.
   */
  prune(): void {
    const now = Date.now()
    for (const [nonce, expiresAt] of this.nonces.entries()) {
      if (now > expiresAt) this.nonces.delete(nonce)
    }
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt) this.sessions.delete(id)
    }
  }
}

export interface SiweMessageParams {
  readonly domain: string
  readonly address: string
  readonly uri: string
  readonly chainId: number
  readonly nonce: string
  readonly issuedAt: string
  readonly expirationTime: string
  readonly statement?: string
}

/**
 * Formats a canonical SIWE-compliant sign-in message.
 */
export function formatSiweMessage(params: SiweMessageParams): string {
  const statement =
    params.statement ?? 'Sign in to Archava Platform with your BNB Smart Chain wallet.'

  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    statement,
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expirationTime}`,
  ].join('\n')
}

export interface ParsedSiweMessage {
  readonly domain: string
  readonly address: Address
  readonly statement: string
  readonly uri: string
  readonly chainId: number
  readonly nonce: string
  readonly issuedAt: Date
  readonly expirationTime: Date
}

/**
 * Parses a SIWE message and extracts its fields.
 */
export function parseSiweMessage(message: string): ParsedSiweMessage {
  const lines = message.split('\n')
  const headerMatch = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? '')
  if (!headerMatch || !headerMatch[1]) {
    throw new RentalError('INVALID_SIGNATURE', 'Malformed SIWE message header', 400)
  }
  const domain = headerMatch[1].trim()

  const addressRaw = lines[1]?.trim() ?? ''
  if (!isAddress(addressRaw)) {
    throw new RentalError('INVALID_SIGNATURE', `Invalid address in message: "${addressRaw}"`, 400)
  }
  const address = getAddress(addressRaw)

  const findField = (prefix: string): string => {
    for (const line of lines) {
      if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
    }
    return ''
  }

  const uri = findField('URI:')
  const chainIdStr = findField('Chain ID:')
  const nonce = findField('Nonce:')
  const issuedAtStr = findField('Issued At:')
  const expirationTimeStr = findField('Expiration Time:')

  if (!uri || !chainIdStr || !nonce || !issuedAtStr || !expirationTimeStr) {
    throw new RentalError('INVALID_SIGNATURE', 'Missing mandatory SIWE message fields', 400)
  }

  const chainId = parseInt(chainIdStr, 10)
  if (isNaN(chainId)) {
    throw new RentalError('CHAIN_MISMATCH', `Invalid chain ID in message: "${chainIdStr}"`, 400)
  }

  const issuedAt = new Date(issuedAtStr)
  const expirationTime = new Date(expirationTimeStr)
  if (isNaN(issuedAt.getTime()) || isNaN(expirationTime.getTime())) {
    throw new RentalError('INVALID_SIGNATURE', 'Invalid timestamps in message', 400)
  }

  return {
    domain,
    address,
    statement: lines[3] ?? '',
    uri,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  }
}

export interface VerifyWalletSignatureOptions {
  readonly message: string
  readonly signature: Hex
  readonly expectedDomain: string
  readonly expectedChainId?: number
  readonly authStore: AuthStore
  readonly sessionDurationMs?: number
}

/**
 * Authoritatively verifies a signed SIWE authentication message.
 * Enforces single-use nonce consumption, domain match, chain ID match, timestamp bounds,
 * and cryptographic EC signature recovery.
 */
export async function verifyWalletAuthentication(
  options: VerifyWalletSignatureOptions,
): Promise<AuthSession> {
  const {
    message,
    signature,
    expectedDomain,
    expectedChainId = 97,
    authStore,
    sessionDurationMs = 2 * 60 * 60 * 1000, // 2 hours
  } = options

  const parsed = parseSiweMessage(message)

  // 1. Domain verification
  if (parsed.domain.toLowerCase() !== expectedDomain.toLowerCase()) {
    throw new RentalError(
      'DOMAIN_MISMATCH',
      `Domain mismatch: expected "${expectedDomain}", message specified "${parsed.domain}"`,
      400,
    )
  }

  // 2. Chain ID verification (must be 97 for BSC Testnet)
  if (parsed.chainId !== expectedChainId) {
    throw new RentalError(
      'CHAIN_MISMATCH',
      `Chain ID mismatch: expected ${expectedChainId}, message specified ${parsed.chainId}`,
      400,
    )
  }

  // 3. Timestamp validity
  const now = Date.now()
  if (parsed.expirationTime.getTime() <= now) {
    throw new RentalError('EXPIRED_NONCE', 'Authentication message has expired', 401)
  }
  // Clock tolerance: issuedAt cannot be in the distant future (> 2 minutes)
  if (parsed.issuedAt.getTime() > now + 120_000) {
    throw new RentalError('INVALID_SIGNATURE', 'Message issued in the future', 400)
  }

  // 4. Nonce single-use verification
  const consumed = await authStore.consumeNonce(parsed.nonce)
  if (!consumed) {
    throw new RentalError(
      'INVALID_NONCE',
      'Nonce is invalid, expired, or has already been used (replay detected)',
      401,
    )
  }

  // 5. Cryptographic signature verification using viem
  let isValid = false
  try {
    isValid = await verifyMessage({
      address: parsed.address,
      message,
      signature,
    })
  } catch (err) {
    throw new RentalError('INVALID_SIGNATURE', `Signature verification error: ${String(err)}`, 401)
  }

  if (!isValid) {
    throw new RentalError('INVALID_SIGNATURE', 'Signature is invalid for wallet address', 401)
  }

  // 6. Create short-lived secure session
  const sessionId = randomHex(24)
  const session: AuthSession = {
    sessionId,
    wallet: parsed.address,
    chainId: parsed.chainId,
    issuedAt: now,
    expiresAt: now + sessionDurationMs,
  }

  await authStore.saveSession(session)
  return session
}
