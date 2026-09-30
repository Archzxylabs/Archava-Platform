import {
  createPublicClient,
  http,
  isAddress,
  formatEther,
  type PublicClient,
  type Address,
} from 'viem'
import { bscTestnet } from 'viem/chains'
import { ARCHAVA_RENTAL_ABI } from './abi.js'
import { DEMO_PACKAGES } from './packages.js'
import {
  InvalidContractConfigError,
  RentalRpcError,
  AccessCheckUnavailableError,
} from './errors.js'

export interface RentalClientOptions {
  readonly contractAddress: string
  readonly rpcUrl?: string
  readonly expectedChainId?: number
}

export interface PackageQuote {
  readonly duration: number
  readonly durationLabel: string
  readonly priceWei: string
  readonly priceBnb: string
  readonly includedMinutes: number
}

export class RentalClient {
  readonly contractAddress: Address
  readonly expectedChainId: number
  readonly publicClient: PublicClient

  constructor(options: RentalClientOptions) {
    if (!options.contractAddress || !isAddress(options.contractAddress)) {
      throw new InvalidContractConfigError(
        `Invalid contract address: "${options.contractAddress}". Must be a valid 20-byte EVM address.`,
      )
    }

    this.contractAddress = options.contractAddress
    this.expectedChainId = options.expectedChainId ?? 97

    const rpcUrl =
      options.rpcUrl ??
      process.env['BSC_TESTNET_RPC_URL'] ??
      'https://data-seed-prebsc-1-s1.binance.org:8545/'

    this.publicClient = createPublicClient({
      chain: bscTestnet,
      transport: http(rpcUrl, {
        timeout: 10_000,
        retryCount: 2,
      }),
    })
  }

  /**
   * Validates that the connected RPC network matches the expected chain ID (97 for BSC Testnet).
   * Fails closed on any error.
   */
  async validateNetwork(): Promise<number> {
    try {
      const chainId = await this.publicClient.getChainId()
      if (chainId !== this.expectedChainId) {
        throw new InvalidContractConfigError(
          `RPC network chainId mismatch: expected ${this.expectedChainId}, got ${chainId}.`,
        )
      }
      return chainId
    } catch (err) {
      if (err instanceof InvalidContractConfigError) throw err
      throw new RentalRpcError('Failed to query chainId from BSC RPC', err)
    }
  }

  /**
   * Quotes the rental price for a specific duration directly from the smart contract.
   */
  async quoteRent(durationSeconds: number | bigint): Promise<bigint> {
    try {
      const price = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: ARCHAVA_RENTAL_ABI,
        functionName: 'quoteRent',
        args: [BigInt(durationSeconds)],
      })
      return price
    } catch (err) {
      throw new RentalRpcError(
        `Failed to quote rental for duration ${durationSeconds}s from contract`,
        err,
      )
    }
  }

  /**
   * Returns the absolute expiration Unix timestamp (in seconds) for a given wallet.
   * Fails closed on invalid address or RPC error.
   */
  async expiresAt(wallet: string): Promise<bigint> {
    if (!isAddress(wallet)) {
      throw new InvalidContractConfigError(`Invalid wallet address: "${wallet}"`)
    }

    try {
      const expiry = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: ARCHAVA_RENTAL_ABI,
        functionName: 'expiresAt',
        args: [wallet],
      })
      return expiry
    } catch (err) {
      throw new AccessCheckUnavailableError(
        `Failed to read expiresAt(${wallet}) from contract: ${String(err)}`,
      )
    }
  }

  /**
   * Authoritative check: Returns true only if wallet's onchain expiry is strictly in the future.
   * Never trusts any client-provided claim. Fails closed on error.
   */
  async hasActiveAccess(wallet: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
    const expiry = await this.expiresAt(wallet)
    return expiry > BigInt(nowSec)
  }

  /**
   * Queries quotes for all canonical demo packages from the live contract.
   */
  async getPackageQuotes(): Promise<readonly PackageQuote[]> {
    const quotes: PackageQuote[] = []

    for (const pkg of DEMO_PACKAGES) {
      try {
        const price = await this.quoteRent(pkg.duration)
        quotes.push({
          duration: pkg.duration,
          durationLabel: pkg.durationLabel,
          priceWei: price.toString(),
          priceBnb: formatEther(price),
          includedMinutes: pkg.includedMinutes,
        })
      } catch {
        // If contract read fails for a package, use default package spec as fallback representation
        quotes.push({
          duration: pkg.duration,
          durationLabel: pkg.durationLabel,
          priceWei: '0',
          priceBnb: pkg.defaultPriceBnb,
          includedMinutes: pkg.includedMinutes,
        })
      }
    }

    return quotes
  }

  /**
   * Reads general status of the rental contract.
   */
  async getContractState(): Promise<{
    readonly address: string
    readonly chainId: number
    readonly paused: boolean
  }> {
    try {
      const paused = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: ARCHAVA_RENTAL_ABI,
        functionName: 'paused',
      })

      return {
        address: this.contractAddress,
        chainId: this.expectedChainId,
        paused,
      }
    } catch (err) {
      throw new RentalRpcError('Failed to read contract state', err)
    }
  }
}

export function createRentalClient(options: RentalClientOptions): RentalClient {
  return new RentalClient(options)
}
