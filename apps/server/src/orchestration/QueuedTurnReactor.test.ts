import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationQueuedTurn,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as QueuedTurnReactor from "./QueuedTurnReactor.ts";
import { queuedTurnDispatchAfter } from "./QueuedTurnPolicy.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PAST = "2025-12-31T23:00:00.000Z";
const FUTURE = "2026-01-01T05:00:00.000Z";
const PROJECT_ID = ProjectId.make("queue-project");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Queue project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: PAST,
    updatedAt: NOW,
  };
}

function makeSession(rateLimitResetsAt: string | null, threadId: ThreadId): OrchestrationSession {
  return {
    threadId,
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

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
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
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: makeSession(null, threadId),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return { snapshotSequence: 1, projects: [makeProject()], threads, updatedAt: NOW };
}

type QueuedTurnCommand = Extract<
  OrchestrationCommand,
  {
    readonly type:
      | "thread.queued-turn.dispatch"
      | "thread.queued-turn.reschedule"
      | "thread.queued-turn.release";
  }
>;

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly onDispatch?: (
    command: QueuedTurnCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

const makeHarness = Effect.fn("makeQueuedTurnHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReads = yield* Queue.unbounded<number>();
  const readCount = yield* Ref.make(0);
  const commands = yield* Ref.make<ReadonlyArray<QueuedTurnCommand>>([]);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (
      command.type !== "thread.queued-turn.dispatch" &&
      command.type !== "thread.queued-turn.reschedule" &&
      command.type !== "thread.queued-turn.release"
    ) {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    const queuedTurnCommand = command;
    return Ref.update(commands, (recorded) => [...recorded, queuedTurnCommand]).pipe(
      Effect.andThen(options.onDispatch?.(queuedTurnCommand) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Ref.updateAndGet(readCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    snapshots,
    snapshotReads,
    commands,
    layer: QueuedTurnReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

/**
 * Runs exactly one sweep and returns once it has finished. The reactor's
 * worker drain is the receipt here — nothing waits on a clock.
 */
const sweepOnce = Effect.fn("sweepQueuedTurnsOnce")(function* (
  reactor: QueuedTurnReactor.QueuedTurnReactor["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("QueuedTurnReactor", () => {
  it.effect("dispatches a due queued turn exactly once per sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("due", { queuedTurn: makeQueuedTurn() }),
            makeThread("not-due", { queuedTurn: makeQueuedTurn({ readyAt: FUTURE }) }),
            makeThread("nothing-queued"),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor.QueuedTurnReactor;
          yield* sweepOnce(reactor, fixture.activation, fixture.snapshotReads);
          const dispatched = yield* Ref.get(fixture.commands);
          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]?.type).toBe("thread.queued-turn.dispatch");
          expect(dispatched[0]?.threadId).toBe(ThreadId.make("due"));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("re-queues a dispatched turn that walked into a fresh limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("bounced", {
              queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 1, readyAt: FUTURE }),
              session: makeSession(FUTURE, ThreadId.make("bounced")),
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor.QueuedTurnReactor;
          yield* sweepOnce(reactor, fixture.activation, fixture.snapshotReads);
          const dispatched = yield* Ref.get(fixture.commands);
          expect(dispatched).toHaveLength(1);
          const command = dispatched[0];
          if (command?.type !== "thread.queued-turn.reschedule") {
            throw new Error("expected a reschedule");
          }
          expect(command.dispatchAfter).toBe(queuedTurnDispatchAfter(Date.parse(FUTURE)));
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  // Second consecutive limit: the sweeper asks for the stall, never a retry.
  it.effect("stalls instead of retrying a turn whose attempts are spent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("spent", {
              queuedTurn: makeQueuedTurn({ state: "awaiting", attempts: 2, readyAt: FUTURE }),
              session: makeSession(FUTURE, ThreadId.make("spent")),
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor.QueuedTurnReactor;
          yield* sweepOnce(reactor, fixture.activation, fixture.snapshotReads);
          const dispatched = yield* Ref.get(fixture.commands);
          const command = dispatched[0];
          if (command?.type !== "thread.queued-turn.reschedule") {
            throw new Error("expected a reschedule");
          }
          expect(command.dispatchAfter).toBeNull();
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("drops a queued turn whose thread was archived underneath it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("archived", { queuedTurn: makeQueuedTurn(), archivedAt: NOW }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor.QueuedTurnReactor;
          yield* sweepOnce(reactor, fixture.activation, fixture.snapshotReads);
          const dispatched = yield* Ref.get(fixture.commands);
          const command = dispatched[0];
          if (command?.type !== "thread.queued-turn.release") {
            throw new Error("expected a release");
          }
          expect(command.reason).toBe("orphaned");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  // The snapshot is a read: another client can cancel between reading it and
  // the command landing. A rejection is bookkeeping, not a broken sweep.
  it.effect("keeps sweeping when the decider rejects a raced command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("raced", { queuedTurn: makeQueuedTurn() }),
            makeThread("also-due", { queuedTurn: makeQueuedTurn() }),
          ]),
          onDispatch: (command) =>
            command.threadId === ThreadId.make("raced")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "thread raced has no queued turn to dispatch",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor.QueuedTurnReactor;
          yield* sweepOnce(reactor, fixture.activation, fixture.snapshotReads);
          const dispatched = yield* Ref.get(fixture.commands);
          // Threads sweep concurrently, so assert the set, not the order.
          expect(dispatched.map((command) => command.threadId).toSorted()).toEqual([
            ThreadId.make("also-due"),
            ThreadId.make("raced"),
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
