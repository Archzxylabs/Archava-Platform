export type RentalErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_SIGNATURE'
  | 'INVALID_NONCE'
  | 'EXPIRED_NONCE'
  | 'CHAIN_MISMATCH'
  | 'DOMAIN_MISMATCH'
  | 'ADDRESS_MISMATCH'
  | 'ACCESS_EXPIRED'
  | 'ACCESS_CHECK_UNAVAILABLE'
  | 'SESSION_LIMIT_REACHED'
  | 'USAGE_LIMIT_REACHED'
  | 'INVALID_CONTRACT_CONFIG'
  | 'RPC_ERROR'

export class RentalError extends Error {
  readonly code: RentalErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    code: RentalErrorCode,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RentalError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export class AuthRequiredError extends RentalError {
  constructor(message = 'Wallet authentication required') {
    super('AUTH_REQUIRED', message, 401)
  }
}

export class AccessExpiredError extends RentalError {
  constructor(message = 'Rental access has expired. Please rent a new package on BSC Testnet.') {
    super('ACCESS_EXPIRED', message, 403)
  }
}

export class AccessCheckUnavailableError extends RentalError {
  constructor(
    message = 'Unable to verify rental access on BSC Testnet. System is failing closed.',
  ) {
    super('ACCESS_CHECK_UNAVAILABLE', message, 503)
  }
}

export class SessionLimitReachedError extends RentalError {
  constructor(
    message = 'Concurrent session limit reached for this wallet (maximum 1 active session).',
  ) {
    super('SESSION_LIMIT_REACHED', message, 429)
  }
}

export class UsageLimitReachedError extends RentalError {
  constructor(message = 'Minute quota limit reached for the current rental package.') {
    super('USAGE_LIMIT_REACHED', message, 429)
  }
}

export class InvalidContractConfigError extends RentalError {
  constructor(message: string) {
    super('INVALID_CONTRACT_CONFIG', message, 500)
  }
}

function formatErrorCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  if (typeof cause === 'number' || typeof cause === 'boolean' || typeof cause === 'bigint') {
    return String(cause)
  }
  try {
    return JSON.stringify(cause) ?? 'unknown error'
  } catch {
    return 'unstringifiable error'
  }
}

export class RentalRpcError extends RentalError {
  constructor(message: string, cause?: unknown) {
    super(
      'RPC_ERROR',
      message,
      502,
      cause !== undefined ? { cause: formatErrorCause(cause) } : undefined,
    )
  }
}
