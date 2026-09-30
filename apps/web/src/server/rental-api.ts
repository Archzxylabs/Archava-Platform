import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAddress, type Address } from 'viem'
import {
  InMemoryAuthStore,
  InMemoryEntitlementStore,
  EntitlementManager,
  createRentalV2Client,
  verifyWalletAuthentication,
  RentalError,
  type AuthStore,
  type EntitlementStore,
  type RentalV2Client,
  type Hex,
} from '@archava/rental'

const MAX_BODY_BYTES = 1 << 20 // 1 MiB

// =============================================================================
// Rental & Auth Singletons
// =============================================================================

export function resolveRentalContractAddress(value: string | undefined): Address {
  if (!value || !isAddress(value)) {
    throw new RentalError(
      'ACCESS_CHECK_UNAVAILABLE',
      'ARCHAVA_RENTAL_V2_CONTRACT_ADDRESS is missing or invalid; onchain access checks are unavailable.',
      503,
    )
  }
  return value
}

let contractAddress: Address | null = null
try {
  contractAddress = resolveRentalContractAddress(process.env['ARCHAVA_RENTAL_V2_CONTRACT_ADDRESS'])
} catch {
  // The free landing-page demo remains available. Onchain routes fail closed below.
}
export const expectedChainId = Number(process.env['ARCHAVA_CHAIN_ID'] ?? 97)

export const authStore: AuthStore = new InMemoryAuthStore()
export const entitlementStore: EntitlementStore = new InMemoryEntitlementStore()

function createConfiguredRentalClient(): RentalV2Client | null {
  if (!contractAddress) return null
  try {
    return createRentalV2Client({
      rentalAddress: contractAddress,
      tokenAddress: process.env['ARCHAVA_MOCK_USDT_CONTRACT_ADDRESS'],
      expectedChainId,
      rpcUrl: process.env['BSC_TESTNET_RPC_URL'],
    })
  } catch {
    // Missing/malformed token or RPC config disables onchain endpoints only.
    return null
  }
}

export let rentalClient: RentalV2Client | null = createConfiguredRentalClient()

export let entitlementManager: EntitlementManager | null = rentalClient
  ? new EntitlementManager({
      rentalClient,
      store: entitlementStore,
      leaseTimeoutMs: 60_000,
    })
  : null

/**
 * Allows injecting or replacing client (e.g. for testing).
 */
export function setRentalClient(client: RentalV2Client): void {
  rentalClient = client
  entitlementManager = new EntitlementManager({
    rentalClient,
    store: entitlementStore,
    leaseTimeoutMs: 60_000,
  })
}

function requireRentalClient(): RentalV2Client {
  if (!rentalClient) {
    throw new RentalError(
      'ACCESS_CHECK_UNAVAILABLE',
      'Rental contract is not configured; set ARCHAVA_RENTAL_V2_CONTRACT_ADDRESS and ARCHAVA_MOCK_USDT_CONTRACT_ADDRESS.',
      503,
    )
  }
  return rentalClient
}

function requireEntitlementManager(): EntitlementManager {
  if (!entitlementManager) {
    throw new RentalError(
      'ACCESS_CHECK_UNAVAILABLE',
      'Rental entitlement service is unavailable because the contract is not configured.',
      503,
    )
  }
  return entitlementManager
}

// =============================================================================
// Helper Functions
// =============================================================================

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) {
          resolve({} as T)
          return
        }
        resolve(JSON.parse(raw) as T)
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${String(err)}`))
      }
    })

    request.on('error', reject)
  })
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

export function getSessionId(request: IncomingMessage): string | null {
  const authHeader = request.headers['authorization']
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  const cookieHeader = request.headers['cookie']
  if (cookieHeader) {
    const match = /(?:^|;\s*)archava_session=([^;]+)/.exec(cookieHeader)
    if (match && match[1]) return decodeURIComponent(match[1])
  }
  return null
}

// =============================================================================
// API Handlers
// =============================================================================

/**
 * POST /api/auth/nonce
 * Issues a single-use random nonce for SIWE login.
 */
export async function handleAuthNonce(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: { message: 'POST only' } })
    return
  }

  const nonce = await authStore.createNonce(300) // 5 minutes TTL
  respondJson(response, 200, { nonce })
}

/**
 * POST /api/auth/verify
 * Verifies signed SIWE message, enforces single-use nonce, creates session.
 */
export async function handleAuthVerify(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: { message: 'POST only' } })
    return
  }

  let body: { message?: string; signature?: string; domain?: string }
  try {
    body = await readJsonBody(request)
  } catch (err) {
    respondJson(response, 400, { error: { message: String(err) } })
    return
  }

  if (!body.message || !body.signature) {
    respondJson(response, 400, {
      error: { message: 'Missing "message" or "signature" in request body' },
    })
    return
  }

  const hostHeader = request.headers['host'] ?? 'localhost'
  const expectedDomain = body.domain ?? hostHeader.split(':')[0] ?? 'localhost'

  try {
    const session = await verifyWalletAuthentication({
      message: body.message,
      signature: body.signature as Hex,
      expectedDomain,
      expectedChainId,
      authStore,
    })

    // Set cookie and return session
    response.setHeader(
      'Set-Cookie',
      `archava_session=${encodeURIComponent(session.sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`,
    )

    respondJson(response, 200, {
      session: {
        sessionId: session.sessionId,
        wallet: session.wallet,
        chainId: session.chainId,
        expiresAt: session.expiresAt,
      },
    })
  } catch (err) {
    if (err instanceof RentalError) {
      respondJson(response, err.status, {
        error: { code: err.code, message: err.message },
      })
      return
    }
    respondJson(response, 400, {
      error: { code: 'INVALID_SIGNATURE', message: String(err) },
    })
  }
}

/**
 * GET /api/auth/session
 * Returns current authenticated wallet session or null.
 */
export async function handleAuthSession(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const sessionId = getSessionId(request)
  if (!sessionId) {
    respondJson(response, 200, { authenticated: false })
    return
  }

  const session = await authStore.getSession(sessionId)
  if (!session) {
    respondJson(response, 200, { authenticated: false })
    return
  }

  respondJson(response, 200, {
    authenticated: true,
    session: {
      sessionId: session.sessionId,
      wallet: session.wallet,
      chainId: session.chainId,
      expiresAt: session.expiresAt,
    },
  })
}

/**
 * POST /api/auth/logout
 * Destroys current session.
 */
export async function handleAuthLogout(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const sessionId = getSessionId(request)
  if (sessionId) {
    await authStore.destroySession(sessionId)
  }

  response.setHeader('Set-Cookie', 'archava_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  respondJson(response, 200, { ok: true })
}

/**
 * GET /api/rental/packages
 * Returns supported demo packages with onchain quotes.
 */
export async function handleRentalPackages(
  _request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const client = requireRentalClient()
    const packages = await client.getPackageQuotes()
    respondJson(response, 200, {
      chainId: expectedChainId,
      contractAddress: client.contractAddress,
      tokenAddress: client.tokenAddress,
      paymentToken: 'Mock USDT (mUSDT, testnet only)',
      packages,
    })
  } catch (err) {
    const error = err instanceof RentalError ? err : null
    respondJson(response, error?.status ?? 502, {
      error: {
        code: error?.code ?? 'RPC_ERROR',
        message: error?.message ?? `Failed to fetch rental quotes from BSC Testnet: ${String(err)}`,
      },
    })
  }
}

/**
 * GET /api/rental/status?wallet=0x...
 * Authoritatively reads rental access expiry for a wallet from the BSC smart contract.
 */
export async function handleRentalStatus(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  let targetWallet = url.searchParams.get('wallet')

  if (!targetWallet) {
    // Try to get from session
    const sessionId = getSessionId(request)
    if (sessionId) {
      const session = await authStore.getSession(sessionId)
      if (session) targetWallet = session.wallet
    }
  }

  if (!targetWallet) {
    respondJson(response, 400, {
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Missing "wallet" query param and no session found',
      },
    })
    return
  }

  try {
    const client = requireRentalClient()
    const expiryBigInt = await client.expiresAt(targetWallet)
    const expirySec = Number(expiryBigInt)
    const nowSec = Math.floor(Date.now() / 1000)
    const hasActiveAccess = expirySec > nowSec

    respondJson(response, 200, {
      wallet: targetWallet,
      contractAddress: client.contractAddress,
      chainId: expectedChainId,
      expiresAt: expirySec,
      expiresAtIso: expirySec > 0 ? new Date(expirySec * 1000).toISOString() : null,
      hasActiveAccess,
      secondsRemaining: Math.max(0, expirySec - nowSec),
    })
  } catch (err) {
    if (err instanceof RentalError) {
      respondJson(response, err.status, {
        error: { code: err.code, message: err.message },
      })
      return
    }
    respondJson(response, 503, {
      error: {
        code: 'ACCESS_CHECK_UNAVAILABLE',
        message: `Failed to verify onchain rental access: ${String(err)}`,
      },
    })
  }
}

/**
 * POST /api/archava/session
 * PROTECTED ROUTE: Requires wallet auth + active onchain rental + concurrency lease.
 * Fails closed on RPC errors, expired rental, or concurrent limit reached.
 * Issues short-lived session capability without exposing provider credentials.
 */
export async function handleArchavaSessionStart(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: { message: 'POST only' } })
    return
  }

  // 1. Session authentication check (Never accept wallet from body/headers!)
  const sessionId = getSessionId(request)
  if (!sessionId) {
    respondJson(response, 401, {
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Sign in with your BSC wallet to start an Archava session.',
      },
    })
    return
  }

  const session = await authStore.getSession(sessionId)
  if (!session) {
    respondJson(response, 401, {
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Session expired or invalid. Please sign in again.',
      },
    })
    return
  }

  let body: { sessionType?: string } = {}
  try {
    body = await readJsonBody(request)
  } catch {
    // empty body ok
  }

  // 2. Entitlement verification & lease acquisition
  try {
    const capability = await requireEntitlementManager().acquireSessionCapability(
      session.wallet,
      body.sessionType ?? 'archava-experience',
    )

    respondJson(response, 200, {
      success: true,
      capability: {
        capabilityToken: capability.capabilityToken,
        leaseId: capability.leaseId,
        wallet: capability.wallet,
        sessionType: capability.sessionType,
        expiresAt: capability.expiresAt,
        remainingMinutes: capability.remainingMinutes,
      },
      // Provider credentials remain strictly server-side:
      orchestration: {
        mode: 'managed-stream',
        realtimeEndpoint: '/api/archava/stream',
        heartbeatIntervalMs: 25_000,
      },
    })
  } catch (err) {
    if (err instanceof RentalError) {
      respondJson(response, err.status, {
        error: { code: err.code, message: err.message },
      })
      return
    }
    respondJson(response, 500, {
      error: { code: 'ACCESS_CHECK_UNAVAILABLE', message: String(err) },
    })
  }
}

/**
 * POST /api/archava/session/heartbeat
 * Heartbeat to maintain session lease and meter consumed minutes.
 */
export async function handleArchavaSessionHeartbeat(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: { message: 'POST only' } })
    return
  }

  let body: { leaseId?: string; elapsedSeconds?: number }
  try {
    body = await readJsonBody(request)
  } catch (err) {
    respondJson(response, 400, { error: { message: String(err) } })
    return
  }

  if (!body.leaseId) {
    respondJson(response, 400, { error: { message: 'Missing leaseId' } })
    return
  }

  try {
    const result = await requireEntitlementManager().heartbeatSession(
      body.leaseId,
      body.elapsedSeconds ?? 25,
    )
    respondJson(response, 200, result)
  } catch (err) {
    if (err instanceof RentalError) {
      respondJson(response, err.status, {
        error: { code: err.code, message: err.message },
      })
      return
    }
    respondJson(response, 400, { error: { message: String(err) } })
  }
}

/**
 * POST /api/archava/session/end
 * Releases session lease idempotently.
 */
export async function handleArchavaSessionEnd(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: { message: 'POST only' } })
    return
  }

  let body: { leaseId?: string }
  try {
    body = await readJsonBody(request)
  } catch (err) {
    respondJson(response, 400, { error: { message: String(err) } })
    return
  }

  if (body.leaseId) {
    await requireEntitlementManager().endSession(body.leaseId)
  }

  respondJson(response, 200, { ok: true })
}
