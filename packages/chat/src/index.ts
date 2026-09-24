/**
 * `@archava/chat` — a decided turn, as a shadow-root chat shell.
 *
 * The package is the seam PRD §24 describes and nothing more. `view.ts` turns a
 * `TurnOutcome` into blocks; `styles.ts` turns a tenant's palette into a
 * stylesheet; `dom.ts` puts both inside a shadow root. A host calls `mount()`
 * once and `show(outcome)` per turn; everything the visitor reads was decided
 * upstream (§16–§18), and nothing here re-decides it.
 *
 * Deliberately absent: a framework. The shell manipulates a DOM through a small
 * structural interface, the same way the SDK does, so a host can wrap `mount` in
 * React, Vue or plain script without this package caring which. The
 * view-model layer is UI-library-agnostic for the same reason.
 */

export type { Branding } from '@archava/config'

export type {
  AnswerBasis,
  GenerativeComponent,
  GenerativeComponentKind,
  TurnOutcome,
} from '@archava/assistant'

export {
  describeBlock,
  toChatMessages,
  type BannerTone,
  type ChatBlock,
  type ChatMessage,
  type ChatViewOptions,
  type TruthRow,
  type TurnCitation,
} from './view.js'

export { formatMoney, MoneyFormatError, currencyFractionDigits } from './money.js'

export { chatSheet } from './styles.js'

export {
  mount,
  ChatEnvironmentError,
  ChatMountError,
  type ChatDocumentLike,
  type ChatEvent,
  type ChatEventLike,
  type ChatHandle,
  type ChatHostLike,
  type ChatMountOptions,
  type ChatNodeLike,
  type ChatRootLike,
} from './dom.js'
