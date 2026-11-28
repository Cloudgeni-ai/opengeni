import { Writable } from "node:stream";
import { quoted, type OrderedTable } from "./config";

/**
 * The `.tables` file is psql input: for each ordered table, a `COPY ... FROM
 * stdin;` line, its rows in COPY text format in key order, and a `\.` line.
 * Restore loads it after the archive's data and before its indexes and
 * constraints, in the same transaction.
 */

/** Session settings that make COPY text output match pg_dump's. */
const settings = [
  "SET row_security = off;",
  "SET DateStyle = ISO;",
  "SET IntervalStyle = postgres;",
  "SET extra_float_digits = 3;",
  "SET synchronize_seqscans = off;",
  // Read in key order from an index; a full sort would spill the table to disk.
  "SET enable_seqscan = off;",
  "SET enable_sort = off;",
  "SELECT set_config(name, '0', false) FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout') \\g /dev/null",
  "SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database() \\gset",
  "SET client_encoding = :'encoding';",
];

/** A psql script (run with -X -q -A -t -v ON_ERROR_STOP=1) that writes the `.tables` stream from an exported snapshot. */
export function tablesScript(snapshot: string, tables: OrderedTable[]): string {
  if (!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(snapshot)) throw Error("Invalid snapshot identifier");
  const lines = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;",
    `SET TRANSACTION SNAPSHOT '${snapshot}';`,
    ...settings,
    "SELECT 'SET client_encoding = ' || quote_literal(:'encoding') || ';';",
  ];
  for (const { table, key } of tables) {
    const name = quoted(table);
    lines.push(
      // Generated columns are not stored, as in pg_dump.
      `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS columns FROM pg_attribute WHERE attrelid = '${name}'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' \\gset`,
      `SELECT 'COPY ${name} (' || :'columns' || ') FROM stdin;';`,
      // Only the table's own rows: inheritance children and partitions are
      // tables of their own, whose rows stay in the archive.
      `COPY (SELECT :columns FROM ONLY ${name} ORDER BY ${key.map(quoted).join(", ")}) TO STDOUT;`,
      "SELECT '\\.';",
    );
  }
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

const END = Buffer.from("\\.\n");
const MAX_LINE = 1024 * 1024;

/**
 * Check a `.tables` stream as it passes: a header, then for each table a COPY
 * line, rows and an end-of-data line, and nothing after. COPY text format
 * escapes backslashes in values, so a line that is exactly `\.` only ever ends
 * a table's rows. With `expected`, the tables must be exactly those, in order.
 */
export function tablesCheck(expected?: string[]): Writable {
  let state: "header" | "between" | "rows" = "header";
  let pending: Buffer = Buffer.alloc(0);
  // In rows, whether `pending` starts inside a line whose start was dropped.
  let midLine = false;
  const seen: string[] = [];
  const control = (line: string) => {
    if (state === "header") {
      if (!/^SET client_encoding = '[A-Za-z0-9_]+';$/.test(line))
        throw Error("The ordered tables stream has no encoding header");
      state = "between";
      return;
    }
    const copy = /^COPY "([a-z_][a-z0-9_]*)"\."([a-z_][a-z0-9_]*)" \(.+\) FROM stdin;$/.exec(line);
    if (!copy) throw Error("Unexpected line in the ordered tables stream");
    const table = `${copy[1]}.${copy[2]}`;
    if (expected && expected[seen.length] !== table)
      throw Error(`Unexpected ordered table ${table}`);
    seen.push(table);
    state = "rows";
  };
  const consume = (final: boolean) => {
    let at = 0;
    while (at < pending.length) {
      if (state === "rows") {
        // Find a line that is exactly `\.`.
        let search = at;
        let found = -1;
        for (;;) {
          const index = pending.indexOf(END, search);
          if (index < 0) break;
          if (index === at ? !midLine : pending[index - 1] === 0x0a) {
            found = index;
            break;
          }
          search = index + 1;
        }
        if (found < 0) {
          // Rows are not kept: only a partial line that may still become `\.`.
          const lastNewline = pending.lastIndexOf(0x0a);
          const startsLine = lastNewline >= at || !midLine;
          const tail = lastNewline >= at ? lastNewline + 1 : at;
          if (startsLine && pending.length - tail <= 2) {
            at = tail;
            midLine = false;
          } else {
            at = pending.length;
            midLine = true;
          }
          break;
        }
        at = found + END.length;
        midLine = false;
        state = "between";
        continue;
      }
      const end = pending.indexOf(0x0a, at);
      if (end < 0) break;
      control(pending.subarray(at, end).toString("utf8"));
      at = end + 1;
    }
    pending = pending.subarray(at);
    if (state !== "rows" && pending.length > MAX_LINE)
      throw Error("Overlong line in the ordered tables stream");
    if (final) {
      if (pending.length > 0 || state !== "between")
        throw Error("The ordered tables stream is truncated");
      if (expected && seen.length !== expected.length)
        throw Error("The ordered tables stream is missing tables");
    }
  };
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        consume(false);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        consume(true);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
