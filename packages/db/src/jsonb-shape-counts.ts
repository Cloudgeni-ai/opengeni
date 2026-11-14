import { sql, type SQL } from "drizzle-orm";

/*
 * Linear-time shape counts for one jsonb value, as SQL expressions.
 *
 * They return exactly what counting `jsonb_path_query(value, 'strict $.**')`
 * rows (nodes) and the `jsonb_object_keys` of its object nodes (properties)
 * returns, but without that set-returning function. PostgreSQL builds the
 * whole result list of `jsonb_path_query` and hands out each row with
 * `list_delete_first` (jsonpath_exec.c), which moves the rest of the list, so
 * counting n nodes that way is O(n^2) memory traffic: seconds of server CPU
 * for one item with a few hundred thousand array elements. LIMIT does not
 * help, because the function scan materializes every row first.
 *
 * `jsonb_path_query_array` walks the same `strict $.**` sequence once and
 * collects it with a linear list append. Mapping each node to its `.type()`
 * keeps that array to one short string per node instead of a copy of every
 * subtree, and `jsonb_array_length` reads the count from its header.
 */

/** Number of JSON values in `value`, the root included (bigint). */
export function jsonbNodeCountSql(value: SQL): SQL<string> {
  return sql<string>`jsonb_array_length(jsonb_path_query_array(${value}, 'strict $.**.type()'))::bigint`;
}

/** Number of members across every object in `value` (bigint). */
export function jsonbPropertyCountSql(value: SQL): SQL<string> {
  return sql<string>`jsonb_array_length(jsonb_path_query_array(${value}, 'strict $.** ? (@.type() == "object").*.type()'))::bigint`;
}
