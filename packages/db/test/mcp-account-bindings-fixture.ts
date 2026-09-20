import type postgres from "postgres";

// The shared fixture API supplies JSON.stringify text, as PGlite expects.
// Postgres.js infers JSON/JSONB OIDs from the server and would stringify that
// text a second time. Override only those wire types, retaining normal result
// parsing and all non-JSON parameter serializers.
export const nativeMcpAccountBindingsJsonTypes = {
  fixtureJson: {
    to: 114,
    from: [114, 3802],
    serialize: (value: string) => value,
    parse: (value: string): unknown => JSON.parse(value),
  },
};

/** Materialize lazy Postgres.js queries before giving them to Bun matchers.
 * Bun's `.rejects` observes the Promise state without activating Query.then;
 * a raw Query would leave the migration's expected drain refusal unexecuted.
 */
export function nativeMcpAccountBindingsFixture(sql: ReturnType<typeof postgres>) {
  return {
    exec: async (text: string): Promise<unknown> => sql.unsafe(text),
    query: async (text: string, args: unknown[] = []) => ({
      rows: await sql.unsafe(text, args as never[]),
    }),
    close: () => sql.end(),
  };
}
