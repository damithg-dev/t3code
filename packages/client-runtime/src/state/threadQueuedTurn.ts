// @effect-diagnostics globalDate:off -- composer labels and the queue offer
// work in wall-clock ISO strings, matching thread-settled's snooze helpers.
import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Waking exactly at the provider's reset instant races the limit still being
 * in force, so a queued turn clears it by a minute. Must stay identical to
 * the server's QUEUED_TURN_DISPATCH_GRACE_MS: the label the user reads and
 * the time the server fires at come from these two constants.
 */
export const QUEUED_TURN_DISPATCH_GRACE_MS = 60_000;

/**
 * Providers whose usage limits carry a reset time we can queue against.
 * Claude and Codex report a structured reset epoch; Cursor, Grok and
 * OpenCode report nothing usable, so a thread on those never offers a queue
 * — not "queue for an unknown time", which is what a shared default would
 * quietly become.
 */
const QUEUEABLE_PROVIDERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function providerSupportsLimitQueue(providerName: string | null | undefined): boolean {
  return providerName != null && QUEUEABLE_PROVIDERS.has(providerName);
}

export interface QueueForLimitResetOffer {
  /** The reset the provider reported, for the "limits reset at" label. */
  readonly resetsAt: string;
  /** When the server will send the turn: the reset plus the skew guard. */
  readonly dispatchAfter: string;
}

type QueueOfferShell = Pick<OrchestrationThreadShell, "session" | "archivedAt">;

/**
 * The queue offer for a thread, or null when the composer must keep its
 * ordinary send.
 *
 * Null covers three different absences on purpose, and none of them may
 * become a queue: no reset reported, a reset already in the past (stale
 * provider state), and a reset we cannot read. An unreadable time is not a
 * time — offering "Queue for Invalid Date" would be worse than no offer.
 */
export function queueForLimitResetOffer(
  shell: QueueOfferShell,
  options: { readonly now: string },
): QueueForLimitResetOffer | null {
  if (shell.archivedAt !== null) return null;
  const session = shell.session;
  if (session == null || !providerSupportsLimitQueue(session.providerName)) return null;
  const resetsAt = session.rateLimitResetsAt;
  if (resetsAt == null) return null;
  const resetsAtMs = Date.parse(resetsAt);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(resetsAtMs) || Number.isNaN(nowMs) || resetsAtMs <= nowMs) return null;
  return {
    resetsAt,
    dispatchAfter: new Date(resetsAtMs + QUEUED_TURN_DISPATCH_GRACE_MS).toISOString(),
  };
}

/**
 * What the composer notice says about a turn already in the queue. Derived
 * rather than stored so a queue that has quietly stalled cannot keep
 * claiming it is about to send.
 */
export type QueuedTurnStatus = "waiting" | "sending" | "stalled";

export function queuedTurnStatus(
  queuedTurn: NonNullable<OrchestrationThreadShell["queuedTurn"]>,
): QueuedTurnStatus {
  switch (queuedTurn.state) {
    case "queued":
      return "waiting";
    case "awaiting":
      return "sending";
    case "stalled":
      return "stalled";
  }
}

/**
 * A queued turn carries text only: attachments ride the upload path that
 * exists for a live turn and nothing else, and pasted contexts are snapshots
 * of state that will have moved on by the time limits reset. A draft carrying
 * either keeps its ordinary send.
 *
 * Shared by the composer that draws the button and the handler that acts on
 * it, so the label and the action cannot disagree about what happens next.
 */
export function draftCanBeQueued(input: {
  readonly attachmentCount: number;
  readonly contextCount: number;
}): boolean {
  return input.attachmentCount === 0 && input.contextCount === 0;
}
