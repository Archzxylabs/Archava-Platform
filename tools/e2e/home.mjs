/**
 * The mandatory home-page E2E, driven through the real UI.
 *
 * Every step calls the page the way a visitor does — through `window.archava`,
 * which is the surface the page itself booted — and every assertion reads the
 * document or a real turn outcome. A page that exposed the right functions but
 * rendered or answered nothing would fail this.
 *
 * Run it against a live server: `pnpm dev` in one shell, then
 * `node tools/e2e/home.mjs` in another. `BASE` points it somewhere else,
 * `E2E_SHOTS` moves the screenshots. Exit code 0 means every check passed.
 */

// A CLI's stdout is its report, and its exit code is its verdict; both are Node
// globals, which `no-undef` knows nothing about until they are named here.
/* global process, console */

import { launchDebugBrowser, Session } from './cdp.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'
const SHOTS = process.env.E2E_SHOTS ?? '/tmp/archava-e2e'
const shot = (name) => `${SHOTS}/${name}`
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}
/** A turn, with any rejection surfaced rather than swallowed. */
const ask = (s, q) => s.evaluate(`window.archava.ask(${JSON.stringify(q)})`)
const dom = (s, expression) => s.evaluate(expression)
const line = () => console.log('')

await launchDebugBrowser()

const session = await Session.open(`${BASE}/`)
await session.screenshot(shot('01-home.png'))

/* 1 — /app.js loads, and the page boots ------------------------------------ */
const scripts = await dom(session, 'JSON.stringify([...document.scripts].map(s => s.src))')
record('the page references /app.js', scripts.includes('/app.js'), scripts)
const boot = await dom(session, 'typeof window.archava')
record('the boot produced a page handle', boot === 'object', boot)
const networkFailures = session.network_.filter((n) => n.phase === 'failed')
record(
  'no subresource failed to load',
  networkFailures.length === 0,
  JSON.stringify(networkFailures),
)
record(
  'no console error or exception on load',
  session.console_.length === 0,
  JSON.stringify(session.console_),
)

/* 2 — route, sections, entities, selection and actions reach the graph ------ */
// Asked before the graph is read, so what is read is a page a visitor has
// talked to rather than one that merely booted. What the question answered is
// checked in §9, which asks it again.
await ask(session, 'what can I book this week?')
const graph = JSON.parse(await dom(session, 'JSON.stringify(window.archava.graph())'))
record('the graph names the route', graph.page.route === '/', JSON.stringify(graph.page))
record(
  'the graph names a section',
  typeof graph.page.section === 'string' && graph.page.section.length > 0,
  graph.page.section,
)
record(
  'the graph names the visible entities',
  graph.entities.length === 4,
  graph.entities.map((e) => e.name).join(', '),
)
record(
  'the graph carries the available actions',
  graph.availableActions.length > 0,
  JSON.stringify(graph.availableActions),
)
record('the graph reports no page errors', graph.errors.length === 0, JSON.stringify(graph.errors))

/* 3 — the visitor can open Archava and ask what they are looking at --------- */
const looking = await ask(session, 'What am I looking at?')
const lookingText = await dom(
  session,
  'document.getElementById("archava-chat").shadowRoot.textContent',
)
const names = graph.entities.map((e) => e.name)
const namesPage = names.filter((n) => lookingText.includes(n))
record(
  'the answer reflects what is actually on the page',
  namesPage.length > 0,
  `named: ${namesPage.join(', ')} | answered: ${(looking.text ?? '').slice(0, 120)}`,
)
record('the answer is not an apology', looking.knowledgeGap !== true, `basis=${looking.basis}`)

/* 4 — ask to compare two offerings ----------------------------------------- */
const compare = await ask(session, 'compare the first two rooms')
const compareAction = (compare.actions ?? []).find((a) => a.policy !== 'denied')
record(
  'a comparison was offered through the real pipeline',
  compareAction !== undefined,
  JSON.stringify(compare.actions),
)

/* 5 — an allowed action visibly changes the page --------------------------- */
const beforeMark = await dom(
  session,
  'JSON.stringify([...document.querySelectorAll("[data-archava-current]")].map(e => e.id))',
)
const highlight = await ask(session, 'highlight the first room')
const highlightAction = (highlight.actions ?? []).find((a) => a.actionId === 'ui.highlight')
const afterMark = await dom(
  session,
  'JSON.stringify([...document.querySelectorAll("[data-archava-current]")].map(e => e.id))',
)
record(
  'an allowed action visibly changes the page',
  highlightAction !== undefined &&
    highlightAction.policy === 'allowed' &&
    highlightAction.execution === 'succeeded',
  JSON.stringify(highlightAction),
)
record(
  'the executor ran and the page changed',
  afterMark !== beforeMark && afterMark.length > 0,
  `${beforeMark} → ${afterMark}`,
)

/* 6 — a confirmation-required action does not execute ---------------------- */
const panelShape = () =>
  'JSON.stringify({name: document.getElementById("panel").getAttribute("data-archava-panel"), hidden: document.getElementById("panel").hidden, text: document.getElementById("panel").textContent})'
const panelBeforeBooking = await dom(session, panelShape())
const held = await ask(session, 'book the garden twin room for me')
const heldAction = (held.actions ?? []).find((a) => a.actionId === 'booking.create')
record(
  'the booking came back confirmation_required and did not run',
  heldAction?.policy === 'confirmation_required' && heldAction?.execution === 'not_attempted',
  JSON.stringify(heldAction),
)
const panelAfterBooking = await dom(session, panelShape())
record(
  'nothing was booked before confirmation',
  panelAfterBooking === panelBeforeBooking &&
    !/booked|reserved|confirmation number|booking reference/i.test(
      JSON.parse(panelAfterBooking).text,
    ),
  panelAfterBooking,
)
const confirmed = await ask(session, 'yes, go ahead', [])
const panelAfterConfirm = await dom(session, panelShape())
record(
  'a bare "yes" carrying no confirmed ids executes nothing',
  panelAfterConfirm === panelAfterBooking &&
    (confirmed.actions ?? []).every((a) => a.execution !== 'succeeded'),
  `${confirmed.actions?.length ?? 0} actions, ${panelAfterConfirm}`,
)

/* 7 — a request above the configured capability is denied ------------------ */
const over = await ask(session, 'take my payment now')
const denied = (over.actions ?? []).find((a) => a.policy === 'denied')
record('the over-capability action was denied', denied !== undefined, JSON.stringify(denied))
record(
  'the denied action never reached the executor',
  denied?.execution === 'not_attempted',
  `execution=${denied?.execution}`,
)
// The reason names the capability, not the page. The reference tenant is `act` and
// `payment.initiate` needs `transact`, so §18 step 4 fires before the page check at
// step 6. An earlier defect passed the page's action list to the gate as the client
// allow-list, so this same request was reported as `action_disabled_for_client` — a
// client-config denial that could never fire for the client it was asked about.
record(
  'the denial blames the capability, not the page',
  /transact/.test(denied?.reason ?? '') && /act/.test(denied?.reason ?? ''),
  denied?.reason ?? '',
)

/* 8 — a structured-truth query, through the real UI ------------------------ */
const price = await ask(session, 'how much does it cost per night?')
record(
  'the live price question answered with structured truth',
  price.basis === 'structured_truth',
  `basis=${price.basis}`,
)
const money = (price.text ?? '').match(/IDR [\d,.]+/g) ?? []
record('the answer carries real numbers', money.length > 0, money.slice(0, 3).join(', '))
record(
  'no retrieval chunk stood in for the price',
  price.citations.length === 0,
  JSON.stringify(price.citations),
)

/* 9 — stale retrieval cannot override the authoritative answer ------------- */
const idr = await ask(session, 'berapa harga satu malam?')
record(
  'the Indonesian price question is also structured truth',
  idr.basis === 'structured_truth',
  `basis=${idr.basis}`,
)
const availability = await ask(session, 'what can I book this week?')
record(
  'availability answered from live truth, not retrieval',
  availability.basis === 'structured_truth' && availability.citations.length === 0,
  `basis=${availability.basis} citations=${availability.citations.length}`,
)
const stock = await ask(session, 'how many rooms do you have?')
record(
  'stock answered from live truth, not retrieval',
  stock.basis === 'structured_truth',
  `basis=${stock.basis}`,
)
record(
  'the bare duration question is not dressed up as stock',
  (await ask(session, 'how many nights can I stay?')).basis === 'retrieval',
)
record(
  'an unresolved booking status is not invented',
  (await ask(session, 'is my booking confirmed?')).basis === 'none',
)

/* 10 — logs and console ---------------------------------------------------- */
const cancellations = await ask(session, 'what is your cancellation policy?')
record(
  'the cancellation policy is still retrieval knowledge',
  cancellations.basis === 'retrieval',
  `basis=${cancellations.basis} citations=${JSON.stringify(cancellations.citations)}`,
)
await session.screenshot(shot('99-final.png'))
const errors = session.console_.filter((c) => c.kind === 'error' || c.kind === 'exception')
record(
  'no console error or exception after every turn',
  errors.length === 0,
  JSON.stringify(errors),
)
record(
  'no subresource failed across the session',
  session.network_.filter((n) => n.phase === 'failed').length === 0,
  '',
)

await session.close()
line()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
for (const f of failed) console.log(`  FAIL ${f.name}\n       ${f.detail}`)
line()
if (failed.length > 0) process.exitCode = 1
