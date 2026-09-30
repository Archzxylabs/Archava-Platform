import { describe, expect, it } from 'vitest'
import { RentalError } from '@archava/rental'
import { resolveRentalContractAddress } from '../src/server/rental-api.js'

function captureError(action: () => unknown): unknown {
  try {
    action()
    return null
  } catch (error) {
    return error
  }
}

describe('rental contract configuration', () => {
  it('fails closed when the contract address is missing', () => {
    const error = captureError(() => resolveRentalContractAddress(undefined))
    expect(error).toBeInstanceOf(RentalError)
    expect((error as RentalError).code).toBe('ACCESS_CHECK_UNAVAILABLE')
  })

  it('fails closed when the contract address is malformed', () => {
    const error = captureError(() => resolveRentalContractAddress('not-an-address'))
    expect(error).toBeInstanceOf(RentalError)
    expect((error as RentalError).code).toBe('ACCESS_CHECK_UNAVAILABLE')
  })

  it('accepts a valid EVM contract address', () => {
    expect(resolveRentalContractAddress('0x1111111111111111111111111111111111111111')).toBe(
      '0x1111111111111111111111111111111111111111',
    )
  })
})
