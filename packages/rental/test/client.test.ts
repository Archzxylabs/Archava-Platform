import { describe, it, expect, vi } from 'vitest'
import { createRentalClient } from '../src/client.js'
import { InvalidContractConfigError, AccessCheckUnavailableError } from '../src/errors.js'

describe('RentalClient', () => {
  const dummyContractAddress = '0x1234567890123456789012345678901234567890'

  it('rejects invalid contract addresses', () => {
    expect(() => createRentalClient({ contractAddress: 'invalid-address' })).toThrow(
      InvalidContractConfigError,
    )
    expect(() => createRentalClient({ contractAddress: '' })).toThrow(InvalidContractConfigError)
  })

  it('initializes cleanly with valid contract address and defaults to chainId 97', () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })
    expect(client.contractAddress).toBe(dummyContractAddress)
    expect(client.expectedChainId).toBe(97)
  })

  it('fails closed when contract read fails', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })

    // Mock publicClient.readContract to simulate an RPC failure
    vi.spyOn(client.publicClient, 'readContract').mockRejectedValue(
      new Error('RPC connection timeout'),
    )

    await expect(client.expiresAt(dummyContractAddress)).rejects.toThrow(
      AccessCheckUnavailableError,
    )
  })

  it('correctly calculates hasActiveAccess based on timestamp strictly in the future', async () => {
    const client = createRentalClient({ contractAddress: dummyContractAddress })

    const nowSec = 1700000000

    // Future expiry -> true
    vi.spyOn(client.publicClient, 'readContract').mockResolvedValueOnce(BigInt(nowSec + 100))
    const isActive = await client.hasActiveAccess(dummyContractAddress, nowSec)
    expect(isActive).toBe(true)

    // Exact now expiry -> false (strictly greater)
    vi.spyOn(client.publicClient, 'readContract').mockResolvedValueOnce(BigInt(nowSec))
    const isExact = await client.hasActiveAccess(dummyContractAddress, nowSec)
    expect(isExact).toBe(false)

    // Past expiry -> false
    vi.spyOn(client.publicClient, 'readContract').mockResolvedValueOnce(BigInt(nowSec - 100))
    const isPast = await client.hasActiveAccess(dummyContractAddress, nowSec)
    expect(isPast).toBe(false)
  })
})
