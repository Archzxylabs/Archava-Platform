import { createPublicClient, formatUnits, http, isAddress, type Address } from 'viem'
import { bscTestnet } from 'viem/chains'
import { ARCHAVA_RENTAL_V2_ABI } from './v2-abi.js'
import {
  AccessCheckUnavailableError,
  InvalidContractConfigError,
  RentalRpcError,
} from './errors.js'

export const RENTAL_V2_PACKAGES = [
  { packageId: 1, name: 'Starter', displayPriceIdr: 79_000, includedMinutes: 60, validityDays: 30 },
  { packageId: 2, name: 'Pro', displayPriceIdr: 299_000, includedMinutes: 300, validityDays: 30 },
] as const

export interface RentalV2ClientOptions {
  readonly rentalAddress: string | undefined
  readonly tokenAddress: string | undefined
  readonly rpcUrl: string | undefined
  readonly expectedChainId?: number
}

export class RentalV2Client {
  readonly rentalAddress: Address
  readonly contractAddress: Address
  readonly tokenAddress: Address
  readonly expectedChainId: number
  readonly publicClient

  constructor(options: RentalV2ClientOptions) {
    if (!options.rentalAddress || !isAddress(options.rentalAddress)) {
      throw new InvalidContractConfigError(
        'ARCHAVA_RENTAL_V2_CONTRACT_ADDRESS is missing or invalid.',
      )
    }
    if (!options.tokenAddress || !isAddress(options.tokenAddress)) {
      throw new InvalidContractConfigError(
        'ARCHAVA_MOCK_USDT_CONTRACT_ADDRESS is missing or invalid.',
      )
    }
    if (!options.rpcUrl?.trim()) {
      throw new InvalidContractConfigError('BSC_TESTNET_RPC_URL is missing.')
    }
    this.rentalAddress = options.rentalAddress
    this.contractAddress = options.rentalAddress
    this.tokenAddress = options.tokenAddress
    this.expectedChainId = options.expectedChainId ?? 97
    this.publicClient = createPublicClient({ chain: bscTestnet, transport: http(options.rpcUrl) })
  }

  async quoteRent(packageId: number): Promise<bigint> {
    try {
      return await this.publicClient.readContract({
        address: this.rentalAddress,
        abi: ARCHAVA_RENTAL_V2_ABI,
        functionName: 'quoteRent',
        args: [packageId],
      })
    } catch (error) {
      throw new RentalRpcError(`Unable to quote Rental V2 package ${packageId}`, error)
    }
  }

  async getPackages() {
    const packages = []
    for (const item of RENTAL_V2_PACKAGES) {
      const price = await this.quoteRent(item.packageId)
      packages.push({
        ...item,
        priceUnits: price.toString(),
        priceMusdt: formatUnits(price, 6),
      })
    }
    return packages
  }

  async getPackageQuotes() {
    return this.getPackages()
  }

  async expiresAt(wallet: string): Promise<bigint> {
    if (!isAddress(wallet)) throw new InvalidContractConfigError('Wallet address is malformed.')
    try {
      return await this.publicClient.readContract({
        address: this.rentalAddress,
        abi: ARCHAVA_RENTAL_V2_ABI,
        functionName: 'expiresAt',
        args: [wallet],
      })
    } catch (error) {
      throw new AccessCheckUnavailableError(
        `Unable to read Rental V2 expiry from BSC Testnet: ${String(error)}`,
      )
    }
  }

  async hasActiveAccess(wallet: string): Promise<boolean> {
    return (await this.expiresAt(wallet)) > BigInt(Math.floor(Date.now() / 1000))
  }

  async getIncludedMinutes(wallet: string): Promise<number> {
    if (!isAddress(wallet)) throw new InvalidContractConfigError('Wallet address is malformed.')
    try {
      const packageId = await this.publicClient.readContract({
        address: this.rentalAddress,
        abi: ARCHAVA_RENTAL_V2_ABI,
        functionName: 'activePackage',
        args: [wallet],
      })
      return RENTAL_V2_PACKAGES.find((item) => item.packageId === packageId)?.includedMinutes ?? 60
    } catch (error) {
      throw new AccessCheckUnavailableError(
        `Unable to read active Rental V2 package from BSC Testnet: ${String(error)}`,
      )
    }
  }
}

export function createRentalV2Client(options: RentalV2ClientOptions): RentalV2Client {
  return new RentalV2Client(options)
}
