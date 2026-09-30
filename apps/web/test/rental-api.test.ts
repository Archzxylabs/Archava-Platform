import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createRentalV2Client, formatSiweMessage } from '@archava/rental'
import {
  handleAuthNonce,
  handleAuthVerify,
  handleAuthSession,
  handleAuthLogout,
  handleRentalPackages,
  handleRentalStatus,
  handleArchavaSessionStart,
  handleArchavaSessionHeartbeat,
  handleArchavaSessionEnd,
  rentalClient,
  setRentalClient,
} from '../src/server/rental-api.js'

describe('Rental API Integration Tests', () => {
  let server: Server
  let baseUrl: string
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  beforeAll(async () => {
    setRentalClient(
      createRentalV2Client({
        rentalAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        expectedChainId: 97,
        rpcUrl: 'http://127.0.0.1:1',
      }),
    )
    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        if (url.pathname === '/api/auth/nonce') return handleAuthNonce(req, res)
        if (url.pathname === '/api/auth/verify') return handleAuthVerify(req, res)
        if (url.pathname === '/api/auth/session') return handleAuthSession(req, res)
        if (url.pathname === '/api/auth/logout') return handleAuthLogout(req, res)
        if (url.pathname === '/api/rental/packages') return handleRentalPackages(req, res)
        if (url.pathname === '/api/rental/status') return handleRentalStatus(req, res, url)
        if (url.pathname === '/api/archava/session') return handleArchavaSessionStart(req, res)
        if (url.pathname === '/api/archava/session/heartbeat')
          return handleArchavaSessionHeartbeat(req, res)
        if (url.pathname === '/api/archava/session/end') return handleArchavaSessionEnd(req, res)

        res.statusCode = 404
        res.end('Not found')
      })()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address()
    if (typeof address === 'object' && address !== null) {
      baseUrl = `http://127.0.0.1:${address.port}`
    } else {
      throw new Error('Failed to bind test server')
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  let sessionCookie = ''

  function configuredRentalClient() {
    if (!rentalClient) throw new Error('Expected rental client to be configured for test')
    return rentalClient
  }

  it('POST /api/auth/nonce generates a single-use nonce', async () => {
    const res = await fetch(`${baseUrl}/api/auth/nonce`, { method: 'POST' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { nonce: string }
    expect(json.nonce).toBeDefined()
    expect(json.nonce.length).toBeGreaterThan(10)
  })

  it('POST /api/auth/verify signs in with wallet and creates a session', async () => {
    // 1. Get nonce
    const nonceRes = await fetch(`${baseUrl}/api/auth/nonce`, { method: 'POST' })
    const { nonce } = (await nonceRes.json()) as { nonce: string }

    const domain = '127.0.0.1'
    const issuedAt = new Date().toISOString()
    const expirationTime = new Date(Date.now() + 300_000).toISOString()

    const message = formatSiweMessage({
      domain,
      address: account.address,
      uri: `${baseUrl}/`,
      chainId: 97,
      nonce,
      issuedAt,
      expirationTime,
    })

    const signature = await account.signMessage({ message })

    const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature, domain }),
    })

    expect(verifyRes.status).toBe(200)
    const setCookie = verifyRes.headers.get('set-cookie')
    expect(setCookie).toContain('archava_session=')
    sessionCookie = setCookie ?? ''

    const json = (await verifyRes.json()) as { session: { wallet: string; chainId: number } }
    expect(json.session.wallet.toLowerCase()).toBe(account.address.toLowerCase())
    expect(json.session.chainId).toBe(97)
  })

  it('GET /api/auth/session returns authenticated session when cookie is present', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: sessionCookie },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { authenticated: boolean; session?: { wallet: string } }
    expect(json.authenticated).toBe(true)
    expect(json.session?.wallet.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('GET /api/rental/packages returns demo packages', async () => {
    vi.spyOn(configuredRentalClient(), 'getPackageQuotes').mockResolvedValueOnce([
      {
        packageId: 1,
        name: 'Starter',
        displayPriceIdr: 79000,
        includedMinutes: 60,
        validityDays: 30,
        priceUnits: '4937500',
        priceMusdt: '4.9375',
      },
      {
        packageId: 2,
        name: 'Pro',
        displayPriceIdr: 299000,
        includedMinutes: 300,
        validityDays: 30,
        priceUnits: '18687500',
        priceMusdt: '18.6875',
      },
    ])

    const res = await fetch(`${baseUrl}/api/rental/packages`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { chainId: number; packages: readonly unknown[] }
    expect(json.chainId).toBe(97)
    expect(json.packages.length).toBe(2)
  })

  it('POST /api/archava/session fails with AUTH_REQUIRED if no session', async () => {
    const res = await fetch(`${baseUrl}/api/archava/session`, { method: 'POST' })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe('AUTH_REQUIRED')
  })

  it('POST /api/archava/session fails with ACCESS_EXPIRED if contract access is expired', async () => {
    // Mock rentalClient.hasActiveAccess -> false
    vi.spyOn(configuredRentalClient(), 'hasActiveAccess').mockResolvedValue(false)

    const res = await fetch(`${baseUrl}/api/archava/session`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
    })

    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: { code: string } }
    expect(json.error.code).toBe('ACCESS_EXPIRED')
  })

  it('POST /api/archava/session succeeds and acquires capability token when access is active', async () => {
    // Mock rentalClient.hasActiveAccess -> true
    vi.spyOn(configuredRentalClient(), 'hasActiveAccess').mockResolvedValue(true)
    vi.spyOn(configuredRentalClient(), 'getIncludedMinutes').mockResolvedValue(60)

    const res = await fetch(`${baseUrl}/api/archava/session`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionType: 'archava-demo' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      success: boolean
      capability: { capabilityToken: string; leaseId: string }
    }
    expect(json.success).toBe(true)
    expect(json.capability.capabilityToken).toMatch(/^archava_cap_/)

    const leaseId = json.capability.leaseId

    // Heartbeat
    const hbRes = await fetch(`${baseUrl}/api/archava/session/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId, elapsedSeconds: 10 }),
    })
    expect(hbRes.status).toBe(200)

    // Release lease
    const endRes = await fetch(`${baseUrl}/api/archava/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    })
    expect(endRes.status).toBe(200)
  })

  it('POST /api/auth/logout clears session', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: sessionCookie },
    })
    expect(res.status).toBe(200)

    // Verify session now reported as unauthenticated
    const checkRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: sessionCookie },
    })
    const json = (await checkRes.json()) as { authenticated: boolean }
    expect(json.authenticated).toBe(false)
  })
})
