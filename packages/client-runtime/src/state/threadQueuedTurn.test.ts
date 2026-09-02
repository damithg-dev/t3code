import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftCanBeQueued,
  providerSupportsLimitQueue,
  queueForLimitResetOffer,
  queuedTurnStatus,
} from "./threadQueuedTurn.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const RESETS_AT = "2026-01-01T05:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function session(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status: "error",
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    rateLimitResetsAt: RESETS_AT,
    updatedAt: NOW,
    ...overrides,
  };
}

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktrees: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: session(),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("queueForLimitResetOffer", () => {
  it("offers a dispatch time a minute past the reported reset", () => {
    expect(queueForLimitResetOffer(shell(), { now: NOW })).toEqual({
      resetsAt: RESETS_AT,
      dispatchAfter: "2026-01-01T05:01:00.000Z",
    });
  });

  it("offers nothing when no limit was reported", () => {
    expect(
      queueForLimitResetOffer(shell({ session: session({ rateLimitResetsAt: null }) }), {
        now: NOW,
      }),
    ).toBeNull();
    expect(queueForLimitResetOffer(shell({ session: null }), { now: NOW })).toBeNull();
  });

  // Stale provider state, not a limit: the composer keeps its ordinary send.
  it("offers nothing once the reset has passed", () => {
    expect(queueForLimitResetOffer(shell(), { now: "2026-01-01T06:00:00.000Z" })).toBeNull();
  });

  // An unreadable time is not a time. It must not collapse into "queue now"
  // or into a label nobody can act on.
  it("offers nothing for a reset it cannot read", () => {
    expect(
      queueForLimitResetOffer(shell({ session: session({ rateLimitResetsAt: "soon" }) }), {
        now: NOW,
      }),
    ).toBeNull();
  });

  it("offers nothing on providers that report no reset time", () => {
    for (const providerName of ["cursor", "grok", "opencode", null]) {
      expect(
        queueForLimitResetOffer(shell({ session: session({ providerName }) }), { now: NOW }),
      ).toBeNull();
    }
  });

  it("offers nothing on an archived thread", () => {
    expect(queueForLimitResetOffer(shell({ archivedAt: NOW }), { now: NOW })).toBeNull();
  });
});

describe("providerSupportsLimitQueue", () => {
  it("covers exactly the providers that report a reset epoch", () => {
    expect(providerSupportsLimitQueue("claudeAgent")).toBe(true);
    expect(providerSupportsLimitQueue("codex")).toBe(true);
    expect(providerSupportsLimitQueue("cursor")).toBe(false);
    expect(providerSupportsLimitQueue("grok")).toBe(false);
    expect(providerSupportsLimitQueue("opencode")).toBe(false);
    expect(providerSupportsLimitQueue(null)).toBe(false);
    expect(providerSupportsLimitQueue(undefined)).toBe(false);
  });
});

describe("queuedTurnStatus", () => {
  const base = {
    messageId: MessageId.make("message-1"),
    text: "keep going",
    runtimeMode: "full-access",
    interactionMode: "default",
    readyAt: RESETS_AT,
    attempts: 0,
    queuedAt: NOW,
    updatedAt: NOW,
  } as const;

  it("tells waiting, sending and stalled apart", () => {
    expect(queuedTurnStatus({ ...base, state: "queued" })).toBe("waiting");
    expect(queuedTurnStatus({ ...base, state: "awaiting" })).toBe("sending");
    expect(queuedTurnStatus({ ...base, state: "stalled", attempts: 2 })).toBe("stalled");
  });
});

describe("draftCanBeQueued", () => {
  it("accepts a text-only draft", () => {
    expect(draftCanBeQueued({ attachmentCount: 0, contextCount: 0 })).toBe(true);
  });

  // Attachments need the upload path a live turn has; contexts are snapshots
  // that will be stale by the time limits reset. Both keep the ordinary send.
  it("refuses a draft carrying attachments or contexts", () => {
    expect(draftCanBeQueued({ attachmentCount: 1, contextCount: 0 })).toBe(false);
    expect(draftCanBeQueued({ attachmentCount: 0, contextCount: 1 })).toBe(false);
    expect(draftCanBeQueued({ attachmentCount: 2, contextCount: 3 })).toBe(false);
  });
});
