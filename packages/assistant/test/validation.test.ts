import { describe, expect, it } from 'vitest'
import {
  hasInputContract,
  inputRejectionMessage,
  validateActionInputs,
  type EntityResolver,
} from '../src/index.js'

/**
 * Action input validation (§9) as a black-box gate.
 *
 * The property this file exists to lock down is that a check can be *skipped*
 * and still look like it ran. §9 asks for authoritative entity resolution, and a
 * validator that returns "ok" when no resolver was supplied passes every shape
 * test it has — the inputs are the right types, the required fields are present,
 * the tenant id is not in there — and an action executes with an id nobody ever
 * checked. That is the failure this file refuses to let back in: **the absence of
 * a resolver is a refusal, not a permission.**
 *
 * Which is why the action ids are written out below as a table rather than read
 * from the module. A test that enumerated the module's own contracts would pass on
 * whatever the module happens to contain; a test that *states* what it believes
 * the contract to be fails loudly when the two drift. `hasInputContract` is
 * asserted on each entry so a typo here fails as a typo rather than as a
 * mysteriously-passing loop.
 *
 * Two facts about the contract that a reader should know before trusting a pass:
 *
 * 1. The catalogue entities below are only the *catalog* answers. `ui.highlight`
 *    and `ui.compare` name a `pageEntity`, which is answered by the page rather
 *    than by the tenant, and they are asserted separately, with their kind name
 *    observed rather than assumed — a kind typed differently from the one the
 *    resolver checks is the same hole wearing a different hat.
 * 2. `admin.config.update` and `form.submit` carry object fields whose *contents*
 *    the contract cannot name. Those are kept intact rather than stripped, and
 *    asserted as such, because a contract this loose can still be held to what it
 *    does say.
 */

const TENANT = 'acme-hotels'

/** Answers yes to everything, so a test can be about the gate and not about §9. */
const CONFIRMING: EntityResolver = {
  resolveExists: (): Promise<boolean> => Promise.resolve(true),
}

/** Answers no to everything, so a test can be about the refusal and not about one id. */
const DENYING: EntityResolver = {
  resolveExists: (): Promise<boolean> => Promise.resolve(false),
}

/** Yes for one id only, so a test can be about one element of a list. */
const ONLY_FIRST: EntityResolver = {
  resolveExists: (_tenantId, _kind, entityId): Promise<boolean> =>
    Promise.resolve(entityId === 'room-12'),
}

/** A port that throws, which is an unreachable catalog rather than an answer. */
const BROKEN: EntityResolver = {
  resolveExists: (): Promise<boolean> => {
    throw new Error('catalog unreachable')
  },
}

describe('an unreachable resolver', () => {
  it('is treated as an answer of no, not as permission', async () => {
    // The rule that makes every failure above a refusal. A throw from the catalog
    // is a missing answer, and a missing answer is the one thing §9 forbids
    // reading as a yes — the same logic that made a missing port a refusal. The
    // refusal is *about the id*, because that is the question that went unanswered;
    // field `*` would suggest the whole action was refused for a generic reason.
    const result = await validateActionInputs(
      request('product.read', { productId: 'room-12' }, BROKEN),
    )
    expect(result.ok, 'an unreachable resolver was read as approval').toBe(false)
    if (result.ok) return
    expect(result.rejections[0]?.field).toBe('productId')
  })

  it('does not let an exception escape to the caller', async () => {
    // The turn must not fail because a catalog was down; it must refuse. An
    // uncaught throw here would take the whole turn with it, which is a worse
    // answer to a visitor than "I could not check that".
    await expect(
      validateActionInputs(request('ui.highlight', { entityId: 'room-12' }, BROKEN)),
    ).resolves.toMatchObject({ ok: false })
  })
})

function request(
  actionId: string,
  inputs: Readonly<Record<string, unknown>>,
  resolver?: EntityResolver,
) {
  return {
    actionId,
    inputs,
    tenantId: TENANT,
    ...(resolver === undefined ? {} : { resolver }),
  }
}

/**
 * Every contract whose fields name a tenant-catalog entity, and valid inputs.
 *
 * These are the ids §9 is about: a slot, an order, a product — a thing that
 * exists in somebody's system independently of what a model typed.
 */
const CATALOG_ENTITY_BEARING: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'product.read': { productId: 'room-12' },
  'availability.read': { subjectId: 'slot_1' },
  'order.status.read': { orderReference: 'ORD-1' },
  'cart.item.add': { productId: 'room-12', quantity: 2 },
  'cart.item.remove': { productId: 'room-12' },
  'booking.create': { slotId: 'slot_1', customer: { customerRef: 'cust_9' } },
  'email.send': { templateId: 'tpl_1', to: 'guest@example.com' },
  'form.submit': { formId: 'booking_request', fields: { check_in: '2026-05-01' } },
}

/**
 * Contracts whose only declared dependency is on what the page is showing.
 *
 * `ui.highlight` and `ui.compare` are the two actions a page runs directly, and
 * each asks for a `pageEntity` id verified against the page awareness graph rather
 * than against the tenant's catalog. They are asserted separately from the catalog
 * table because the authority is a different one, and the kind name is *observed*
 * in the tests below rather than assumed — `apps/web`'s `pageEntityResolver`
 * discriminates on it.
 */
const PAGE_ACTIONS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'ui.highlight': { entityId: 'room-12' },
  'ui.compare': { entityIds: ['room-12', 'room-14'] },
}

/** Contracts that name no outside thing at all, so there is nothing to resolve. */
const ENTITY_FREE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'admin.config.update': { changes: { presence: 'chat' } },
  'navigation.go': { path: '/rooms' },
}

/**
 * Every action id this file makes a claim about, asserted to exist.
 *
 * One place, because a missing contract makes an action inert for an entirely
 * unrelated reason, and a test that passed on that would be testing nothing.
 */
const ALL_ACTIONS = [
  ...Object.keys(CATALOG_ENTITY_BEARING),
  ...Object.keys(PAGE_ACTIONS),
  ...Object.keys(ENTITY_FREE),
]

describe('every contract this file names is registered', () => {
  it('has one — or the table above has drifted from the module', () => {
    for (const actionId of ALL_ACTIONS) {
      expect(hasInputContract(actionId), `${actionId} has no registered contract`).toBe(true)
    }
  })
})

describe('an action that names a catalog entity, with no resolver', () => {
  it('is refused for every one of them', async () => {
    // The regression. §9 asked for authoritative resolution; a missing port was
    // being read as "nothing to check here", and an action ran with an id nobody
    // ever asked a catalog about. The refusal is on field `*`, because there is no
    // individual field at fault — a missing resolver is not a property of any one
    // input, and blaming one would send an operator reading the wrong file.
    for (const [actionId, inputs] of Object.entries(CATALOG_ENTITY_BEARING)) {
      const result = await validateActionInputs(request(actionId, inputs))
      expect(result.ok, `${actionId} was accepted without a resolver`).toBe(false)
      if (result.ok) continue
      expect(result.rejections[0]?.field).toBe('*')
      expect(result.rejections[0]?.reason).toMatch(/resolver/)
    }
  })

  it('names the resolver it did not have, so the refusal is actionable', async () => {
    // A refusal that says "invalid input" sends an operator looking at the payload
    // when the payload was fine. The sentence reaches whoever assembles the turn,
    // and it has to name the missing dependency rather than the data.
    const result = await validateActionInputs(
      request('booking.create', CATALOG_ENTITY_BEARING['booking.create'] ?? {}),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const message = inputRejectionMessage(result.rejections)
    expect(message).toMatch(/entity resolver/)
    expect(message).not.toMatch(/slotId/)
  })

  it('is refused even when the ids it would have asked about are plausible', async () => {
    // The shape of an input is not evidence about the world. `slot_1` looks exactly
    // like a real slot — that is what a plausible id *is* — and "nothing objected
    // to the shape" is not an answer to "does this exist".
    const result = await validateActionInputs(
      request('booking.create', {
        slotId: 'slot_1',
        customer: { customerRef: 'cust_9', notes: 'late arrival' },
      }),
    )
    expect(result.ok).toBe(false)
  })
})

describe('an action that names no entity, with no resolver', () => {
  it('may pass ordinary shape validation — there is nothing to ask', async () => {
    // The other half of the rule, and the reason it is a rule about contracts
    // rather than a blanket refusal. A path and a configuration change refer to no
    // tenant catalog, so demanding a resolver would be a rule with no reason.
    const navigation = await validateActionInputs(
      request('navigation.go', ENTITY_FREE['navigation.go'] ?? {}),
    )
    expect(navigation.ok).toBe(true)
    if (!navigation.ok) return
    expect(navigation.inputs.path).toBe('/rooms')

    const config = await validateActionInputs(
      request('admin.config.update', ENTITY_FREE['admin.config.update'] ?? {}),
    )
    expect(config.ok).toBe(true)
    if (!config.ok) return
    // The change itself is kept intact, which is asserted in full further down.
    expect(config.inputs.changes).toEqual({ presence: 'chat' })
  })

  it('is still refused for its own defects, with no resolver to blame', async () => {
    // Fail closed stays fail closed. The entity-free path is not a bypass for the
    // rest of the contract's rules.
    const result = await validateActionInputs(request('navigation.go', { path: 17 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toMatch(/must be a string/)
  })
})

describe('an action that names a page entity, with no resolver', () => {
  it.each(Object.keys(PAGE_ACTIONS))(
    '%s is refused — the id it names must be answered for',
    async (actionId) => {
      // `pageEntity` is the kind the L1 UI actions ask for. A pattern that excluded
      // camelCase made it invisible twice over: no missing-resolver refusal here, and
      // no resolver call below. `apps/web`'s `pageEntityResolver` exists to answer
      // exactly these questions and was never reached.
      const result = await validateActionInputs(request(actionId, PAGE_ACTIONS[actionId] ?? {}))
      expect(result.ok, `${actionId} was accepted without a resolver`).toBe(false)
      if (result.ok) return
      expect(result.rejections[0]?.field).toBe('*')
    },
  )

  it.each(Object.keys(PAGE_ACTIONS))(
    '%s is asked about when a resolver is supplied',
    async (actionId) => {
      // The half that actually connects the two: a page resolver that says no is a
      // refusal, so a page can never run a UI action against an id it is not showing.
      const result = await validateActionInputs(
        request(actionId, PAGE_ACTIONS[actionId] ?? {}, DENYING),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.rejections[0]?.reason).toMatch(/pageEntity/)
    },
  )

  it.each(Object.keys(PAGE_ACTIONS))(
    '%s is asked about with the kind pageEntity',
    async (actionId) => {
      // The web resolver answers from the page, not the catalog, and it discriminates
      // on the kind — so a kind name typed differently from the one the resolver
      // checks is the same hole wearing a different hat. Observed rather than assumed.
      const asked: string[] = []
      const observer: EntityResolver = {
        resolveExists: (_tenantId, kind, entityId): Promise<boolean> => {
          asked.push(String(kind))
          return Promise.resolve(entityId !== 'room-14')
        },
      }
      await validateActionInputs(request(actionId, PAGE_ACTIONS[actionId] ?? {}, observer))
      expect(asked.length).toBeGreaterThan(0)
      expect(new Set(asked)).toEqual(new Set(['pageEntity']))
    },
  )

  it('refuses the element of an array that failed, by its index', async () => {
    const result = await validateActionInputs(
      request('ui.compare', { entityIds: ['room-12', 'room-14'] }, ONLY_FIRST),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const paths = result.rejections.map((rejection) => rejection.field)
    expect(paths).toEqual(['entityIds[1]'])
  })
})

describe('where the id lives in the contract', () => {
  // The walk has to find an entity id at every depth a contract can hide one, or
  // the missing-resolver refusal is scoped to the top level and a nested id runs
  // unchecked. `booking.create`'s `customer.customerRef` is the case: a booking
  // for a customer that does not exist is not a booking anybody wanted.
  const DEPTHS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    'directly on the action': { orderReference: 'ORD-1' },
    'inside a required object': { slotId: 'slot_1', customer: { customerRef: 'cust_9' } },
    'beside non-entity fields': { productId: 'room-12', quantity: 2 },
  }

  for (const [where, inputs] of Object.entries(DEPTHS)) {
    it(`refuses one held ${where}`, async () => {
      const actionId =
        'orderReference' in inputs
          ? 'order.status.read'
          : 'productId' in inputs
            ? 'cart.item.add'
            : 'booking.create'
      const result = await validateActionInputs(request(actionId, inputs))
      expect(result.ok, `${where} was accepted without a resolver`).toBe(false)
    })
  }
})

describe('with a resolver that answers', () => {
  it('returns the parsed inputs when the resolver confirms', async () => {
    const result = await validateActionInputs(
      request('booking.create', CATALOG_ENTITY_BEARING['booking.create'] ?? {}, CONFIRMING),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.inputs.slotId).toBe('slot_1')
    expect(result.inputs.customer).toEqual({ customerRef: 'cust_9' })
  })

  it('refuses the exact field an id failed on, nested or not', async () => {
    // The dotted path is what makes the refusal usable: a model shown "customer"
    // cannot tell which of the object's fields was refused, and one shown
    // `customer.customerRef` can ask for the right thing.
    const result = await validateActionInputs(
      request('booking.create', { slotId: 'slot_1', customer: { customerRef: 'cust_9' } }, DENYING),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const paths = result.rejections.map((rejection) => rejection.field)
    expect(paths).toContain('slotId')
    expect(paths).toContain('customer.customerRef')
  })

  it('carries the dotted path into the visitor-facing sentence', async () => {
    // `inputRejectionMessage` renders one sentence from the first rejection, so the
    // assertion below is the same code path with a different first rejection: when
    // the slot resolves and only the customer does not, the sentence a visitor
    // reads has to name `customer.customerRef` — otherwise a model is told
    // "customer" and cannot tell which of the object's fields was refused.
    const onlyNested: EntityResolver = {
      resolveExists: (_tenantId, kind, _entityId): Promise<boolean> =>
        Promise.resolve(kind !== 'customer'),
    }
    const result = await validateActionInputs(
      request(
        'booking.create',
        { slotId: 'slot_1', customer: { customerRef: 'cust_9' } },
        onlyNested,
      ),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toContain('customer.customerRef')
  })

  it('asks the resolver for the tenant the turn belongs to', async () => {
    // An id that exists for one tenant must resolve to nothing for another. A
    // resolver that ignored its first argument could not tell the difference, so
    // the call is observed rather than assumed.
    const tenants: string[] = []
    const observer: EntityResolver = {
      resolveExists: (tenantId, _kind, _entityId): Promise<boolean> => {
        tenants.push(tenantId)
        return Promise.resolve(true)
      },
    }
    await validateActionInputs(request('order.status.read', { orderReference: 'ORD-1' }, observer))
    expect(tenants).toEqual([TENANT])
  })

  it('does not answer a shape question', async () => {
    // A resolver's job is existence, and a `number` where a string belongs is a
    // refusal the resolver never sees. The two checks are not substitutes: an
    // existing id of the wrong type is still wrong, and a well-typed non-existent
    // id is still a refusal.
    const result = await validateActionInputs(
      request('order.status.read', { orderReference: 17 }, CONFIRMING),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toMatch(/must be a string/)
  })

  it('does not make an unregistered action runnable', async () => {
    const result = await validateActionInputs(
      request('booking.cancel_with_refund', { bookingId: 'book_1' }, CONFIRMING),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toMatch(/No input contract/)
  })

  it('never lets a tenant id travel inside the payload', async () => {
    // §23 by another route: an executor that trusts a tenant id in its input has
    // been handed a cross-tenant write. The tenant is a property of the turn, and
    // the resolver is called with the turn's tenant, never with the payload's.
    const seen: string[] = []
    const observer: EntityResolver = {
      resolveExists: (tenantId, _kind, _entityId): Promise<boolean> => {
        seen.push(tenantId)
        return Promise.resolve(true)
      },
    }
    const result = await validateActionInputs(
      request('order.status.read', { orderReference: 'ORD-1', tenantId: 'other-tenant' }, observer),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toMatch(/tenantId/)
    expect(seen).not.toContain('other-tenant')
  })
})

describe('a field whose contents the contract cannot name', () => {
  it('still carries what the visitor submitted', async () => {
    // A `kind: 'object'` field with no `fields` of its own is a contract that says
    // "an object" and nothing about what is in it. Deriving that as `z.object({})`
    // stripped every key the visitor sent — `admin.config.update` allowed through
    // with `changes: {}` and a form submitted with `fields: {}` — which is a silent
    // data loss on a path no resolver touches. The payload is the one thing a
    // contract this loose can still be held to.
    const config = await validateActionInputs(
      request('admin.config.update', { changes: { presence: 'chat', theme: 'dark' } }),
    )
    expect(config.ok).toBe(true)
    if (!config.ok) return
    expect(config.inputs.changes).toEqual({ presence: 'chat', theme: 'dark' })

    const form = await validateActionInputs(
      request('form.submit', CATALOG_ENTITY_BEARING['form.submit'] ?? {}, CONFIRMING),
    )
    expect(form.ok).toBe(true)
    if (!form.ok) return
    expect(form.inputs.fields).toEqual({ check_in: '2026-05-01' })
  })

  it('refuses a value that is not an object at all', async () => {
    // Fail closed still applies to the loose end of the contract: the field says
    // "an object", so a string is a refusal. The inside is unverified, the outside
    // is not.
    const result = await validateActionInputs(
      request('admin.config.update', { changes: 'make it dark' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(inputRejectionMessage(result.rejections)).toMatch(/must be a object/)
  })
})
