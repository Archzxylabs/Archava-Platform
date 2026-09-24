/**
 * The browser entry point: mount the page, and hand it a clock.
 *
 * The page takes its clock from `window` rather than creating one, and the
 * reason is §16: a turn carries the time the visitor actually acted. Reading
 * `new Date()` at import time would stamp every turn on a bundle with the time
 * the bundle loaded, which is a claim about the visitor that no one made.
 *
 * Everything else is delegated. This file holds no policy, no masking, and no
 * drawing — it is the smallest amount of DOM a real page needs, so that a
 * browser runs the same wiring the tests do rather than a parallel copy.
 */
import { domHost } from './dom-bridge.js'
import { mountSlicePage } from './page.js'

const host = document.getElementById('archava-chat')
if (host === null) {
  throw new Error('missing #archava-chat; the page has nowhere to draw the shell')
}

const page = mountSlicePage({
  host: domHost(host),
  document,
  route: window.location.pathname,
  now: () => new Date().toISOString(),
  inspect: new URLSearchParams(window.location.search).has('inspect'),
})

// A page that grants context consent can answer; a page that has not still
// runs, and the SDK records the notice that says so. The grant is here because
// a demo page with no consent step should be a demo page that says it granted
// one, not one that quietly skipped asking.
page.sdk.grant('page_context')

// The surface's controls are shortcuts for a sentence, and that is all they are.
//
// `data-ask` carries what the visitor would have typed; the click hands that
// string to the same `ask` the chat shell hands a submitted message to. So the
// request travels the whole path again — brain, gate, §9 validation, executor —
// and a click gets no privilege a typed sentence lacks. A button that ran the
// action itself would be a second gate, and the one on this page is the only
// one anybody tests (§18).
//
// The listener is delegated from the document rather than bound per card,
// because the page redraws its cards and a card's button should not outlive it.
document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest('[data-ask]')
  if (!(button instanceof HTMLButtonElement)) return
  const utterance = button.dataset.ask
  if (utterance === undefined || utterance === '') return
  void page.ask(utterance)
})

declare global {
  interface Window {
    archava?: typeof page
  }
}

// Exposed for the §16 inspector and for anyone poking at the console to see
// what the pipeline decided. Not a public API; a debugging affordance.
window.archava = page
