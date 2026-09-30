import { describe, it, expect } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  InMemoryAuthStore,
  formatSiweMessage,
  parseSiweMessage,
  verifyWalletAuthentication,
} from '../src/auth.js'

describe('Wallet Authentication (SIWE-inspired)', () => {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const domain = 'archava.platform'
  const uri = 'https://archava.platform/login'

  it('formats and parses SIWE messages symmetrically', () => {
    const nonce = 'abc12345def67890'
    const issuedAt = new Date().toISOString()
    const expirationTime = new Date(Date.now() + 300_000).toISOString()

    const rawMessage = formatSiweMessage({
      domain,
      address: account.address,
      uri,
      chainId: 97,
      nonce,
      issuedAt,
      expirationTime,
    })

    const parsed = parseSiweMessage(rawMessage)
    expect(parsed.domain).toBe(domain)
    expect(parsed.address.toLowerCase()).toBe(account.address.toLowerCase())
    expect(parsed.chainId).toBe(97)
    expect(parsed.nonce).toBe(nonce)
    expect(parsed.uri).toBe(uri)
  })

  it('verifies a valid signature and creates a session', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const issuedAt = new Date().toISOString()
    const expirationTime = new Date(Date.now() + 300_000).toISOString()

    const message = formatSiweMessage({
      domain,
      address: account.address,
      uri,
      chainId: 97,
      nonce,
      issuedAt,
      expirationTime,
    })

    const signature = await account.signMessage({ message })

    const session = await verifyWalletAuthentication({
      message,
      signature,
      expectedDomain: domain,
      expectedChainId: 97,
      authStore,
    })

    expect(session.sessionId).toBeDefined()
    expect(session.wallet.toLowerCase()).toBe(account.address.toLowerCase())
    expect(session.chainId).toBe(97)

    // Verify session retrieval from authStore
    const retrieved = await authStore.getSession(session.sessionId)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.wallet.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('rejects replay attacks (single-use nonce consumed immediately)', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const message = formatSiweMessage({
      domain,
      address: account.address,
      uri,
      chainId: 97,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    })

    const signature = await account.signMessage({ message })

    // First attempt succeeds
    await verifyWalletAuthentication({
      message,
      signature,
      expectedDomain: domain,
      expectedChainId: 97,
      authStore,
    })

    // Second attempt with the same nonce MUST fail
    await expect(
      verifyWalletAuthentication({
        message,
        signature,
        expectedDomain: domain,
        expectedChainId: 97,
        authStore,
      }),
    ).rejects.toThrow('Nonce is invalid, expired, or has already been used')
  })

  it('rejects wrong domain', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const message = formatSiweMessage({
      domain: 'malicious-site.com',
      address: account.address,
      uri,
      chainId: 97,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    })

    const signature = await account.signMessage({ message })

    await expect(
      verifyWalletAuthentication({
        message,
        signature,
        expectedDomain: domain, // expects archava.platform
        expectedChainId: 97,
        authStore,
      }),
    ).rejects.toThrow('Domain mismatch')
  })

  it('rejects wrong chainId', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const message = formatSiweMessage({
      domain,
      address: account.address,
      uri,
      chainId: 1, // Mainnet instead of BSC Testnet 97
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    })

    const signature = await account.signMessage({ message })

    await expect(
      verifyWalletAuthentication({
        message,
        signature,
        expectedDomain: domain,
        expectedChainId: 97,
        authStore,
      }),
    ).rejects.toThrow('Chain ID mismatch')
  })

  it('rejects expired messages', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const message = formatSiweMessage({
      domain,
      address: account.address,
      uri,
      chainId: 97,
      nonce,
      issuedAt: new Date(Date.now() - 600_000).toISOString(),
      expirationTime: new Date(Date.now() - 100_000).toISOString(), // expired in past
    })

    const signature = await account.signMessage({ message })

    await expect(
      verifyWalletAuthentication({
        message,
        signature,
        expectedDomain: domain,
        expectedChainId: 97,
        authStore,
      }),
    ).rejects.toThrow('Authentication message has expired')
  })

  it('rejects signatures from different addresses', async () => {
    const authStore = new InMemoryAuthStore()
    const nonce = await authStore.createNonce()

    const otherAccount = privateKeyToAccount(generatePrivateKey())

    const message = formatSiweMessage({
      domain,
      address: account.address, // claims to be account
      uri,
      chainId: 97,
      nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    })

    // Signed by otherAccount
    const signature = await otherAccount.signMessage({ message })

    await expect(
      verifyWalletAuthentication({
        message,
        signature,
        expectedDomain: domain,
        expectedChainId: 97,
        authStore,
      }),
    ).rejects.toThrow('Signature is invalid for wallet address')
  })
})
