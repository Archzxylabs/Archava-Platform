/**
 * The one network boundary, injected.
 *
 * This module owns `fetch` and nothing else in the package does. That is not a
 * style preference — it is what lets every test here run against a fake with no
 * network, no key and no latency, and what lets a deployment swap the socket
 * layer without the gateway knowing.
 *
 * The seam is a whole request rather than a `fetch` reference, for the reason
 * `packages/adapters/src/jev-decision.ts` already states: a `fetch` seam would
 * let a mock quietly defeat the timeout the gateway owns.
 *
 * **Server-only.** A default transport that reaches `api.postmarkapp.com` and a
 * server token that authenticates to it cannot both live in a browser bundle,
 * and the credential being injected rather than read from the environment is
 * what keeps this module importable by anywhere that has no credential to
 * import it *with*.
 */
/** One request, as the gateway hands it to a transport. */
export interface PostmarkHTTPRequest {
  readonly url: string
  /** Header names are lower-case so a fake comparing them sees one spelling. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal?: AbortSignal
}

/**
 * One reply, read already.
 *
 * The body is a string rather than a stream on purpose: a stream left unread
 * pins a socket, and a body read twice is a bug. Reading it inside the seam
 * leaves the gateway above holding a plain value and the transport free.
 */
export interface PostmarkHTTPResponse {
  readonly status: number
  readonly body: string
}

/** The boundary every outbound request crosses. */
export interface PostmarkTransport {
  post(request: PostmarkHTTPRequest): Promise<PostmarkHTTPResponse>
}

/**
 * A transport failure. Thrown only ever with this fixed message.
 *
 * A native network error's message can carry the request — the URL, the proxy
 * host, occasionally a header dump — and this package does not relay it, so the
 * response is replaced rather than re-wrapped. A gateway maps any throw to
 * `unknown`, which is the honest answer for a request whose fate is unknown.
 */
class PostmarkTransportFailure extends Error {
  constructor() {
    super('the request to the mail provider did not complete')
    this.name = 'PostmarkTransportFailure'
  }
}

/**
 * The `fetch` transport. Global as its default, so nothing is captured at
 * module scope and a test never has to stub one.
 */
export function defaultPostmarkTransport(
  fetchImpl: typeof fetch = globalThis.fetch,
): PostmarkTransport {
  return {
    post: async (request: PostmarkHTTPRequest): Promise<PostmarkHTTPResponse> => {
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch {
        throw new PostmarkTransportFailure()
      }
      // Read inside the seam so a transport never hands back a live stream.
      return { status: response.status, body: await response.text() }
    },
  }
}
