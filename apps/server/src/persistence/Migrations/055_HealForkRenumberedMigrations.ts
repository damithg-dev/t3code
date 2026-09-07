import * as Effect from "effect/Effect";

import Migration0050 from "./050_ProjectionProjectsRepoRoots.ts";
import Migration0051 from "./051_ProjectionProjectsWorkspaceFile.ts";
import Migration0052 from "./052_ProjectionCheckpointRefs.ts";
import Migration0053 from "./053_ProjectionThreadsWorktrees.ts";
import Migration0054 from "./054_HealSkippedRenumberedMigrations.ts";

/**
 * Heals databases that skipped the multi-repo migrations 050-054 because this
 * fork's own build claimed those id slots first.
 *
 * The same trap `054_HealSkippedRenumberedMigrations` documents applies one
 * level out. This fork stacks the multi-repo branch and its own queue-on-limit
 * work on top of a stable upstream tag, so every base bump renumbers the
 * multi-repo migrations upward and vacates the ids the previous fork build
 * already wrote to `effect_sql_migrations`. On a machine running the previous
 * fork build the ledger reads 50 `ProjectionThreadsQueuedTurn`, 51
 * `ProjectionThreadsWorktrees`, 52 `HealSkippedRenumberedMigrations`, 53
 * `ProjectionThreadSessionsRateLimitResetsAt`, 54 `ProjectionThreadsQueuedTurn`
 * -- so ids 50-54 are spent and the multi-repo migrations that now carry them,
 * including the heal that restores main's 048-049, never run.
 *
 * Re-running 050-054 is the whole heal: every one of them guards with `PRAGMA
 * table_info`, `IF NOT EXISTS`, or a catch, and 054 in turn re-runs main's
 * 037-049 the same way. On a healthy database this is a no-op.
 *
 * Migration ids are immutable once any build has applied them. When bumping
 * this fork's base tag, append after the highest id the previous fork build
 * could have written rather than renumbering into slots it has claimed.
 */
export default Effect.gen(function* () {
  yield* Migration0050;
  yield* Migration0051;
  yield* Migration0052;
  yield* Migration0053;
  yield* Migration0054;
});
