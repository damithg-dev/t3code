import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  // A turn parked until the provider's usage limits reset, as one JSON blob:
  // the message, the composer options needed to send it later, and where the
  // schedule has got to. NULL means nothing is queued.
  if (!columns.some((column) => column.name === "queued_turn_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queued_turn_json TEXT
    `;
  }
});
