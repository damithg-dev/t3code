import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PAST = "2025-12-31T23:00:00.000Z";
const FUTURE = "2026-01-01T05:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("message-1");

function makeSession(rateLimitResetsAt: string | null): OrchestrationSession {
  return {
    threadId: THREAD_ID,
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

function makeQueuedTurn(overrides: Partial<OrchestrationQueuedTurn> = {}): OrchestrationQueuedTurn {
  return {
    messageId: MESSAGE_ID,
    text: "keep going",
    runtimeMode: "full-access",
    interactionMode: "default",
    state: "queued",
    readyAt: FUTURE,
    attempts: 0,
    queuedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReadModel(input: {
  readonly queuedTurn?: OrchestrationQueuedTurn | null;
  readonly session?: OrchestrationSession | null;
  readonly archivedAt?: string | null;
  readonly settledOverride?: OrchestrationThread["settledOverride"];
  readonly snoozedUntil?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        worktrees: [],
        latestTurn: null,
        createdAt: PAST,
        updatedAt: PAST,
        archivedAt: input.archivedAt ?? null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledOverride === "settled" ? PAST : null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedUntil == null ? null : PAST,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session === undefined ? makeSession(FUTURE) : input.session,
        queuedTurn: input.queuedTurn ?? null,
      },
    ],
    updatedAt: NOW,
  };
}

function queueCommand(dispatchAfter: string, text = "keep going") {
  return {
    type: "thread.turn.queue",
    commandId: CommandId.make("cmd-queue"),
    threadId: THREAD_ID,
    message: { messageId: MESSAGE_ID, text },
    runtimeMode: "full-access",
    interactionMode: "default",
    dispatchAfter,
    createdAt: NOW,
  } as const;
}

const dequeueCommand = {
  type: "thread.turn.dequeue",
  commandId: CommandId.make("cmd-dequeue"),
  threadId: THREAD_ID,
  createdAt: NOW,
} as const;

const dispatchCommand = {
  type: "thread.queued-turn.dispatch",
  commandId: CommandId.make("cmd-dispatch"),
  threadId: THREAD_ID,
  createdAt: NOW,
} as const;

function rescheduleCommand(dispatchAfter: string | null) {
  return {
    type: "thread.queued-turn.reschedule",
    commandId: CommandId.make("cmd-reschedule"),
    threadId: THREAD_ID,
    dispatchAfter,
    createdAt: NOW,
  } as const;
}

function releaseCommand(reason: "dispatched" | "orphaned") {
  return {
    type: "thread.queued-turn.release",
    commandId: CommandId.make("cmd-release"),
    threadId: THREAD_ID,
    reason,
    createdAt: NOW,
  } as const;
}

const decide = (input: Parameters<typeof decideOrchestrationCommand>[0]) =>
  decideOrchestrationCommand(input).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("queued turn decider", (it) => {
  it.effect("records the message and the options needed to send it later", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: queueCommand(FUTURE),
        readModel: makeReadModel({}),
      });
      expect(events.map((event) => event.type)).toEqual(["thread.turn-queued"]);
      if (events[0]?.type !== "thread.turn-queued") return;
      expect(events[0].payload.queuedTurn).toMatchObject({
        messageId: MESSAGE_ID,
        text: "keep going",
        runtimeMode: "full-access",
        interactionMode: "default",
        state: "queued",
        readyAt: FUTURE,
        attempts: 0,
      });
    }),
  );

  // Nothing else in the composer holds a second draft, so a second queue is
  // the user changing their mind, not a conflict to resolve.
  it.effect("replaces an existing queued turn and resets its attempts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: queueCommand(FUTURE, "actually, do this instead"),
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ text: "keep going", attempts: 1, state: "stalled" }),
        }),
      });
      if (events[0]?.type !== "thread.turn-queued") return;
      expect(events[0].payload.queuedTurn.text).toBe("actually, do this instead");
      expect(events[0].payload.queuedTurn.attempts).toBe(0);
      expect(events[0].payload.queuedTurn.state).toBe("queued");
    }),
  );

  it.effect("rejects a queue whose dispatch time has already passed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: queueCommand(PAST),
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("cancels a queued turn, and cancelling twice is a projected no-op", () =>
    Effect.gen(function* () {
      const cancelled = yield* decide({
        command: dequeueCommand,
        readModel: makeReadModel({ queuedTurn: makeQueuedTurn() }),
      });
      expect(cancelled.map((event) => event.type)).toEqual(["thread.turn-dequeued"]);
      if (cancelled[0]?.type !== "thread.turn-dequeued") return;
      expect(cancelled[0].payload.reason).toBe("cancelled");

      const again = yield* decide({
        command: dequeueCommand,
        readModel: makeReadModel({ queuedTurn: null }),
      });
      expect(again.map((event) => event.type)).toEqual(["thread.turn-dequeued"]);
      if (again[0]?.type !== "thread.turn-dequeued") return;
      // The thread's stamp does not move for a cancel that changed nothing.
      expect(again[0].payload.updatedAt).toBe(PAST);
    }),
  );

  it.effect("dispatches a due queued turn as an ordinary turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: dispatchCommand,
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ readyAt: PAST }),
          session: makeSession(null),
        }),
      });
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
        "thread.turn-queued",
      ]);
      const sent = events[0];
      if (sent?.type !== "thread.message-sent") return;
      expect(sent.payload.text).toBe("keep going");
      expect(sent.payload.messageId).toBe(MESSAGE_ID);
      const started = events[1];
      if (started?.type !== "thread.turn-start-requested") return;
      expect(started.payload.messageId).toBe(MESSAGE_ID);
      expect(started.payload.runtimeMode).toBe("full-access");
      // The record survives the dispatch so an immediate re-limit can be
      // recognised as this turn bouncing rather than a brand new stall.
      const requeued = events[2];
      if (requeued?.type !== "thread.turn-queued") return;
      expect(requeued.payload.queuedTurn.state).toBe("awaiting");
      expect(requeued.payload.queuedTurn.attempts).toBe(1);
      expect(Date.parse(requeued.payload.queuedTurn.readyAt)).toBeGreaterThan(Date.parse(NOW));
    }),
  );

  it.effect("wakes a settled and snoozed thread the way a live send would", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: dispatchCommand,
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ readyAt: PAST }),
          settledOverride: "settled",
          snoozedUntil: FUTURE,
        }),
      });
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.message-sent",
        "thread.turn-start-requested",
        "thread.turn-queued",
      ]);
    }),
  );

  // "Dispatched exactly once" is this rejection: the sweeper reads a snapshot,
  // so a second command for an already-sent turn must not send it again.
  it.effect("refuses to dispatch a turn that is no longer waiting", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: dispatchCommand,
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ state: "awaiting", readyAt: PAST, attempts: 1 }),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses to dispatch before the queued turn is due", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: dispatchCommand,
        readModel: makeReadModel({ queuedTurn: makeQueuedTurn({ readyAt: FUTURE }) }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("refuses to dispatch when there is nothing queued", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: dispatchCommand,
        readModel: makeReadModel({ queuedTurn: null }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("re-queues a dispatched turn that hit a fresh limit", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: rescheduleCommand(FUTURE),
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 1 }),
        }),
      });
      if (events[0]?.type !== "thread.turn-queued") return;
      expect(events[0].payload.queuedTurn.state).toBe("queued");
      expect(events[0].payload.queuedTurn.readyAt).toBe(FUTURE);
      expect(events[0].payload.queuedTurn.attempts).toBe(1);
    }),
  );

  // The loop stops here, in the decider, not only in the sweeper that asks.
  it.effect("refuses a second automatic retry once the attempts are spent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: rescheduleCommand(FUTURE),
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 2 }),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("stalls a spent queued turn in place instead of dropping it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const events = yield* decide({
        command: rescheduleCommand(null),
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 2 }),
        }),
      });
      if (events[0]?.type !== "thread.turn-queued") return;
      expect(events[0].payload.queuedTurn.state).toBe("stalled");
      // The text stays visible so the user still has something to cancel.
      expect(events[0].payload.queuedTurn.text).toBe("keep going");
    }),
  );

  it.effect("releases a queued turn with the reason it went away", () =>
    Effect.gen(function* () {
      const events = yield* decide({
        command: releaseCommand("orphaned"),
        readModel: makeReadModel({
          queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 1 }),
        }),
      });
      expect(events.map((event) => event.type)).toEqual(["thread.turn-dequeued"]);
      if (events[0]?.type !== "thread.turn-dequeued") return;
      expect(events[0].payload.reason).toBe("orphaned");
    }),
  );

  it.effect("rejects queueing onto an archived thread", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: queueCommand(FUTURE),
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects commands for a thread that does not exist", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const error = yield* decideOrchestrationCommand({
        command: { ...queueCommand(FUTURE), threadId: ThreadId.make("thread-missing") },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("keeps the queued turn out of the wire payload shape it was given", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const now = DateTime.formatIso(yield* DateTime.now);
      const events = yield* decide({
        command: queueCommand(FUTURE),
        readModel: makeReadModel({}),
      });
      if (events[0]?.type !== "thread.turn-queued") return;
      expect(events[0].payload.queuedTurn.queuedAt).toBe(now);
      expect(events[0].payload.queuedTurn.updatedAt).toBe(now);
    }),
  );
});
