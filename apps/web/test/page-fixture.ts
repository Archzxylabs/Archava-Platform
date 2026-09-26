/**
 * A page, built from its own markup.
 *
 * A browser is where this pipeline really runs — `tools/e2e/home.mjs` drives a
 * real one — but a package test has no window to hand it, and a stub that
 * answers `null` to every query is worse than no stub at all: the scout reads
 * "no entities", the gate answers `action_unavailable_on_page`, and every
 * assertion below it becomes a tautology by way of a denial. So this parses the
 * tenant's own `surfaceMarkup` into nodes with attributes, text and state, and
 * serves the two calls every reader in the path asks for — `querySelector` and
 * `querySelectorAll`.
 *
 * It covers the subset of HTML the surface actually emits: nested elements,
 * quoted and bare attributes, boolean attributes, void elements, and text. It
 * is not an HTML implementation and does not try to be. Anything it does not
 * recognise stays text, which a scout reports as nothing to read rather than
 * crashing on.
 */
import type { ScoutDocument, ScoutNode, ScoutNodeList } from '@archava/sdk'

/** One attribute pair, the shape `getNamedItem` hands back. */
interface NamedNodeMapLike {
  readonly values: Map<string, string>
  getNamedItem(name: string): { readonly value: string } | null
  item(index: number): { readonly value: string } | null
  readonly length: number
  /** The same pairs, reachable by index — how the DOM enumerates them. */
  [index: number]: { readonly value: string }
}

/**
 * Read an attribute as `getNamedItem` would.
 *
 * An attribute present with an empty value is still read — `hidden` and
 * `checked` are written that way — but an attribute that is *absent* hands back
 * `null`, which is the distinction that keeps "no value" from meaning "not
 * there".
 */
function readAttribute(
  values: Map<string, string>,
  name: string,
): { readonly value: string } | null {
  const value = values.get(name)
  return value === undefined ? null : { value }
}

/** Tags that never have a closing tag, so a parser must not wait for one. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

/**
 * Nodes as a `NodeList` hands them over.
 *
 * A `NodeList` is not an array: it carries its nodes *by index* as well as behind
 * `length` and `item`, and a reader that walks it by number — which is what the
 * scout does, for the fields scoped inside one form — would see an array's
 * `length` and nothing else. The fixture answers the way a browser does, so the
 * reader under test is the one that runs in production.
 */
function toNodeList(nodes: readonly FakeNode[]): ScoutNodeList {
  const byIndex: Record<number, ScoutNode> = {}
  nodes.forEach((node, index) => {
    byIndex[index] = node
  })
  return { length: nodes.length, item: (index: number) => byIndex[index] ?? null, ...byIndex }
}

/** One start or end tag, with its name and its attributes. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/g

/** One attribute inside a start tag: `name`, `name="value"`, `name='value'`, `name=value`. */
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

/** A node the surface's own markup produced. */
export class FakeNode {
  readonly tagName: string
  readonly children: Array<FakeNode | string> = []
  parent: FakeNode | null = null
  /** Whether the control reports itself ticked. `checked` in the markup sets it. */
  checked = false
  /** Whether the control reports itself unusable. `disabled` in the markup sets it. */
  disabled = false

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get id(): string {
    return this.attributes.getNamedItem('id')?.value ?? ''
  }

  /**
   * The attributes, in the DOM's own dialect.
   *
   * The scout reads `attributes.getNamedItem(name).value` and nothing else, so a
   * fixture that handed it a `Map` would be a different page than the one a
   * browser mounts. `NamedNodeMap` is what the contract says, and keeping it here
   * is what lets the test talk to the real `observe()` rather than a stand-in
   * shaped like what the test wishes the SDK asked for.
   */
  readonly attributes: NamedNodeMapLike = {
    values: new Map<string, string>(),
    getNamedItem(name: string) {
      return readAttribute(this.values, name)
    },
    item(index: number) {
      const name = [...this.values.keys()][index]
      return name === undefined ? null : readAttribute(this.values, name)
    },
    get length() {
      return this.values.size
    },
  }

  get textContent(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  }

  getAttribute(name: string): string | null {
    return this.attributes.getNamedItem(name)?.value ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.values.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.values.delete(name)
  }

  /**
   * `hidden` is a property on a real element and an attribute on a real
   * document, and they are one fact: an element the page shows is one without
   * it. Writing one has to write the other, or the panel would tell the
   * executor it was open while the selector the scout reads still said it was
   * shut — and the graph would describe the page the visitor is not looking at.
   */
  get hidden(): boolean {
    return this.attributes.values.has('hidden')
  }

  set hidden(value: boolean) {
    if (value) this.attributes.values.set('hidden', '')
    else this.removeAttribute('hidden')
  }

  // Two arrow functions rather than two closures over an alias: they read `this`
  // lexically, so there is no local copy of the node to go stale.
  get classList(): { add(name: string): void; remove(name: string): void } {
    return {
      add: (name: string) => {
        const held = new Set(
          (this.attributes.values.get('class') ?? '').split(/\s+/).filter(Boolean),
        )
        held.add(name)
        this.setAttribute('class', [...held].join(' '))
      },
      remove: (name: string) => {
        const held = new Set(
          (this.attributes.values.get('class') ?? '').split(/\s+/).filter(Boolean),
        )
        held.delete(name)
        this.setAttribute('class', [...held].join(' '))
      },
    }
  }

  scrollIntoView(): void {}

  /** Everything at or below this node matching `selectors`, in document order. */
  private matching(selectors: string): readonly FakeNode[] {
    const wanted = parseCompound(selectors)
    if (wanted === null) return []
    const found: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (typeof child === 'string') continue
        if (matches(child, wanted)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  /**
   * The answer in the DOM's own dialect.
   *
   * A `NodeList` is not an array: it carries its nodes *by index* as well as
   * behind `length` and `item`, and a reader that walks it by number — which is
   * what the scout does, for the fields inside one form — would see a real
   * array's `length` and nothing else. The fields the scout reads are scoped to
   * their form, so a node has to answer the same way a document does.
   */
  querySelectorAll(selectors: string): ScoutNodeList {
    return toNodeList(this.matching(selectors))
  }

  querySelector(selectors: string): FakeNode | null {
    return this.matching(selectors)[0] ?? null
  }

  /** Replace this node's children, the way assigning `innerHTML` does. */
  set innerHTML(markup: string) {
    const parsed = parseFragment(markup)
    for (const node of parsed) node.parent = this
    this.children.length = 0
    this.children.push(...parsed)
  }

  appendChild(child: FakeNode): FakeNode {
    child.parent = this
    this.children.push(child)
    return child
  }
}

/** One simple selector: a tag, an id, a class, an attribute, a pseudo-class. */
interface Simple {
  readonly tag?: string
  readonly id?: string
  readonly classes: readonly string[]
  readonly attributes: readonly { readonly name: string; readonly value?: string }[]
  readonly checked?: boolean
  readonly notHidden?: boolean
}

/**
 * Parse a compound selector. `null` means this page cannot answer it, which is
 * the fail-closed answer: a selector the page does not understand matches
 * nothing, exactly as a page that had never implemented it would.
 */
function parseCompound(selectors: string): readonly Simple[] | null {
  const parsed: Simple[] = []
  for (const part of selectors.trim().split(/\s+/)) {
    const simple = parseSimple(part)
    if (simple === null) return null
    parsed.push(simple)
  }
  return parsed
}

const PIECE = /[.#][^.#:[\]]+|\[[^\]]*\]|:[a-zA-Z-]+(?:\([^)]*\))?/g
const HEAD = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][^.#:[\]]+|\[[^\]]*\]|:[a-zA-Z-]+(?:\([^)]*\))?)*)$/

function parseSimple(part: string): Simple | null {
  const hit = HEAD.exec(part)
  if (hit === null) return null
  const tag = hit[1]?.toLowerCase()
  const classes: string[] = []
  const ids: string[] = []
  const attributes: { name: string; value?: string }[] = []
  let checked = false
  let notHidden: boolean | undefined
  for (const piece of hit[2] === undefined || hit[2].length === 0
    ? []
    : (hit[2].match(PIECE) ?? [])) {
    if (piece.startsWith('.')) {
      classes.push(piece.slice(1))
      continue
    }
    if (piece.startsWith('#')) {
      ids.push(piece.slice(1))
      continue
    }
    if (piece.startsWith('[')) {
      const inner = piece.slice(1, -1)
      const at = inner.indexOf('=')
      if (at === -1) {
        attributes.push({ name: inner })
        continue
      }
      attributes.push({
        name: inner.slice(0, at).trim(),
        value: inner
          .slice(at + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      })
      continue
    }
    if (piece === ':checked') checked = true
    else if (piece === ':hidden') notHidden = false
    else if (piece === ':not([hidden])') notHidden = true
    else return null
  }
  return {
    ...(tag === undefined ? {} : { tag }),
    ...(ids[0] === undefined ? {} : { id: ids[0] }),
    classes,
    attributes,
    checked,
    ...(notHidden === undefined ? {} : { notHidden }),
  }
}

/**
 * Whether `node` matches a chain of simple selectors.
 *
 * The chain is read right to left against the node and its ancestors, closest
 * first — which is the only combinator this page has: `form[data-archava-form]
 * [name]` and `[data-archava-panel]:not([hidden])` are the two that need it. A
 * descendancy walk, so the rightmost part must sit on the node itself.
 */
function matches(node: FakeNode, wanted: readonly Simple[]): boolean {
  const chain: FakeNode[] = []
  let current: FakeNode | null = node
  while (current !== null) {
    chain.push(current)
    current = current.parent
  }
  let at = 0
  let want = wanted.length - 1
  while (want >= 0) {
    // A chain shorter than the selector is a selector this page cannot answer.
    const node = chain[at]
    const simple = wanted[want]
    if (node === undefined || simple === undefined) return false
    if (matchesOne(node, simple)) {
      at += 1
      want -= 1
    } else {
      at += 1
    }
  }
  return true
}

function matchesOne(node: FakeNode, wanted: Simple): boolean {
  if (wanted.tag !== undefined && node.tagName.toLowerCase() !== wanted.tag) return false
  if (wanted.id !== undefined && node.id !== wanted.id) return false
  for (const name of wanted.classes) {
    if (!(node.attributes.values.get('class') ?? '').split(/\s+/).includes(name)) return false
  }
  for (const attribute of wanted.attributes) {
    if (!node.attributes.values.has(attribute.name)) return false
    if (
      attribute.value !== undefined &&
      node.attributes.values.get(attribute.name) !== attribute.value
    )
      return false
  }
  if (wanted.checked === true && node.checked !== true) return false
  if (wanted.notHidden === true && node.attributes.values.has('hidden')) return false
  return true
}

/** Parse a fragment into nodes, in source order. */
function parseFragment(markup: string): readonly FakeNode[] {
  const root = new FakeNode('#fragment')
  const stack: FakeNode[] = [root]
  let cursor = 0
  for (let hit = TAG.exec(markup); hit !== null; hit = TAG.exec(markup)) {
    const text = markup.slice(cursor, hit.index)
    // Every match carries a tag and its attributes; the group that a real tag
    // leaves out is the optional trailing slash, which is what tells the parser
    // not to wait for a close.
    const [, closing, tagName, rawAttributes, selfClosing] = hit
    if (tagName === undefined || rawAttributes === undefined) continue
    const open = stack[stack.length - 1]
    if (open !== undefined && text.trim().length > 0) {
      open.children.push(text.replace(/\s+/g, ' ').trim())
    }
    cursor = hit.index + hit[0].length
    if (closing !== undefined && closing.length > 0) {
      const closing_name = tagName.toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.tagName === closing_name) {
          stack.length = depth
          break
        }
      }
      continue
    }
    const node = new FakeNode(tagName.toLowerCase())
    for (
      let attribute = ATTRIBUTE.exec(rawAttributes);
      attribute !== null;
      attribute = ATTRIBUTE.exec(rawAttributes)
    ) {
      const [, name, doubleQuoted, singleQuoted, bare] = attribute
      if (name === undefined) continue
      const value = doubleQuoted ?? singleQuoted ?? bare
      if (value === undefined) {
        // A boolean attribute: `hidden`, `checked`, `disabled`. The property it
        // drives is set from it, because the executor reads `checked` and the
        // scout reads `:checked`, and a node with only one of the two would
        // disagree with the reader that needs the other.
        if (name === 'checked') node.checked = true
        if (name === 'disabled') node.disabled = true
        node.attributes.values.set(name, '')
        continue
      }
      node.attributes.values.set(name, value)
    }
    if (open !== undefined) open.appendChild(node)
    // A void tag waits for no close, and a self-closing one asked not to; both
    // are nodes the stack does not grow for.
    if (!VOID_TAGS.has(node.tagName) && (selfClosing ?? '').length === 0) stack.push(node)
  }
  return root.children.filter((child): child is FakeNode => typeof child !== 'string')
}

/** The page a test mounts into. */
export class FakePage implements ScoutDocument {
  readonly location = { pathname: '/' }
  readonly documentElement = { lang: 'en' }
  readonly body = new FakeNode('body')

  querySelector(selectors: string): FakeNode | null {
    return this.body.querySelector(selectors)
  }

  querySelectorAll(selectors: string): ScoutNodeList {
    return this.body.querySelectorAll(selectors)
  }
}
