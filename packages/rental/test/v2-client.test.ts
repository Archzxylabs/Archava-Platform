import { describe, expect, it } from 'vitest'
import { createRentalV2Client } from '../src/v2-client.js'

const rentalAddress = '0x1111111111111111111111111111111111111111'
const tokenAddress = '0x2222222222222222222222222222222222222222'

describe('RentalV2Client configuration', () => {
  it('requires valid RentalV2 and MockUSDT addresses', () => {
    expect(() =>
      createRentalV2Client({
        rentalAddress: 'bad',
        tokenAddress,
        rpcUrl: 'https://rpc.example',
      }),
    ).toThrow(/RENTAL_V2_CONTRACT_ADDRESS/)

    expect(() =>
      createRentalV2Client({
        rentalAddress,
        tokenAddress: undefined,
        rpcUrl: 'https://rpc.example',
      }),
    ).toThrow(/MOCK_USDT_CONTRACT_ADDRESS/)
  })

  it('requires the BSC Testnet RPC endpoint', () => {
    expect(() => createRentalV2Client({ rentalAddress, tokenAddress, rpcUrl: undefined })).toThrow(
      /BSC_TESTNET_RPC_URL/,
    )
  })

  it('defaults to chain ID 97', () => {
    const client = createRentalV2Client({
      rentalAddress,
      tokenAddress,
      rpcUrl: 'https://rpc.example',
    })
    expect(client.expectedChainId).toBe(97)
    expect(client.contractAddress).toBe(rentalAddress)
  })
})
