import { CommandId, type OrchestrationCommand, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { decideQueuedTurnAction, type QueuedTurnAction } from "./QueuedTurnPolicy.ts";

/**
 * Sends turns the user parked while a provider was rate limited.
 *
 * Lives on the server so a queue fires with every client closed and over
 * remote or tunnel connections — the desktop app is one of several clients,
 * not the thing that owns the schedule. Sweeps on the same one-minute tick
 * the settlement reactor uses; a queue is minutes-scale by nature, and the
 * dispatch time already carries a minute of skew guard.
 */
export class QueuedTurnReactor extends Context.Service<
  QueuedTurnReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/QueuedTurnReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const commandFor = (input: {
    readonly action: QueuedTurnAction;
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly createdAt: string;
  }): OrchestrationCommand => {
    const { action, ...base } = input;
    switch (action.kind) {
      case "dispatch":
        return { type: "thread.queued-turn.dispatch", ...base };
      case "release":
        return { type: "thread.queued-turn.release", reason: action.reason, ...base };
      case "reschedule":
        return {
          type: "thread.queued-turn.reschedule",
          dispatchAfter: action.dispatchAfter,
          ...base,
        };
      case "stall":
        return { type: "thread.queued-turn.reschedule", dispatchAfter: null, ...base };
    }
  };

  const sweep = Effect.fn("QueuedTurnReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);

    yield* Effect.forEach(
      snapshot.threads,
      (thread) =>
        Effect.gen(function* () {
          const action = decideQueuedTurnAction(thread, now);
          if (action === null) return;
          const uuid = yield* crypto.randomUUIDv4;
          const commandId = CommandId.make(`server:queued-turn:${thread.id}:${uuid}`);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch(commandFor({ action, threadId: thread.id, commandId, createdAt }));
        }).pipe(
          // The snapshot is a read; the queue can be cancelled or dispatched
          // by another path between reading it and this command landing, and
          // the decider rejects the loser. That is bookkeeping, not a failure
          // worth stopping the sweep over.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("queued turn action skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("queued turn sweep failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const start: QueuedTurnReactor["Service"]["start"] = Effect.fn("QueuedTurnReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return { start, drain: worker.drain } satisfies QueuedTurnReactor["Service"];
});

export const layer = Layer.effect(QueuedTurnReactor, make);
