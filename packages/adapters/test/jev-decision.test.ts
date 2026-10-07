import { describe, expect, it } from 'vitest'
import {
  JEV_API_KEY_ENV,
  JevDecisionProvider,
  type JevHTTPRequest,
  type JevHTTPResponse,
  type JevTransport,
} from '../src/jev-decision.js'
import { DecisionError, type DecisionRequest } from '../src/index.js'

/**
 * The Jev adapter, asserted against the frozen port rather than against a network.
 *
 * The whole suite runs offline. The credential is a piece of junk, the transport
 * is a function that returns text, and nothing here reaches `fetch` — the point
 * being that a provider which needs a live API key to be tested is a provider
 * that gets tested in production.
 *
 * Where the frozen port's own test asserts what a port *cannot* do, this one
 * asserts what this provider does with the network it is not given: every
 * failure it can distinguish, it distinguishes, and every failure it cannot, it
 * refuses rather than guesses.
 */

/**
 * A stand-in key. It is a literal because it must never be read from an
 * environment, and it is not a credential because nothing verifies it.
 */
const KEY = 'test-key-not-a-credential'

/** The response Jev documents: a resolved model, an answer map, token usage. */
function ok(answers: Record<string, unknown>, model = 'jev-1.13.0'): JevTransport {
  return withBody(JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 0 } }))
}

function withBody(body: string, status = 200): JevTransport {
  return { post: () => Promise.resolve({ status, body }) }
}

/** A transport that fails the way a real one does: it throws. */
function dead(): JevTransport {
  return {
    post: (): Promise<JevHTTPResponse> => {
      throw new Error('socket closed')
    },
  }
}

/** A transport that never resolves, the way a hung socket does. */
function hanging(): JevTransport {
  return { post: () => new Promise<JevHTTPResponse>(() => {}) }
}

function request(
  questions: DecisionRequest['questions'],
  utterance = 'how much is the deluxe suite for friday',
): DecisionRequest {
  return {
    tenantId: 'tenant-a',
    utterance,
    locale: 'en',
    evidence: { priceVisible: 1_438_000 },
    questions,
  }
}

/**
 * A transport that records what it was sent, so the body can be asserted.
 *
 * Capturing the request rather than the arguments of a spy keeps this to one
 * shape: a transport returns a response, and this one keeps a copy first.
 */
function recorder(
  answers: Record<string, unknown>,
): JevTransport & { readonly seen: JevHTTPRequest[] } {
  const transport = {
    seen: [] as JevHTTPRequest[],
    post: (http: JevHTTPRequest): Promise<JevHTTPResponse> => {
      transport.seen.push(http)
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ model: 'jev-1.13.0', answers }),
      })
    },
  }
  return transport
}

/**
 * A recorded body, read back as the shape it was sent in.
 *
 * `JSON.parse` is `any`, and a test that walks an `any` is a test that would
 * still pass if the field it read stopped existing. The cast is the one place
 * that assumption is stated, so each access below is checked.
 */
interface SentQuestion {
  readonly type: string
  readonly criteria?: readonly string[]
}

interface SentBody {
  readonly model: string
  readonly state: { readonly utterance: string; readonly evidence: unknown }
  readonly questions: Readonly<Record<string, SentQuestion | undefined>>
}

function sentBody(request: JevHTTPRequest | undefined): SentBody {
  return JSON.parse(request?.body ?? 'null') as SentBody
}

/**
 * A sent question, or a failure naming the id that was never sent.
 *
 * The record is read as optional because a body built from one question set
 * need not carry the id under test. Throwing keeps each assertion below a
 * plain property read, rather than a `?.` that would compare `undefined` to
 * `'choice'` and leave the reason a wrong shape was accepted unstated.
 */
function sentQuestion(id: string, request: JevHTTPRequest | undefined): SentQuestion {
  const sent = sentBody(request).questions[id]
  if (sent === undefined) throw new Error(`no question named ${id} was sent to the provider`)
  return sent
}

/** The score ladder sent for `id`, or a failure naming the id that had none. */
function sentLadder(id: string, request: JevHTTPRequest | undefined): readonly string[] {
  const ladder = sentQuestion(id, request).criteria
  if (ladder === undefined)
    throw new Error(`the question named ${id} was sent with no score ladder`)
  return ladder
}

/**
 * The readiness reason, out of a port that deliberately types `health` as
 * `unknown` — narrowed here rather than cast, because a health value that is not
 * an object with a string reason is a value worth noticing.
 */
function healthReason(health: unknown): string | null {
  if (typeof health !== 'object' || health === null || !('reason' in health)) return null
  const reason: unknown = (health as { readonly reason: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

describe('a provider that reads no environment', () => {
  it('takes the credential from its options, so an ordinary CI run needs no key', () => {
    // Not ready, rather than broken: the flag exists so a caller can ask before
    // it pays for a turn.
    expect(new JevDecisionProvider().health).toEqual({
      ready: false,
      reason: `no Jev credential: set ${JEV_API_KEY_ENV} in the server environment`,
    })
    expect(new JevDecisionProvider({ apiKey: '   ' }).health).toMatchObject({ ready: false })
  })

  it('names the real variable when it explains itself', () => {
    expect(healthReason(new JevDecisionProvider().health)).toContain(JEV_API_KEY_ENV)
  })

  it('is ready the moment it is given one', () => {
    expect(new JevDecisionProvider({ apiKey: KEY }).health).toEqual({ ready: true, reason: null })
  })

  it('refuses to be built with a configuration it could never send', () => {
    // Each of these is a request that can only ever come back 422 or never come
    // back, and both are worth discovering once per deploy at construction
    // rather than once per turn in production.
    expect(() => new JevDecisionProvider({ apiKey: KEY, model: '  ' })).toThrow(DecisionError)
    expect(() => new JevDecisionProvider({ apiKey: KEY, endpoint: ' ' })).toThrow(DecisionError)
    expect(() => new JevDecisionProvider({ apiKey: KEY, endpoint: 'not a url' })).toThrow(
      DecisionError,
    )
    expect(() => new JevDecisionProvider({ apiKey: KEY, timeoutMs: 0 })).toThrow(DecisionError)
    expect(() => new JevDecisionProvider({ apiKey: KEY, timeoutMs: -1 })).toThrow(DecisionError)
    expect(() => new JevDecisionProvider({ apiKey: KEY, timeoutMs: Number.NaN })).toThrow(
      DecisionError,
    )
  })

  it('throws a DecisionError from decide() rather than a refusal, because a missing key is misconfiguration', async () => {
    // The port's own distinction: "could not answer" is a refusal with a reason,
    // and "cannot serve" is a throw. A missing credential is the second, and
    // silently answering it would be the first.
    const provider = new JevDecisionProvider({ transport: ok({}) })
    await expect(
      provider.decide(request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }])),
    ).rejects.toThrow(DecisionError)
  })
})

describe('the credential, and where it goes', () => {
  it('sends the key as a bearer header, and only as a bearer header', async () => {
    const transport = recorder({ x: { type: 'noul', noul: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    await provider.decide(request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]))

    // The header is the only place the key appears. It is not in the URL, which
    // would put it in an access log, and not in the body, which would put it in
    // a request bin.
    expect(transport.seen[0]?.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    })
    expect(transport.seen[0]?.url).not.toContain(KEY)
  })

  it('sends it to the documented endpoint, over https', async () => {
    const transport = recorder({ x: { type: 'noul', noul: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    await provider.decide(request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]))

    expect(transport.seen[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('will not send a credential anywhere but https or loopback', () => {
    // The one string in this file a credential is sent to, guarded at the door.
    for (const endpoint of ['http://api.typesafe.ai/v1/systemone', 'http://example.com']) {
      expect(() => new JevDecisionProvider({ apiKey: KEY, endpoint })).toThrow(/credential/)
    }
    // Loopback is the escape hatch a local proxy needs, and it is not a leak.
    expect(
      () => new JevDecisionProvider({ apiKey: KEY, endpoint: 'http://127.0.0.1:8787' }),
    ).not.toThrow()
  })
})

describe('what it asks, and in whose words', () => {
  it('asks every question in one call, keyed by the id the task registry owns', async () => {
    const transport = recorder({
      bookable: { type: 'noul', noul: 0.8 },
      date: {
        type: 'choice',
        choice: 'fri',
        probabilities: { fri: 0.9, sat: 0.1 },
        confidence: 0.8,
      },
      strength: {
        type: 'score',
        score: 2,
        probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
        confidence: 0.7,
      },
    })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    const result = await provider.decide(
      request([
        { id: 'bookable', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'date', kind: 'choice', prompt: 'Which date?', options: ['fri', 'sat'] },
        { id: 'strength', kind: 'score', prompt: 'How strong?', bounds: [0, 2] },
      ]),
    )

    const body = sentBody(transport.seen[0])
    expect(Object.keys(body.questions).sort()).toEqual(['bookable', 'date', 'strength'])
    // Jev documents noul, choice and score as mixable in one request, which is
    // what makes a single call legitimate rather than three.
    expect(sentQuestion('date', transport.seen[0]).type).toBe('choice')
    expect(sentQuestion('strength', transport.seen[0]).type).toBe('score')
    expect(sentQuestion('bookable', transport.seen[0]).type).toBe('noul')
    expect(result.decisions).toHaveLength(3)
    expect(result.refused).toEqual([])
  })

  it('carries the situation, not the tenant', async () => {
    const transport = recorder({ x: { type: 'noul', noul: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    await provider.decide(request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]))

    const body = sentBody(transport.seen[0])
    expect(body.state).toEqual({
      utterance: 'how much is the deluxe suite for friday',
      locale: 'en',
      evidence: { priceVisible: 1_438_000 },
    })
    // The tenant identifier is the platform's, not the provider's: the endpoint
    // documents no use for it, so sending it would be exposure in exchange for
    // nothing.
    expect(JSON.stringify(body)).not.toContain('tenant-a')
  })

  it('reports the configured model identity expected by the decision orchestrator', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'noul', noul: 0.9 } }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    // The generic orchestrator checks this identity. The resolved version needs
    // its own metadata field before it can be retained without a false mismatch.
    expect(provider.model).toBe('jev-latest')
    expect(result.model).toBe('jev-latest')
  })
})

describe('a question this provider cannot ask Jev', () => {
  it('refuses a choice above Jev’s documented ceiling without sending it', async () => {
    const transport = recorder({})
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })

    const options = Array.from({ length: 256 }, (_, index) => `option-${index}`)
    const result = await provider.decide(
      request([{ id: 'x', kind: 'choice', prompt: 'Which one?', options }]),
    )

    // Nothing was sent, because the only thing a 256-option question earns is an
    // error — and a question that can only produce an error is a question worth
    // refusing locally.
    expect(transport.seen).toHaveLength(0)
    expect(result.refused).toEqual([
      { id: 'x', reason: 'a choice question here accepts at most 255 options' },
    ])
  })

  it('refuses the duplicate id that Jev’s answer map would silently collapse', async () => {
    const transport = recorder({ x: { type: 'noul', noul: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })

    const question = { id: 'x', kind: 'boolean', prompt: 'Is this a question?' } as const
    const result = await provider.decide(
      request([question, { ...question, prompt: 'the same question twice' }]),
    )

    // Two questions with one id is one question over the wire, and the answer
    // comes back under one key. Refusing both keeps that visible: the caller
    // asked two questions, so it gets two refusals, and a zip of questions to
    // outcomes still lines up.
    expect(transport.seen).toHaveLength(0)
    expect(result.refused).toEqual([
      { id: 'x', reason: 'the request asked this question id more than once' },
      { id: 'x', reason: 'the request asked this question id more than once' },
    ])
  })

  it('refuses a one-point score, because Jev has no scale with one level', async () => {
    const transport = recorder({})
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'score', prompt: 'How strong?', bounds: [1, 1] }]),
    )

    expect(transport.seen).toHaveLength(0)
    expect(result.refused).toHaveLength(1)
  })

  it('refuses only the question that cannot be asked, and still sends the rest', async () => {
    const transport = recorder({
      real: { type: 'noul', noul: 0.9 },
      wide: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 },
    })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })

    const result = await provider.decide(
      request([
        { id: 'real', kind: 'boolean', prompt: 'Is this a question?' },
        { id: 'degenerate', kind: 'score', prompt: 'How strong?', bounds: [1, 1] },
        { id: 'wide', kind: 'choice', prompt: 'Which one?', options: ['a'] },
      ]),
    )

    // One turn, one call, and one question that never went anywhere. A refusal
    // that took its neighbours with it would cost three answers for one bad
    // question.
    expect(transport.seen).toHaveLength(1)
    expect(Object.keys(sentBody(transport.seen[0]).questions).sort()).toEqual(['real', 'wide'])
    expect(result.refused.map((entry) => entry.id)).toEqual(['degenerate'])
    expect(result.decisions.map((entry) => entry.id).sort()).toEqual(['real', 'wide'])
  })
})

describe('how a bounded score becomes Jev levels', () => {
  it('asks 1-to-5 as the numbers 1 to 5', async () => {
    const transport = recorder({ x: { type: 'score', score: 2, confidence: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    await provider.decide(request([{ id: 'x', kind: 'score', prompt: 'Rate it', bounds: [1, 5] }]))

    expect(sentLadder('x', transport.seen[0])).toEqual(['1', '2', '3', '4', '5'])
  })

  it('asks a fractional range as ten evenly spaced anchors, labelled to read', async () => {
    const transport = recorder({ x: { type: 'score', score: 4, confidence: 0.9 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    // 1 to 1.5 cannot be a ladder of whole numbers, so it becomes anchors.
    const result = await provider.decide(
      request([{ id: 'x', kind: 'score', prompt: 'How strong?', bounds: [1, 1.5] }]),
    )
    expect(result.decisions).toHaveLength(1)

    const criteria = sentLadder('x', transport.seen[0])
    expect(criteria).toHaveLength(10)
    expect(criteria[0]).toBe('1')
    expect(criteria[9]).toBe('1.5')
    // A label is text the model reads, so a float that reads as noise is a label
    // that has been spent.
    for (const anchor of criteria) expect(String(anchor)).not.toMatch(/0{8,}\d$/)
  })

  it('maps a fractional level index back inside the bounds, and never outside', async () => {
    const transport = recorder({ x: { type: 'score', score: 2.5, confidence: 0.6 } })
    const provider = new JevDecisionProvider({ apiKey: KEY, transport })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'score', prompt: 'Rate it', bounds: [0, 10] }]),
    )

    // Jev's score is documented as the expected level index, fractional — so
    // what came back is a position on the ladder this provider sent, and the
    // response 4.5 can only be seven of the ten resolved: 2.5 of nine steps.
    // The question was about 0 to 10, so a 2.5 that slid out the far end is a
    // value that never existed, and the guard that stops that is the guard worth
    // having.
    expect(result.decisions).toEqual([
      { id: 'x', kind: 'score', answer: 2.7777777777777777, confidence: 0.6 },
    ])
  })

  it('holds the answer inside the question’s bounds at both ends', async () => {
    const low = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'score', score: 0, confidence: 1 } }),
    })
    const high = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'score', score: 4, confidence: 1 } }),
    })

    await expect(
      low.decide(request([{ id: 'x', kind: 'score', prompt: 'Rate it', bounds: [1, 5] }])),
    ).resolves.toMatchObject({
      decisions: [{ answer: 1 }],
    })
    await expect(
      high.decide(request([{ id: 'x', kind: 'score', prompt: 'Rate it', bounds: [1, 5] }])),
    ).resolves.toMatchObject({
      decisions: [{ answer: 5 }],
    })
  })
})

describe('how a noul becomes a boolean', () => {
  it('thresholds at the midpoint Jev itself defines, and derives a confidence from the same number', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({
        yes: { type: 'noul', noul: 0.9 },
        no: { type: 'noul', noul: 0.1 },
        coin: { type: 'noul', noul: 0.5 },
      }),
    })
    const result = await provider.decide(
      request([
        { id: 'yes', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'no', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'coin', kind: 'boolean', prompt: 'Is this a booking request?' },
      ]),
    )

    // The threshold is the caller's in the docs, and the caller here is the
    // number's own definition of ambiguous. The confidence is this adapter's
    // normalisation — Jev reports no noul confidence — and it is 0 exactly where
    // the model says it cannot choose, which is the honest place for it.
    expect(result.decisions).toEqual([
      { id: 'yes', kind: 'boolean', answer: true, confidence: 0.8 },
      { id: 'no', kind: 'boolean', answer: false, confidence: 0.8 },
      { id: 'coin', kind: 'boolean', answer: true, confidence: 0 },
    ])
  })

  it('refuses a noul outside the documented range instead of clamping it into an answer', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'noul', noul: 1.5 } }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    // 1.5 is not "a very confident yes", it is a number the contract does not
    // have. Clamping would turn a provider error into an answer.
    expect(result.decisions).toEqual([])
    expect(result.refused).toHaveLength(1)
  })
})

describe('how a choice becomes a choice', () => {
  it('takes the option the provider chose, and its confidence', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({
        x: {
          type: 'choice',
          choice: 'fri',
          probabilities: { fri: 0.9, sat: 0.1 },
          confidence: 0.8,
        },
      }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'choice', prompt: 'Which date?', options: ['fri', 'sat'] }]),
    )

    // The probabilities stay where they are. A second opinion about which option
    // was picked is not a source of confidence when one of them is the answer.
    expect(result.decisions).toEqual([{ id: 'x', kind: 'choice', answer: 'fri', confidence: 0.8 }])
  })

  it('refuses an option that was never offered', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'choice', choice: 'sunday', confidence: 0.99 } }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'choice', prompt: 'Which date?', options: ['fri', 'sat'] }]),
    )

    // Not nearest option, not first option. The answer set was closed when the
    // question was asked, and a provider answering outside it is answering a
    // different question.
    expect(result.decisions).toEqual([])
    expect(result.refused[0]?.reason).toMatch(/not one of the offered options/)
  })
})

describe('when the network is the problem', () => {
  it('refuses rather than guesses when the transport throws', async () => {
    const provider = new JevDecisionProvider({ apiKey: KEY, transport: dead() })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    // The port's worst outcome is a fabricated `false` — a consumer reads it as
    // an answer, silently. A refusal is the only alternative that stays visible.
    expect(result.decisions).toEqual([])
    expect(result.refused).toHaveLength(1)
  })

  it('keeps the vendor’s own reason for a documented status', async () => {
    // Jev documents these four; the refusal quotes the number so a log says which
    // one it was, because 401 and 429 need different fixes.
    for (const [status, expected] of [
      [401, /401/],
      [422, /422/],
      [429, /429/],
      [529, /529/],
    ] as const) {
      const provider = new JevDecisionProvider({
        apiKey: KEY,
        transport: withBody('{"message":"no"}', status),
      })
      const result = await provider.decide(
        request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
      )
      expect(result.refused[0]?.reason).toMatch(expected)
    }
  })

  it('names an undocumented status instead of claiming to understand it', async () => {
    const provider = new JevDecisionProvider({ apiKey: KEY, transport: withBody('{}', 500) })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    expect(result.refused[0]?.reason).toMatch(/HTTP 500/)
  })

  it('refuses the whole call when the body is not the documented shape', async () => {
    // A response without an answer map is a protocol this adapter only half
    // read, and half a protocol is not a thing to answer some of.
    for (const body of ['not json', '[]', 'null', '{"answers":{}}', '{"model":42,"answers":{}}']) {
      const provider = new JevDecisionProvider({ apiKey: KEY, transport: withBody(body) })
      const result = await provider.decide(
        request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
      )
      expect(result.decisions).toEqual([])
      expect(result.refused).toHaveLength(1)
    }
  })

  it('ignores an answer for a question it did not ask', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'noul', noul: 0.9 }, unasked: { type: 'noul', noul: 0.1 } }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    // The provider adding vocabulary is not this provider losing an answer, and
    // a `Decision` for it would carry an id the task registry does not own.
    expect(result.decisions.map((entry) => entry.id)).toEqual(['x'])
    expect(result.refused).toEqual([])
  })
})

describe('the bound it imposes for itself', () => {
  it('refuses when the adapter timeout expires, even for a transport that ignores the abort', async () => {
    // The docs document no timeout, so the latency is unbounded from this side.
    // A mock that never resolves must not be able to hold a turn open, which is
    // why the timeout is raced against the transport and not only signalled into
    // it.
    let aborted = false
    const stuck = (http: JevHTTPRequest): Promise<JevHTTPResponse> => {
      http.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<JevHTTPResponse>(() => {})
    }
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      timeoutMs: 5,
      transport: { post: stuck },
    })

    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    expect(result.decisions).toEqual([])
    expect(result.refused[0]?.reason).toMatch(/adapter timeout/)
    expect(aborted).toBe(true)
  })

  it('refuses when a transport never resolves at all', async () => {
    const provider = new JevDecisionProvider({ apiKey: KEY, timeoutMs: 5, transport: hanging() })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'boolean', prompt: 'Is this a question?' }]),
    )

    expect(result.refused[0]?.reason).toMatch(/adapter timeout/)
  })
})

describe('what a malformed answer looks like', () => {
  it('refuses that one question and keeps the ones it could read', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({
        good: { type: 'noul', noul: 0.9 },
        wrongType: { type: 'choice', choice: 'a' },
        missing: {},
        outOfRange: { type: 'score', score: 99, confidence: 0.5 },
      }),
    })
    const result = await provider.decide(
      request([
        { id: 'good', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'wrongType', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'missing', kind: 'boolean', prompt: 'Is this a booking request?' },
        { id: 'outOfRange', kind: 'score', prompt: 'How strong?', bounds: [0, 1] },
      ]),
    )

    // Nothing is repaired. A noul that is not a number, a score past the last
    // level of its own question: the answer is that there is no answer, and the
    // alternative is a `Decision` this adapter made up.
    expect(result.decisions.map((entry) => entry.id)).toEqual(['good'])
    expect(result.refused.map((entry) => entry.id)).toEqual(['wrongType', 'missing', 'outOfRange'])
  })

  it('refuses a confidence outside [0, 1] rather than clipping it', async () => {
    const provider = new JevDecisionProvider({
      apiKey: KEY,
      transport: ok({ x: { type: 'choice', choice: 'a', confidence: 1.4 } }),
    })
    const result = await provider.decide(
      request([{ id: 'x', kind: 'choice', prompt: 'Which one?', options: ['a'] }]),
    )

    expect(result.decisions).toEqual([])
    expect(result.refused[0]?.reason).toMatch(/confidence/)
  })

  it('names the vendor in a way that carries no credential at all', () => {
    const provider = new JevDecisionProvider({ apiKey: KEY })
    // A model identity is the one thing the port asks a provider to carry
    // verbatim; the credential is not one of the things it carries, and the
    // provider never holds it anywhere a consumer could read it back.
    expect(provider.providerId).toBe('typesafe-jev')
    expect(provider.model).toBe('jev-latest')
    expect(JSON.stringify(provider.health)).not.toContain(KEY)
  })
})
