/**
 * A real DOM, offered to the platform's structural interfaces.
 *
 * `@archava/chat` and the SDK both read a DOM they describe rather than
 * `lib.dom`, and both for the same reason: the shapes a package actually touches
 * stay small enough to fake in a test, so a host page is not a special case that
 * only a browser can run. The cost of that honesty lands here. A real `Element`
 * satisfies most of `ChatNodeLike` and fails the parts that matter — its
 * `appendChild` takes and returns a `Node`, not a chat node — so a browser cannot
 * hand the shell its own DOM directly. This module is that translation, and it
 * is the only file in the app that names a real DOM type.
 *
 * Every mutation goes through the real element: nothing is copied, so what a
 * visitor clicks is the node the shell said it built. Wrapper identity is cached
 * per element, because the shell holds children in a `Map` and hands them back
 * for removal — a fresh wrapper on each lookup would name a node the real parent
 * had never seen.
 */
import type {
  ChatDocumentLike,
  ChatEventLike,
  ChatHostLike,
  ChatNodeLike,
  ChatRootLike,
} from '@archava/chat'

const elementHandles = new WeakMap<Element, ElementHandle>()
const documentHandles = new WeakMap<Document, DocumentHandle>()

/**
 * The real element a chat node stands for.
 *
 * A chat node can only have come from this bridge — the shell makes nothing of
 * its own — so a stranger is a bridge bug and throws rather than mutating
 * nothing at all.
 */
function raw(node: ChatNodeLike): Node {
  if (!(node instanceof ElementHandle)) {
    throw new TypeError('a chat node was not produced by this bridge')
  }
  return node.element
}

/** A real element, wearing `ChatNodeLike`. */
class ElementHandle implements ChatNodeLike {
  readonly element: Element
  /** The listeners handed upward, so removal can take back the same function. */
  private readonly forwarded = new Map<(event: ChatEventLike) => void, (event: Event) => void>()

  constructor(element: Element) {
    this.element = element
  }

  get tagName(): string {
    return this.element.tagName
  }

  get children(): readonly ChatNodeLike[] {
    return Array.from(this.element.children, (child) => adopt(child))
  }

  get textContent(): string | null {
    return this.element.textContent
  }

  set textContent(value: string | null) {
    this.element.textContent = value
  }

  /** Only form controls carry one; the composer's input is why it is here. */
  get value(): string | undefined {
    return this.element instanceof HTMLInputElement ? this.element.value : undefined
  }

  set value(next: string | undefined) {
    if (this.element instanceof HTMLInputElement && next !== undefined) {
      this.element.value = next
    }
  }

  setAttribute(name: string, value: string): void {
    this.element.setAttribute(name, value)
  }

  getAttribute(name: string): string | null {
    return this.element.getAttribute(name)
  }

  appendChild(child: ChatNodeLike): ChatNodeLike {
    this.element.appendChild(raw(child))
    return child
  }

  removeChild(child: ChatNodeLike): ChatNodeLike {
    this.element.removeChild(raw(child))
    return child
  }

  replaceChild(next: ChatNodeLike, previous: ChatNodeLike): ChatNodeLike {
    this.element.replaceChild(raw(next), raw(previous))
    return next
  }

  addEventListener(type: string, listener: (event: ChatEventLike) => void): void {
    let forward = this.forwarded.get(listener)
    if (forward === undefined) {
      forward = (event: Event) => {
        // `type` and, for a keyboard event, `key` are all the shell reads; the
        // rest of the event stays with the DOM, which is the only reason this is
        // a closure and not the listener itself. Without `key` the composer
        // could never tell Enter from a keystroke that is not a submission.
        const key = event instanceof KeyboardEvent ? event.key : undefined
        listener(key === undefined ? { type: event.type } : { type: event.type, key })
      }
      this.forwarded.set(listener, forward)
    }
    this.element.addEventListener(type, forward)
  }

  removeEventListener(type: string, listener: (event: ChatEventLike) => void): void {
    const forward = this.forwarded.get(listener)
    if (forward === undefined) return
    this.element.removeEventListener(type, forward)
    this.forwarded.delete(listener)
  }

  focus(): void {
    if (this.element instanceof HTMLElement) this.element.focus()
  }
}

/** A real shadow root, wearing `ChatRootLike`. */
class ShadowRootHandle implements ChatRootLike {
  readonly shadowRoot: ShadowRoot

  constructor(shadowRoot: ShadowRoot) {
    this.shadowRoot = shadowRoot
  }

  appendChild(child: ChatNodeLike): ChatNodeLike {
    this.shadowRoot.appendChild(raw(child))
    return child
  }

  removeChild(child: ChatNodeLike): ChatNodeLike {
    this.shadowRoot.removeChild(raw(child))
    return child
  }
}

/** A real document, wearing `ChatDocumentLike`. */
class DocumentHandle implements ChatDocumentLike {
  readonly document: Document

  constructor(document: Document) {
    this.document = document
  }

  createElement(tagName: string): ChatNodeLike {
    return adopt(this.document.createElement(tagName))
  }
}

/** The wrapper for an element, made once per element. */
function adopt(element: Element): ElementHandle {
  const existing = elementHandles.get(element)
  if (existing !== undefined) return existing
  const handle = new ElementHandle(element)
  elementHandles.set(element, handle)
  return handle
}

/** The wrapper for a document, made once per document. */
function adoptDocument(document: Document): DocumentHandle {
  const existing = documentHandles.get(document)
  if (existing !== undefined) return existing
  const handle = new DocumentHandle(document)
  documentHandles.set(document, handle)
  return handle
}

/**
 * The element to mount in, wearing `ChatHostLike`.
 *
 * `ownerDocument` is supplied rather than read from a global: a page may mount
 * into a document it was handed — an iframe's, a test's — so the shell has to
 * build in that one. It is null when the element has no document at all, which
 * the shell answers with its own refusal rather than a fallback. `attachShadow`
 * is left absent when the element cannot run it, for the same reason.
 */
export function domHost(element: HTMLElement): ChatHostLike {
  const handle = new ElementHandle(element)
  const source = element.ownerDocument
  return {
    ownerDocument: source === null ? null : adoptDocument(source),
    attachShadow:
      typeof element.attachShadow === 'function'
        ? (options?: { readonly mode?: 'open' | 'closed' }) => {
            const root = element.attachShadow({ mode: options?.mode ?? 'open' })
            return root === null ? null : new ShadowRootHandle(root)
          }
        : undefined,
    // Arrows, not the handle's own methods: the shell calls these on the object
    // it was handed, and an unbound method would carry the wrong `this`.
    setAttribute: (name: string, value: string) => handle.setAttribute(name, value),
    getAttribute: (name: string) => handle.getAttribute(name),
  }
}
