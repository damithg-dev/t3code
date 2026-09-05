# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) serializes commands;
the [decider](../../apps/server/src/orchestration/decider.ts) produces events without performing
provider or filesystem work. Events, persisted projections, and the accepted command receipt commit
in one database transaction. The in-memory state changes and subscribers receive events after that
commit. This keeps command retries idempotent and prevents a persisted projection from getting
ahead of the event log.

Reactors perform side effects after intent has been recorded, then feed results back through
commands. A command acknowledgement therefore means the intent committed, not that the provider,
checkpoint, or other follow-up work finished. Keep external I/O out of the decider and the database
transaction.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A turn ending and its follow-up work settling are separate milestones. The
[projector](../../apps/server/src/orchestration/projector.ts) settles the turn from its session
status. A late checkpoint or diff must not extend the recorded turn duration or keep the client
showing provider work as active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

Runtime receipts mark specific test milestones. Their
[production layer](../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts) is a no-op;
production behavior must use persisted state and events. These test signals are separate from the
durable command receipts that make dispatch idempotent.

## Desktop windows

The desktop shell can hold several app windows at once. `DesktopWindow.createWindow` takes a role:
the **main** window (window 1) owns the singular state — the persisted `mainWindowBounds` record,
the module-level bounds flush, the `ElectronWindow` main registration, and the connecting splash —
while a **secondary** window reuses the rest of the per-window setup. `createSecondary`, driven by
Window → New Window, makes one; `activate` and `ensureMain` are unchanged, so nothing creates a
window implicitly.

Secondary windows are tracked in the `secondaryWindows` desktop setting: bounds plus the renderer
URL, appended on open and dropped on close unless `DesktopState.quitting` is set, so an app quit
preserves the set while a deliberate close does not. `handleBackendReady` replays it once, after
the main window exists. Saved bounds go through the same display fit-check the main window uses,
and a saved URL is only loaded back when `isSameOriginRendererNavigation` accepts it.

`PreviewManager` keeps a registry of windows keyed by each window's own `webContents.id`, which is
what a preview guest's `hostWebContents` resolves to. Guest attachment accepts any registered
window, and background throttling fans out over the registry. An event whose host is unknown or
destroyed is dropped rather than routed to another window: misdelivering into a different project
is worse than losing the event. Windows unregister on `closed`, and preview teardown (recordings,
picture-in-picture) runs only when the last one goes.

Windows are a desktop-only surface. The web client's equivalent is a second browser window against
the same server, and mobile shows one project at a time, so neither needed a change. Nothing
crosses the wire: each renderer is an ordinary client of the same local backend, which was already
multi-client. See [Multiple windows](../user/multiple-windows.md).

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
