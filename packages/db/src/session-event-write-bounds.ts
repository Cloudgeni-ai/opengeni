import { boundSessionEventPayloadForWrite } from "@opengeni/contracts";
import { maskSecretValuesForStorage } from "./secret-value-masking";

/**
 * Apply the per-type durable payload bound to session-event rows just before
 * INSERT. Rows that need no bound keep their exact object identity.
 *
 * This is also the session event writer's secret backstop: inside an attempt
 * (or a first-party tool call that received resolved values) every known
 * secret value in a payload is replaced by its reference before it is stored
 * and published (docs/secrets.md, Masking).
 */
export function withBoundSessionEventPayloads<Row extends { type: string; payload?: unknown }>(
  rows: readonly Row[],
): Row[] {
  return rows.map((row) => {
    if (!Object.hasOwn(row, "payload")) return row;
    const payload = boundSessionEventPayloadForWrite(
      row.type,
      maskSecretValuesForStorage(row.payload, "event_writer"),
    );
    return payload === row.payload ? row : { ...row, payload };
  });
}
