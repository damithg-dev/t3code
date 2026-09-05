import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationQueuedTurn,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decideQueuedTurnAction,
  QUEUED_TURN_DISPATCH_GRACE_MS,
  queuedTurnDispatchAfter,
} from "./QueuedTurnPolicy.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PAST = "2025-12-31T23:00:00.000Z";
const FUTURE = "2026-01-01T05:00:00.000Z";

function session(rateLimitResetsAt: string | null): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "ready",
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    rateLimitResetsAt,
    updatedAt: NOW,
  };
}

function queuedTurn(overrides: Partial<OrchestrationQueuedTurn> = {}): OrchestrationQueuedTurn {
  return {
    messageId: MessageId.make("message-1"),
    text: "keep going",
    runtimeMode: "full-access",
    interactionMode: "default",
    state: "queued",
    readyAt: PAST,
    attempts: 0,
    queuedAt: PAST,
    updatedAt: PAST,
    ...overrides,
  };
}

function thread(input: {
  readonly queuedTurn?: OrchestrationQueuedTurn | null;
  readonly resetsAt?: string | null;
  readonly archivedAt?: string | null;
}) {
  return {
    session: session(input.resetsAt === undefined ? null : input.resetsAt),
    archivedAt: input.archivedAt ?? null,
    queuedTurn: input.queuedTurn ?? null,
  };
}

describe("queuedTurnDispatchAfter", () => {
  it("clears the reported reset by the skew guard", () => {
    expect(queuedTurnDispatchAfter(Date.parse(FUTURE))).toBe("2026-01-01T05:01:00.000Z");
    expect(QUEUED_TURN_DISPATCH_GRACE_MS).toBe(60_000);
  });

  // A reset we cannot represent is not a dispatch time. Callers must see the
  // absence rather than a silently substituted one.
  it("returns null for an unrepresentable instant", () => {
    expect(queuedTurnDispatchAfter(Number.NaN)).toBeNull();
    expect(queuedTurnDispatchAfter(8.64e15)).toBeNull();
  });
});

describe("decideQueuedTurnAction", () => {
  it("does nothing for a thread with nothing queued", () => {
    expect(decideQueuedTurnAction(thread({}), NOW)).toBeNull();
  });

  it("dispatches a queued turn once its time has come", () => {
    expect(decideQueuedTurnAction(thread({ queuedTurn: queuedTurn() }), NOW)).toEqual({
      kind: "dispatch",
    });
  });

  it("waits while the queued turn is not due yet", () => {
    expect(
      decideQueuedTurnAction(thread({ queuedTurn: queuedTurn({ readyAt: FUTURE }) }), NOW),
    ).toBeNull();
  });

  // The provider moved its reset out while the turn sat in the queue; sending
  // into a limit that is still in force would just spend an attempt.
  it("holds a due queued turn while a limit is still in force", () => {
    expect(
      decideQueuedTurnAction(thread({ queuedTurn: queuedTurn(), resetsAt: FUTURE }), NOW),
    ).toBeNull();
  });

  it("keeps watching a dispatched turn inside its window", () => {
    expect(
      decideQueuedTurnAction(
        thread({ queuedTurn: queuedTurn({ state: "awaiting", attempts: 1, readyAt: FUTURE }) }),
        NOW,
      ),
    ).toBeNull();
  });

  it("releases a dispatched turn that survived its window", () => {
    expect(
      decideQueuedTurnAction(
        thread({ queuedTurn: queuedTurn({ state: "awaiting", attempts: 1, readyAt: PAST }) }),
        NOW,
      ),
    ).toEqual({ kind: "release", reason: "dispatched" });
  });

  it("re-queues a dispatched turn that hit a fresh limit, once", () => {
    expect(
      decideQueuedTurnAction(
        thread({
          queuedTurn: queuedTurn({ state: "awaiting", attempts: 1, readyAt: FUTURE }),
          resetsAt: FUTURE,
        }),
        NOW,
      ),
    ).toEqual({ kind: "reschedule", dispatchAfter: queuedTurnDispatchAfter(Date.parse(FUTURE)) });
  });

  it("stalls rather than retrying a second time", () => {
    expect(
      decideQueuedTurnAction(
        thread({
          queuedTurn: queuedTurn({ state: "awaiting", attempts: 2, readyAt: FUTURE }),
          resetsAt: FUTURE,
        }),
        NOW,
      ),
    ).toEqual({ kind: "stall" });
  });

  it("leaves a stalled turn alone forever", () => {
    expect(
      decideQueuedTurnAction(
        thread({
          queuedTurn: queuedTurn({ state: "stalled", attempts: 2 }),
          resetsAt: FUTURE,
        }),
        NOW,
      ),
    ).toBeNull();
  });

  // The thread the queue belonged to is gone: drop it visibly, never send.
  it("orphans a queued turn on an archived thread", () => {
    expect(
      decideQueuedTurnAction(thread({ queuedTurn: queuedTurn(), archivedAt: NOW }), NOW),
    ).toEqual({ kind: "release", reason: "orphaned" });
  });

  // A session between provider runs is normal — the dispatch is what starts
  // the next one — so a missing session must not be read as "limit cleared"
  // nor as "thread gone".
  it("dispatches a due turn on a thread with no session", () => {
    expect(
      decideQueuedTurnAction({ session: null, archivedAt: null, queuedTurn: queuedTurn() }, NOW),
    ).toEqual({ kind: "dispatch" });
  });

  // An unreadable reset is not a cleared reset. It must not let the schedule
  // fall through into a send, and it must not fake a retry time either.
  it("treats an unparseable reset as no limit rather than a value", () => {
    const unreadable = { ...session("not-a-date"), rateLimitResetsAt: "not-a-date" };
    expect(
      decideQueuedTurnAction(
        { session: unreadable, archivedAt: null, queuedTurn: queuedTurn() },
        NOW,
      ),
    ).toEqual({ kind: "dispatch" });
    expect(
      decideQueuedTurnAction(
        {
          session: unreadable,
          archivedAt: null,
          queuedTurn: queuedTurn({ state: "awaiting", attempts: 1, readyAt: FUTURE }),
        },
        NOW,
      ),
    ).toBeNull();
  });
});
