import type postgres from "postgres";

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
