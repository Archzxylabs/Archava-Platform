/**
 * Embodiment: how the assistant is rendered.
 *
 * PRD §21 is explicit that this is a replaceable adapter — a default human
 * renderer with a premium option behind the same seam — and that the vendor's
 * name must not leak: "Spatius must not be hardcoded outside the provider
 * adapter." So this port describes *what a renderer must be able to do*, and any
 * number of them can satisfy it behind `providerId`.
 *
 * The port is split in two, on purpose:
 *
 * - `HumanRenderer` — the capability surface, which is what a session asks for;
 * - `preflightRenderer` — the readiness gate, which runs *before* a session asks
 *   for anything.
 *
 * Keeping them separate is what makes the Human → Voice → Chat fallback a rule
 * the platform can apply (in `presence.ts`) instead of something each renderer
 * has to remember to implement correctly. A renderer that cannot preflight is a
 * renderer that cannot be trusted to run.
 */

import type { EmbodimentPreflight, PreflightResult } from './presence.js'

/** What a session may ask a human renderer to do. */
export interface HumanRenderer {
  readonly providerId: string
  /**
   * Open a session. Returns a session id the caller holds; no credential ever
   * crosses this boundary (§24), the renderer holds its own.
   */
  openSession(request: RendererSessionRequest): RendererSession
  /** Send the assistant's spoken line and its on-screen transcript. */
  speak(sessionId: string, utterance: RenderedUtterance): void
  /** Tear the session down and release the renderer's resources. */
  close(sessionId: string): void
}

export interface RendererSessionRequest {
  readonly tenantId: string
  readonly locale: string
  /** Display name for the assistant; comes from the client's branding. */
  readonly personaName: string
}

export interface RendererSession {
  readonly sessionId: string
  readonly providerId: string
}

export interface RenderedUtterance {
  /** What the visitor sees. Always present, even in human mode. */
  readonly transcript: string
  /** What the visitor hears. Absent for a silent/prose-only mode. */
  readonly spoken: string | null
}

export class RendererError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RendererError'
  }
}

/**
 * Build the preflight a presence selector can consume.
 *
 * The four checks are PRD §21's list verbatim: renderer support, network
 * reachability, session token/bootstrap, performance readiness. The adapter
 * measures its own environment and reports each one here; the platform decides
 * what to do about it (`presence.ts`), which is what keeps the fallback rule in
 * one place instead of once per renderer.
 */
export function preflightRenderer(
  providerId: string,
  mode: 'human' | 'voice',
  results: readonly PreflightResult[],
): EmbodimentPreflight {
  return { providerId, mode, results }
}
