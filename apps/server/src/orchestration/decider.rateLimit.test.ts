import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
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

function makeSession(
  rateLimitResetsAt?: string | null,
  identity?: { readonly providerName?: string; readonly providerInstanceId?: string | null },
): OrchestrationSession {
  // null means "session carries no instance id", so it must survive the default.
  const instanceId =
    identity?.providerInstanceId === undefined ? "codex" : identity.providerInstanceId;
  return {
    threadId: ThreadId.make("thread-1"),
    status: "ready",
    providerName: identity?.providerName ?? "codex",
    ...(instanceId === null ? {} : { providerInstanceId: ProviderInstanceId.make(instanceId) }),
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
        worktrees: [],
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

function rateLimitCommand(
  resetsAt: string | null,
  identity?: { readonly provider?: string; readonly providerInstanceId?: string },
) {
  return {
    type: "thread.session.rate-limit-set",
    commandId: CommandId.make("cmd-rate-limit"),
    threadId: ThreadId.make("thread-1"),
    provider: ProviderDriverKind.make(identity?.provider ?? "codex"),
    ...(identity?.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: ProviderInstanceId.make(identity.providerInstanceId) }),
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

  // The engine rejects zero-event commands, so a repeat report has to re-emit
  // the session unchanged rather than decide nothing.
  it.effect("re-emits an unchanged session when the reset already matches", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({ session: makeSession(RESETS_AT) }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      if (events[0]?.type !== "thread.session-set") return;
      expect(events[0].payload.session).toEqual(makeSession(RESETS_AT));
    }),
  );

  it.effect("treats an absent field and an explicit null as the same cleared state", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(null),
        readModel: makeReadModel({ session: makeSession(undefined) }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type !== "thread.session-set") return;
      expect(events[0].payload.session.rateLimitResetsAt).toBeNull();
      expect(events[0].payload.session.updatedAt).toBe(SESSION_UPDATED_AT);
    }),
  );

  it.effect("rejects a limit for a thread with no session to record it on", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({ session: null }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  // The reporter's own pre-check runs on a snapshot; a provider or account
  // switch can commit before the command lands, so the decider re-checks
  // against the session the write would actually touch.
  it.effect("rejects a limit reported by a different provider driver", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT, { provider: "claudeAgent" }),
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a limit reported by a different instance of the same driver", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT, { providerInstanceId: "codex_work" }),
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("writes when the reporting instance matches the bound one", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT, { providerInstanceId: "codex" }),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  // Instance ids are optional during the driver/instance migration, so a
  // missing one on either side must not block the write.
  it.effect("writes when either side carries no instance id", () =>
    Effect.gen(function* () {
      const withoutCommandInstance = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT),
        readModel: makeReadModel({}),
      });
      expect(
        (Array.isArray(withoutCommandInstance)
          ? withoutCommandInstance
          : [withoutCommandInstance]
        ).map((event) => event.type),
      ).toEqual(["thread.session-set"]);

      const withoutSessionInstance = yield* decideOrchestrationCommand({
        command: rateLimitCommand(RESETS_AT, { providerInstanceId: "codex_work" }),
        readModel: makeReadModel({
          session: makeSession(null, { providerInstanceId: null }),
        }),
      });
      expect(
        (Array.isArray(withoutSessionInstance)
          ? withoutSessionInstance
          : [withoutSessionInstance]
        ).map((event) => event.type),
      ).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("rejects a limit for a thread that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...rateLimitCommand(RESETS_AT),
          threadId: ThreadId.make("thread-missing"),
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
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
