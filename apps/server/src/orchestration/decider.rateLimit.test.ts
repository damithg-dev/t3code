import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SESSION_UPDATED_AT = "2026-01-01T00:00:10.000Z";
const RESETS_AT = "2026-01-01T05:00:00.000Z";

function makeSession(rateLimitResetsAt?: string | null): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "ready",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    ...(rateLimitResetsAt === undefined ? {} : { rateLimitResetsAt }),
    updatedAt: SESSION_UPDATED_AT,
  };
}

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly settledOverride?: OrchestrationThread["settledOverride"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: input.settledOverride ?? null,
        settledAt: input.settledOverride === "settled" ? NOW : null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session === undefined ? makeSession(null) : input.session,
      },
    ],
    updatedAt: NOW,
  };
}

function rateLimitCommand(resetsAt: string | null) {
  return {
    type: "thread.session.rate-limit-set",
    commandId: CommandId.make("cmd-rate-limit"),
    threadId: ThreadId.make("thread-1"),
    resetsAt,
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("thread.session.rate-limit-set decider", (it) => {
  it.effect("merges the reported reset into the session without touching updatedAt", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.session-set");
      if (events[0]?.type !== "thread.session-set") return;
      expect(events[0].payload.session.rateLimitResetsAt).toBe(RESETS_AT);
      // A limit report is not session activity: moving updatedAt would raise a
      // snoozed thread's hand and reorder the sidebar.
      expect(events[0].payload.session.updatedAt).toBe(SESSION_UPDATED_AT);
      expect(events[0].payload.session.status).toBe("ready");
    }),
  );

  it.effect("emits nothing when the session already carries that reset", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({ session: makeSession(RESETS_AT) }),
      });
      expect(Array.isArray(decided) ? decided : [decided]).toHaveLength(0);
    }),
  );

  it.effect("treats an absent field and an explicit null as the same cleared state", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(null),
        readModel: makeReadModel({ session: makeSession(undefined) }),
      });
      expect(Array.isArray(decided) ? decided : [decided]).toHaveLength(0);
    }),
  );

  it.effect("emits nothing when the thread has no session to record it on", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({ session: null }),
      });
      expect(Array.isArray(decided) ? decided : [decided]).toHaveLength(0);
    }),
  );

  it.effect("emits nothing for a thread that does not exist", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...rateLimitCommand(RESETS_AT),
          threadId: ThreadId.make("thread-missing"),
        },
        readModel: makeReadModel({}),
      });
      expect(Array.isArray(decided) ? decided : [decided]).toHaveLength(0);
    }),
  );

  it.effect("never un-settles a settled thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({ settledOverride: "settled" }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("leaves thread.session.set a total write of the command's session", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: makeSession(undefined),
          createdAt: NOW,
        },
        readModel: makeReadModel({ session: makeSession(RESETS_AT) }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type !== "thread.session-set") return;
      expect(events[0].payload.session.rateLimitResetsAt).toBeUndefined();
    }),
  );
});
