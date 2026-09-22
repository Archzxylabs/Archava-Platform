import { describe, expect, it } from "vitest";
import type {
  GenerativeComponent,
  HandoffContext,
  TurnOutcome,
} from "@archava/assistant";
import {
  mount,
  ChatEnvironmentError,
  ChatMountError,
  type ChatEvent,
  type ChatEventLike,
  type ChatNodeLike,
} from "../src/index.js";

/**
 * The shell, against a DOM built by hand.
 *
 * A fake DOM rather than `jsdom`: there is no `jsdom` in this repository, and the
 * point is not to test the browser. What is under test is the shell's three
 * rules — it draws without deciding, it writes text as text, and it never runs an
 * action itself — so the fake only has to be faithful about the parts the shell
 * touches: elements, attributes, children, and listeners.
 */

const SESSION = "session-1";

type Listener = (event: ChatEventLike) => void;

class FakeNode implements ChatNodeLike {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  textContent: string | null = null;
  value = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: ChatNodeLike): ChatNodeLike {
    if (!(child instanceof FakeNode)) {
      throw new Error("this fake only takes its own nodes");
    }
    this.children.push(child);
    return child;
  }

  removeChild(child: ChatNodeLike): ChatNodeLike {
    const index = this.children.indexOf(child as FakeNode);
    if (index < 0) {
      throw new Error(
        `removeChild: ${child.tagName} is not a child of ${this.tagName}`,
      );
    }
    this.children.splice(index, 1);
    return child;
  }

  replaceChild(next: ChatNodeLike, previous: ChatNodeLike): ChatNodeLike {
    const index = this.children.indexOf(previous as FakeNode);
    if (index < 0) {
      throw new Error(
        `replaceChild: ${previous.tagName} is not a child of ${this.tagName}`,
      );
    }
    this.children[index] = next as FakeNode;
    return previous;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((entry) => entry !== listener),
    );
  }

  focus(): void {
    this.attributes.set("data-focused", "true");
  }
}

class FakeDocument {
  createElement(tagName: string): ChatNodeLike {
    return new FakeNode(tagName);
  }
}

class FakeHost implements ChatNodeLike {
  readonly tagName = "ARCHAVA-CHAT";
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly shadowRoot: FakeNode;
  textContent: string | null = null;
  value = "";
  /** A host that cannot shadow at all, for the environment-error test. */
  readonly canShadow: boolean;

  constructor(canShadow = true) {
    this.canShadow = canShadow;
    this.shadowRoot = new FakeNode("SHADOW-ROOT");
  }

  get ownerDocument(): FakeDocument {
    return new FakeDocument();
  }

  attachShadow(_options?: {
    readonly mode?: "open" | "closed";
  }): FakeNode | null {
    return this.canShadow ? this.shadowRoot : null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: ChatNodeLike): ChatNodeLike {
    this.children.push(child as FakeNode);
    return child;
  }

  removeChild(child: ChatNodeLike): ChatNodeLike {
    this.children.splice(this.children.indexOf(child as FakeNode), 1);
    return child;
  }

  replaceChild(_next: ChatNodeLike, _previous: ChatNodeLike): ChatNodeLike {
    throw new Error("a host node is never replaced");
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
}

/* ------------------------------------------------------------------ queries -- */

function classes(node: ChatNodeLike): readonly string[] {
  return (node.getAttribute("class") ?? "")
    .split(" ")
    .filter((name) => name.length > 0);
}

function has(node: ChatNodeLike, className: string): boolean {
  return classes(node).includes(className);
}

/** The first node at or below `root` carrying `className`. */
function find(root: ChatNodeLike, className: string): FakeNode | null {
  if (has(root, className)) {
    return root as FakeNode;
  }
  for (const child of root.children) {
    const found = find(child, className);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function text(node: ChatNodeLike): string {
  return node.children.reduce(
    (accumulated, child) => accumulated + text(child),
    node.textContent ?? "",
  );
}

function tags(node: ChatNodeLike): readonly string[] {
  return [node.tagName, ...node.children.flatMap(tags)];
}

function click(node: FakeNode, type = "click"): void {
  for (const listener of [...(node.listeners.get(type) ?? [])]) {
    listener({ type });
  }
}

/* ----------------------------------------------------------------- fixtures -- */

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    tenantId: "acme-hotels",
    sessionId: SESSION,
    occurredAt: "2026-04-01T09:00:00.000Z",
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

/** A handoff the platform already attributed; the shell only reads it. */
function handoff(overrides: Partial<HandoffContext> = {}): HandoffContext {
  return {
    tenantId: "acme-hotels",
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

/** A harness that records what the emit() boundary produced. */
function harness(options: Parameters<typeof mount>[1] = {}) {
  const events: ChatEvent[] = [];
  const host = new FakeHost();
  const handle = mount(host, {
    onEvent: (event) => {
      events.push(event);
    },
    ...options,
  });
  // The handle only exposes the root as the two things the shell grows it with;
  // the fake's own node is what the queries walk.
  return { host, handle, root: host.shadowRoot, events };
}

/* -------------------------------------------------------------------- tests -- */

describe("mount (§24)", () => {
  it("opens a shadow root and puts the stylesheet inside it", () => {
    // The stylesheet lives inside the root so the host page cannot restyle the
    // assistant and the assistant cannot restyle the host page.
    const { host, root: harnessRoot } = harness();
    expect(host.getAttribute("data-archava-chat")).toBe("mounted");
    expect(find(harnessRoot, "archava-sheet")?.textContent).toContain(
      ".archava-log",
    );
    expect(harnessRoot.children).toHaveLength(3);
  });

  it("exposes a live region for the turn log", () => {
    const { root: harnessRoot } = harness();
    const log = find(harnessRoot, "archava-log");
    expect(log?.getAttribute("aria-live")).toBe("polite");
    expect(log?.getAttribute("role")).toBe("log");
  });

  it("refuses a second mount on the same host", () => {
    const { host } = harness();
    expect(() => mount(host)).toThrow(ChatMountError);
  });

  it("mounts again once the first handle is destroyed", () => {
    const { host, handle } = harness();
    handle.destroy();
    expect(host.getAttribute("data-archava-chat")).toBe("unmounted");
    expect(() => mount(host)).not.toThrow();
  });

  it("fails loudly when there is no document", () => {
    const host = new FakeHost();
    expect(() => mount(host, { document: null })).toThrow(ChatEnvironmentError);
  });

  it("fails loudly when the host cannot shadow at all", () => {
    // A fallback to a plain div would put §24's isolation in the hands of the
    // host's stylesheet, so there is no fallback.
    const host = new FakeHost(false);
    expect(() => mount(host)).toThrow(ChatEnvironmentError);
  });
});

describe("show", () => {
  it("draws one message per turn, keyed by session and time", () => {
    const { handle, root: harnessRoot } = harness();
    handle.show(outcome());
    const messages = find(harnessRoot, "archava-log")?.children ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.getAttribute("data-key")).toBe(
      `${SESSION}:2026-04-01T09:00:00.000Z`,
    );
    expect(messages[0]?.getAttribute("data-time")).toBe(
      "2026-04-01T09:00:00.000Z",
    );
  });

  it("re-draws the same turn in place rather than duplicating it", () => {
    const { handle, root: harnessRoot } = harness();
    handle.show(outcome());
    handle.show(outcome({ text: "Room 14 is free." }));
    expect(find(harnessRoot, "archava-text")?.textContent).toBe(
      "Room 14 is free.",
    );
    expect(find(harnessRoot, "archava-message")?.children).toHaveLength(2);
  });

  it("keeps the log bounded, dropping the oldest message first", () => {
    const { handle, root: harnessRoot } = harness();
    for (let minute = 0; minute < 55; minute += 1) {
      handle.show(
        outcome({ occurredAt: minuteAt(minute), text: `Answer ${minute}` }),
      );
    }
    const log = find(harnessRoot, "archava-log");
    expect(log?.children).toHaveLength(50);
    expect(log?.children[0]?.getAttribute("data-key")).toBe(
      `${SESSION}:${minuteAt(5)}`,
    );
  });

  it("shows the inspector only when the host asked for it", () => {
    const plain = harness();
    const plainRoot = plain.root;
    plain.handle.show(outcome({ notices: ["guest_phone masked"] }));
    expect(find(plainRoot, "archava-inspector")).toBeNull();

    const inspecting = harness({ inspect: true });
    const inspectingRoot = inspecting.root;
    inspecting.handle.show(outcome({ notices: ["guest_phone masked"] }));
    expect(find(inspectingRoot, "archava-inspector")).not.toBeNull();
  });
});

describe("clear and destroy", () => {
  it("clear empties the log and forgets the turns it drew", () => {
    const { handle, root: harnessRoot } = harness();
    handle.show(outcome());
    handle.clear();
    expect(find(harnessRoot, "archava-log")?.children).toHaveLength(0);
    handle.show(outcome());
    expect(
      (find(harnessRoot, "archava-log")?.children ?? []).length,
    ).toBeGreaterThan(0);
  });

  it("destroy removes the sheet and the log from the shadow root", () => {
    const { host, handle } = harness();
    handle.destroy();
    expect(host.shadowRoot.children).toHaveLength(0);
    expect(host.getAttribute("data-archava-chat")).toBe("unmounted");
  });
});

describe("text is text", () => {
  it("writes a hostile string as characters, never as markup", () => {
    const { handle, root: harnessRoot } = harness();
    handle.show(outcome({ text: "<img src=x onerror=alert(1)>Room 12</img>" }));
    expect(find(harnessRoot, "archava-text")?.textContent).toBe(
      "<img src=x onerror=alert(1)>Room 12</img>",
    );
    expect(tags(harnessRoot)).not.toContain("IMG");
  });

  it("writes a tenant-owned citation as a title, never as a link", () => {
    // A citation carries no URL by schema, so there is nothing to link to — an
    // <a href> here would be an invention.
    const { handle, root: harnessRoot } = harness();
    handle.show(
      outcome({
        citations: [{ sourceId: "src-1", sourceTitle: "Cancellation policy" }],
      }),
    );
    expect(tags(harnessRoot)).not.toContain("A");
    expect(find(harnessRoot, "archava-sources")?.textContent).toBe(
      "Cancellation policy",
    );
  });
});

describe("events (§18)", () => {
  it("emits a submitted message, trimmed, and clears the field", () => {
    const { events, root: harnessRoot } = harness();
    const input = requireNode(find(harnessRoot, "archava-composer-input"));
    const send = requireNode(find(harnessRoot, "archava-composer-send"));
    input.value = "  Is Room 12 free?  ";
    click(send);
    expect(events).toEqual([
      { kind: "message_submitted", text: "Is Room 12 free?" },
    ]);
    expect(input.value).toBe("");
  });

  it("emits nothing for an empty message", () => {
    const { events, root: harnessRoot } = harness();
    click(requireNode(find(harnessRoot, "archava-composer-send")));
    expect(events).toEqual([]);
  });

  it("emits an action request for a CTA, and never runs it", () => {
    const CTA: GenerativeComponent = {
      kind: "cta",
      props: { label: "Book Room 12", actionId: "booking.create" },
    };
    const { handle, events, root: harnessRoot } = harness();
    handle.show(
      outcome({ components: [CTA], permittedActionIds: ["booking.create"] }),
    );
    click(requireNode(find(harnessRoot, "archava-cta")));
    expect(events).toEqual([
      {
        kind: "action_requested",
        actionId: "booking.create",
        label: "Book Room 12",
        inputs: {},
      },
    ]);
  });

  it("re-emits the gate’s own inputs on a confirmation, unchanged", () => {
    const { handle, events, root: harnessRoot } = harness();
    handle.show(
      outcome({
        actions: [
          {
            actionId: "booking.create",
            decision: "confirmation_required",
            prompt: "Book Room 12 for two nights?",
            reason: "a booking cannot be undone",
            ran: false,
            inputs: { nights: 2, roomId: "room-12" },
          },
        ],
      }),
    );
    const card = find(harnessRoot, "archava-confirmation");
    click(
      requireNode(
        card === null ? null : find(card, "archava-confirmation-confirm"),
      ),
    );
    expect(events).toEqual([
      {
        kind: "action_requested",
        actionId: "booking.create",
        label: "Book Room 12 for two nights?",
        inputs: { nights: 2, roomId: "room-12" },
      },
    ]);
  });

  it("reports a declined action as a decline, not as a request", () => {
    const { handle, events, root: harnessRoot } = harness();
    handle.show(
      outcome({
        actions: [
          {
            actionId: "booking.create",
            decision: "confirmation_required",
            ran: false,
            inputs: {},
          },
        ],
      }),
    );
    click(requireNode(find(harnessRoot, "archava-confirmation-decline")));
    expect(events).toEqual([
      { kind: "action_declined", actionId: "booking.create" },
    ]);
  });

  it("carries a chosen slot verbatim", () => {
    const PICKER: GenerativeComponent = {
      kind: "booking_picker",
      props: {
        subjectId: "room-12",
        subjectName: "Room 12",
        slots: ["2026-04-02T14:00:00+07:00"],
      },
    };
    const { handle, events, root: harnessRoot } = harness();
    handle.show(outcome({ components: [PICKER] }));
    const slot = requireNode(find(harnessRoot, "archava-slot"));
    expect(slot.textContent).toBe("2026-04-02T14:00:00+07:00");
    click(slot);
    expect(events).toEqual([
      {
        kind: "slot_selected",
        subjectId: "room-12",
        slot: "2026-04-02T14:00:00+07:00",
      },
    ]);
  });

  it("offers a person on a handoff card without escalating on its own", () => {
    const { handle, events, root: harnessRoot } = harness();
    handle.show(
      outcome({
        handoff: handoff({ summary: "A colleague will call you back." }),
      }),
    );
    const button = requireNode(find(harnessRoot, "archava-handoff-cta"));
    expect(events).toEqual([]);
    click(button);
    expect(events).toEqual([
      { kind: "handoff_requested", label: "Talk to a person" },
    ]);
  });
});

describe("a comparison frame (§17)", () => {
  const MATRIX: GenerativeComponent = {
    kind: "comparison_table",
    props: { entityIds: ["room-12", "room-14"], metrics: ["nightly_rate"] },
  };

  it("leaves every cell empty, marked with the axes a host fills by", () => {
    const { handle, root: harnessRoot } = harness();
    handle.show(outcome({ components: [MATRIX] }));
    const matrix = requireNode(find(harnessRoot, "archava-matrix"));
    const cells = matrix.children
      .flatMap((row) => row.children)
      .filter((cell) => cell.tagName === "TD");
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.textContent).toBe("");
      expect(cell.getAttribute("data-entity")).toMatch(/^room-1[24]$/);
      expect(cell.getAttribute("data-metric")).toBe("nightly_rate");
    }
    expect(text(harnessRoot)).toContain(
      "Values come from the tenant’s own systems.",
    );
  });
});

/* ------------------------------------------------------------------- helpers -- */

function requireNode(node: FakeNode | null): FakeNode {
  if (node === null) {
    throw new Error("expected an element the shell did not draw");
  }
  return node;
}

function minuteAt(minute: number): string {
  return new Date(Date.UTC(2026, 3, 1, 9, minute)).toISOString();
}
