/**
 * @archava/act-postmark — the Postmark adapter for the Act email outbox.
 *
 * Server-only, and importable from anywhere *because* it is server-only in the
 * safe direction: every credential is a constructor argument, so a module that
 * reads this file with no token to inject finds no credential here to leak, and
 * a browser bundle that somehow reached this entry would gain a class it cannot
 * construct rather than a secret it can send.
 *
 * It exports two ports and nothing else that matters:
 *
 * - {@link PostmarkEmailGateway} — the one thing that puts a message on the
 *   wire, owned by `EmailOutboxBoundary` so the at-most-once guarantee stays
 *   where it already lives. One send per call, no retry, no fallback.
 * - {@link PostmarkStatusPort} — the read that answers `unknown`, because a
 *   trustworthy positive-only recovery through Postmark's metadata search is
 *   not yet implemented or verified.
 *
 * The transport seam is exported too, so a deployment can replace the socket
 * layer without reaching inside the gateway, and so a test can run the whole
 * adapter with no network, no credential and no latency.
 */

export {
  POSTMARK_ATTEMPT_KEY,
  POSTMARK_SEND_TIMEOUT_MS,
  POSTMARK_SEND_URL,
  PostmarkEmailGateway,
  type PostmarkEmailGatewayOptions,
} from './gateway.js'

export {
  defaultPostmarkTransport,
  type PostmarkHTTPRequest,
  type PostmarkHTTPResponse,
  type PostmarkTransport,
} from './transport.js'

export {
  POSTMARK_STATUS_PORT_ID,
  PostmarkStatusPort,
  type PostmarkStatusPortOptions,
} from './status.js'
