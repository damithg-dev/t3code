import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const threadColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  return new Set(columns.map((column) => column.name));
});

const projectColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  return new Set(columns.map((column) => column.name));
});

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
});

// Each test gets its own in-memory database; a shared one would let the drift
// reproduced below leak into the healthy-database case and pass it vacuously.
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

describe("055_HealForkRenumberedMigrations", () => {
  it.effect("restores schema on a database that ran the previous fork build", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Reproduce this fork's own ledger: the previous fork build stacked the
        // multi-repo migrations and its queue-on-limit work into ids 50-54, so
        // the multi-repo migrations that now carry those ids never run.
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (50, 'ProjectionThreadsQueuedTurn'),
            (51, 'ProjectionThreadsWorktrees'),
            (52, 'HealSkippedRenumberedMigrations'),
            (53, 'ProjectionThreadSessionsRateLimitResetsAt'),
            (54, 'ProjectionThreadsQueuedTurn')
        `;

        const projectsBefore = yield* projectColumns;
        assert.ok(!projectsBefore.has("repo_roots"), "expected repo_roots missing before healing");
        assert.ok(
          !projectsBefore.has("workspace_file"),
          "expected workspace_file missing before healing",
        );
        assert.ok(
          !(yield* threadColumns).has("worktrees_json"),
          "expected worktrees_json missing before healing",
        );
        assert.ok(
          !(yield* tables).has("projection_checkpoint_refs"),
          "expected projection_checkpoint_refs missing before healing",
        );

        yield* runMigrations({ toMigrationInclusive: 55 });

        const projectsAfter = yield* projectColumns;
        assert.ok(projectsAfter.has("repo_roots"), "expected repo_roots restored");
        assert.ok(projectsAfter.has("workspace_file"), "expected workspace_file restored");
        assert.ok((yield* threadColumns).has("worktrees_json"), "expected worktrees_json restored");
        assert.ok(
          (yield* tables).has("projection_checkpoint_refs"),
          "expected projection_checkpoint_refs restored",
        );
      }),
    ),
  );

  it.effect("carries main's 048-049 heal through to the previous fork build", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // The previous fork build stacked on top of a multi-repo revision whose
        // heal predated main's 048-049, so those columns are missing and the
        // heal that restores them is itself stranded at a spent id.
        yield* runMigrations({ toMigrationInclusive: 47 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (48, 'ProjectionProjectsRepoRoots'),
            (49, 'ProjectionProjectsWorkspaceFile'),
            (50, 'ProjectionCheckpointRefs'),
            (51, 'ProjectionThreadsWorktrees'),
            (52, 'HealSkippedRenumberedMigrations'),
            (53, 'ProjectionThreadSessionsRateLimitResetsAt'),
            (54, 'ProjectionThreadsQueuedTurn')
        `;

        const before = yield* threadColumns;
        assert.ok(
          !before.has("branch_pull_request_json"),
          "expected branch_pull_request_json missing before healing",
        );
        assert.ok(
          !before.has("active_order_key"),
          "expected active_order_key missing before healing",
        );

        yield* runMigrations({ toMigrationInclusive: 55 });

        const after = yield* threadColumns;
        assert.ok(
          after.has("branch_pull_request_json"),
          "expected branch_pull_request_json restored",
        );
        assert.ok(after.has("active_order_key"), "expected active_order_key restored");
      }),
    ),
  );

  it.effect("is a no-op on a healthy database", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 54 });
        const threadsBefore = yield* threadColumns;
        const projectsBefore = yield* projectColumns;

        yield* runMigrations({ toMigrationInclusive: 55 });

        assert.deepEqual([...(yield* threadColumns)].sort(), [...threadsBefore].sort());
        assert.deepEqual([...(yield* projectColumns)].sort(), [...projectsBefore].sort());
      }),
    ),
  );
});
