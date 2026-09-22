import { describe, expect, it } from "vitest";
import type {
  GenerativeComponent,
  HandoffContext,
  TurnOutcome,
} from "@archava/assistant";
import { describeBlock, toChatMessages, type ChatBlock } from "../src/index.js";

/**
 * The view model, as a black box.
 *
 * What is under test is not layout but *fidelity*: every block is something the
 * turn pipeline already decided, so the interesting cases are the ones where a
 * shell could have improved on that decision. A held action must arrive as a
 * confirmation and not as a result; a comparison frame must arrive empty; an
 * order total must be divided by the currency's own divisor. Each test names the
 * clause it defends.
 */

const TENANT = "acme-hotels";
const SESSION = "session-1";
const OCCURRED_AT = "2026-04-01T09:00:00.000Z";

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    tenantId: TENANT,
    sessionId: SESSION,
    occurredAt: OCCURRED_AT,
    basis: "retrieval",
    text: "Room 12 is the closest to the beach.",
    structuredTruth: {},
    citations: [],
    components: [],
    rejectedComponents: [],
    permittedActionIds: [],
    actions: [],
    notices: [],
    knowledgeGap: false,
    handoff: null,
    events: [],
    ...overrides,
  };
}

/**
 * A handoff the platform already attributed. The turn layer only reads `reason`
 * and `summary`; the rest is there because an unattributed handoff is a
 * customer's story pointed at nobody (handoff.ts).
 */
function handoff(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    tenantId: TENANT,
    sessionId: SESSION,
    reason: "visitor_requested",
    route: "/rooms/12",
    locale: "en",
    attemptedActions: [],
    errors: [],
    summary: "The visitor asked for a person.",
    ...overrides,
  };
}

const VIEW = { locale: "en", inspect: true };

function blocks(overrides: Partial<TurnOutcome> = {}): readonly ChatBlock[] {
  return toChatMessages(outcome(overrides), VIEW).blocks;
}

function only<Kind extends ChatBlock["kind"]>(
  overrides: Partial<TurnOutcome>,
  kind: Kind,
): Extract<ChatBlock, { kind: Kind }> {
  const found = blocks(overrides).filter((block) => block.kind === kind);
  expect(found).toHaveLength(1);
  return found[0] as Extract<ChatBlock, { kind: Kind }>;
}

function kinds(overrides: Partial<TurnOutcome> = {}): readonly string[] {
  return blocks(overrides).map((block) => block.kind);
}

describe("message identity", () => {
  it("keys a turn by session and time, so a redraw is not a duplicate", () => {
    const message = toChatMessages(outcome(), VIEW);
    expect(message.key).toBe(`${SESSION}:${OCCURRED_AT}`);
    expect(message.occurredAt).toBe(OCCURRED_AT);
  });
});

describe("order (§25)", () => {
  const ORDER: GenerativeComponent = {
    kind: "order_summary",
    props: {
      orderId: "ORD-7",
      amountMinor: 1_438_000,
      currency: "IDR",
      stage: "confirmation_sent",
    },
  };

  it("formats the total by the currency’s divisor, not by a convention", () => {
    // IDR's minor unit is 1, so this is 1,438,000 whole rupiah. A shell that
    // assumed two decimals would print IDR 14,380 and under-quote the guest.
    const block = only({ components: [ORDER] }, "order");
    expect(block.amount).toBe("IDR 1,438,000");
    expect(block.orderId).toBe("ORD-7");
    expect(block.stage).toBe("confirmation_sent");
  });
});

describe("trust surfaces (§17)", () => {
  it("puts the basis badge before the answer it justifies", () => {
    expect(kinds()).toEqual(["basis", "text"]);
  });

  it("admits a gap instead of answering anyway", () => {
    const gap = only({ knowledgeGap: true }, "banner");
    expect(gap.tone).toBe("gap");
    expect(gap.message).toMatch(/No information was found/);
  });

  it("flattens structured truth to the producer’s own rendering", () => {
    const block = only(
      {
        basis: "structured_truth",
        structuredTruth: {
          price: { amountMinor: 1_200_000, currency: "IDR" },
          rooms_left: 2,
          open: true,
          note: null,
        },
      },
      "truth",
    );
    expect(block.rows).toEqual([
      { subject: "price", path: "$.amountMinor", value: "1200000" },
      { subject: "price", path: "$.currency", value: "IDR" },
      { subject: "rooms_left", path: "$", value: "2" },
      { subject: "open", path: "$", value: "true" },
      { subject: "note", path: "$", value: "null" },
    ]);
    expect(block.truncated).toBe(false);
  });

  it("marks a record it cut off rather than pretending it read all of it", () => {
    const block = only(
      {
        basis: "structured_truth",
        structuredTruth: { rate: { weekday: { villa: { net: 1_500_000 } } } },
      },
      "truth",
    );
    expect(block.truncated).toBe(true);
    expect(describeBlock(block)).toContain("…");
  });

  it("shows no truth panel when the answer did not come from live data", () => {
    expect(
      kinds({ structuredTruth: { price: { amountMinor: 1 } } }),
    ).not.toContain("truth");
  });
});

describe("components (§25)", () => {
  const MATRIX: GenerativeComponent = {
    kind: "comparison_table",
    props: {
      entityIds: ["room-12", "room-14"],
      metrics: ["nightly_rate", "capacity"],
    },
  };
  const CTA: GenerativeComponent = {
    kind: "cta",
    props: { label: "Book Room 12", actionId: "booking.create" },
  };
  const HANDOFF_CARD: GenerativeComponent = {
    kind: "human_handoff_card",
    props: { reason: "visitor_requested", requested: false },
  };

  it("hands a comparison frame over empty, for the host to fill", () => {
    // A filled cell would be the assistant inventing a number — §17's failure in
    // miniature — so the block carries axes and nothing else.
    const block = only({ components: [MATRIX] }, "matrix");
    expect(block.entityIds).toEqual(["room-12", "room-14"]);
    expect(block.metrics).toEqual(["nightly_rate", "capacity"]);
    expect(Object.keys(block)).toEqual(["kind", "entityIds", "metrics"]);
  });

  it("withholds a CTA the gate did not permit", () => {
    expect(kinds({ components: [CTA], permittedActionIds: [] })).not.toContain(
      "cta",
    );
  });

  it("draws a CTA the gate permitted", () => {
    const block = only(
      { components: [CTA], permittedActionIds: ["booking.create"] },
      "cta",
    );
    expect(block.actionId).toBe("booking.create");
    expect(block.label).toBe("Book Room 12");
  });

  it("does not draw a handoff card twice", () => {
    // The turn carries both a card and a handoff context; the block list takes the
    // context, so a visitor is not offered the same escalation twice.
    expect(
      kinds({
        components: [HANDOFF_CARD],
        handoff: handoff({ summary: "Guest wants a person." }),
      }),
    ).toEqual(["basis", "text", "handoff"]);
  });
});

describe("actions (§18)", () => {
  it("renders a held action as a confirmation, carrying the gate’s own inputs", () => {
    const block = only(
      {
        actions: [
          {
            actionId: "booking.create",
            decision: "confirmation_required",
            reason: "a human may abort a booking",
            prompt: "Book Room 12?",
            ran: false,
            inputs: { nights: 2 },
          },
        ],
      },
      "confirmation",
    );
    expect(block.actionId).toBe("booking.create");
    expect(block.prompt).toBe("Book Room 12?");
    expect(block.inputs).toEqual({ nights: 2 });
  });

  it("never calls a held action a result", () => {
    expect(
      kinds({
        actions: [
          {
            actionId: "booking.create",
            decision: "confirmation_required",
            ran: false,
            inputs: {},
          },
        ],
      }),
    ).not.toContain("result");
  });

  it("renders an action that ran as a result", () => {
    const block = only(
      {
        actions: [
          { actionId: "cart.add", decision: "allow", ran: true, inputs: {} },
        ],
      },
      "result",
    );
    expect(block.actionId).toBe("cart.add");
  });

  it("says nothing about an action the gate refused outright", () => {
    // A denial is not a thing the visitor can act on; drawing a "cannot do that"
    // card would invite them to ask again.
    expect(
      kinds({
        actions: [
          {
            actionId: "payment.refund",
            decision: "denied",
            reason: "not permitted",
            ran: false,
            inputs: {},
          },
        ],
      }),
    ).toEqual(["basis", "text"]);
  });
});

describe("handoff and inspector (§26, §16)", () => {
  it("puts the handoff card last, after the answer", () => {
    const kindsWithHandoff = kinds({
      text: "A colleague will pick this up.",
      handoff: handoff({ summary: "Guest wants a person on the phone." }),
    });
    expect(kindsWithHandoff).toEqual(["basis", "text", "handoff"]);
  });

  it("keeps the inspector off unless it was asked for", () => {
    expect(
      toChatMessages(outcome({ notices: ["guest_phone masked"] }), {
        locale: "en",
      }).blocks,
    ).not.toContain("inspector");
  });

  it("shows everything the turn withheld when it was asked for", () => {
    const block = only(
      {
        notices: ["guest_phone masked"],
        rejectedComponents: ["comparison_table: entityIds must have 2 items"],
        permittedActionIds: ["booking.create"],
      },
      "inspector",
    );
    expect(block.notices).toEqual(["guest_phone masked"]);
    expect(block.rejectedComponents).toEqual([
      "comparison_table: entityIds must have 2 items",
    ]);
    expect(block.permittedActionIds).toEqual(["booking.create"]);
    expect(describeBlock(block)).toContain("guest_phone masked");
  });
});

describe("describeBlock", () => {
  it("names a source card by its title and excerpt", () => {
    const block = only(
      {
        components: [
          {
            kind: "faq_source_card",
            props: {
              sourceId: "src-1",
              sourceTitle: "Cancellation policy",
              excerpt: "Free until 48 hours.",
            },
          },
        ],
      },
      "sourceCard",
    );
    expect(describeBlock(block)).toBe(
      "Cancellation policy: Free until 48 hours.",
    );
  });

  it("falls back to the action id when a prompt is missing", () => {
    const block = only(
      {
        actions: [
          {
            actionId: "booking.create",
            decision: "confirmation_required",
            ran: false,
            inputs: {},
          },
        ],
      },
      "confirmation",
    );
    expect(describeBlock(block)).toBe("Confirm booking.create");
  });
});
