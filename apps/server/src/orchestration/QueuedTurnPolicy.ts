import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  QUEUED_TURN_MAX_ATTEMPTS,
  type OrchestrationQueuedTurn,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

/**
 * Waking exactly on the provider's reset instant races the limit still being
 * in force, so a queued turn clears it by a minute. Same guard the usage-limit
 * snooze offer uses, kept identical on purpose: two clocks that disagree would
 * show one time and fire at another.
 */
export const QUEUED_TURN_DISPATCH_GRACE_MS = 60_000;

/**
 * How long a dispatched turn is watched for walking straight back into a
 * limit. A provider that is still refusing says so within moments of the
 * turn starting; past the window the dispatch has stuck and the queue record
 * is released, so a limit reported an hour later is a new story, not a retry.
 */
export const QUEUED_TURN_WATCH_WINDOW_MINUTES = 5;
export const QUEUED_TURN_WATCH_WINDOW_MS = QUEUED_TURN_WATCH_WINDOW_MINUTES * 60_000;

/**
 * The instant a queue should fire for a provider reset, with the skew guard,
 * or null when the reset is not a representable time. Null is not "now" and
 * not "never" — callers stop rather than guess a dispatch time.
 */
export function queuedTurnDispatchAfter(resetsAtMs: number): string | null {
  return Option.match(DateTime.make(resetsAtMs + QUEUED_TURN_DISPATCH_GRACE_MS), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

export type QueuedTurnAction =
  /** Due: send it as an ordinary turn. */
  | { readonly kind: "dispatch" }
  /** The dispatch bounced off a fresh limit and may try once more. */
  | { readonly kind: "reschedule"; readonly dispatchAfter: string }
  /** The dispatch bounced and the attempts are spent: stop, stay visible. */
  | { readonly kind: "stall" }
  /** The turn stuck, or the thread it belonged to is gone. */
  | { readonly kind: "release"; readonly reason: "dispatched" | "orphaned" };

type QueuedTurnThread = Pick<OrchestrationThreadShell, "session" | "archivedAt"> & {
  readonly queuedTurn?: OrchestrationQueuedTurn | null | undefined;
};

/** Milliseconds of a limit still in force, or null when there is none. */
function futureResetMs(thread: QueuedTurnThread, now: string): number | null {
  const resetsAt = thread.session?.rateLimitResetsAt;
  if (resetsAt == null) return null;
  const resetsAtMs = Date.parse(resetsAt);
  if (Number.isNaN(resetsAtMs) || resetsAtMs <= Date.parse(now)) return null;
  return resetsAtMs;
}

/**
 * What the server should do with a thread's queued turn right now, or null to
 * leave it alone. Pure so the whole schedule — including the retry cap that
 * stops a limit bouncing forever — is decided in one testable place.
 *
 * A thread whose session has gone away keeps its queued turn: the session is
 * recreated on the next turn, and the dispatch is what recreates it. Only a
 * thread that is archived or deleted has genuinely lost its way home.
 */
export function decideQueuedTurnAction(
  thread: QueuedTurnThread,
  now: string,
): QueuedTurnAction | null {
  const queuedTurn = thread.queuedTurn;
  if (queuedTurn == null) return null;
  if (thread.archivedAt !== null) return { kind: "release", reason: "orphaned" };

  const nowMs = Date.parse(now);
  switch (queuedTurn.state) {
    case "queued": {
      // A limit still in force outranks the schedule: the provider moved the
      // reset out, so wait for the new one rather than sending into a refusal.
      if (futureResetMs(thread, now) !== null) return null;
      return Date.parse(queuedTurn.readyAt) <= nowMs ? { kind: "dispatch" } : null;
    }
    case "awaiting": {
      const resetsAtMs = futureResetMs(thread, now);
      if (resetsAtMs === null) {
        return Date.parse(queuedTurn.readyAt) <= nowMs
          ? { kind: "release", reason: "dispatched" }
          : null;
      }
      const dispatchAfter =
        queuedTurn.attempts >= QUEUED_TURN_MAX_ATTEMPTS
          ? null
          : queuedTurnDispatchAfter(resetsAtMs);
      // A reset we cannot turn into a dispatch time is not a reason to retry
      // blind: stall and let the user decide, same as a spent retry.
      return dispatchAfter === null ? { kind: "stall" } : { kind: "reschedule", dispatchAfter };
    }
    case "stalled":
      // Terminal by design: the user decides what happens next.
      return null;
  }
}
