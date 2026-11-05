import { boundSessionEventPayloadForWrite } from "@opengeni/contracts";

/**
 * Apply the per-type durable payload bound to session-event rows just before
 * INSERT. Rows that need no bound keep their exact object identity.
 */
export function withBoundSessionEventPayloads<Row extends { type: string; payload?: unknown }>(
  rows: readonly Row[],
): Row[] {
  return rows.map((row) => {
    if (!Object.hasOwn(row, "payload")) return row;
    const payload = boundSessionEventPayloadForWrite(row.type, row.payload);
    return payload === row.payload ? row : { ...row, payload };
  });
}
