import { sql } from "drizzle-orm";
import { CreditDebitAttribution } from "./credit-debit-attribution";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";

/** Usage source and credit debit type of deployment-funded voice transcription. */
export const VOICE_TRANSCRIPTION_SOURCE_TYPE = "voice_transcription";
export const VOICE_TRANSCRIPTION_DEBIT_TYPE = "voice_transcription_debit";

/**
 * Idempotency keys for one settled voice-transcription unit. Both derive from
 * the workspace and the server-built unit id only, so an inline settlement, its
 * in-process retry, and a later reconciliation converge on the same rows.
 */
export function voiceTranscriptionSettlementKeys(input: {
  workspaceId: string;
  sourceId: string;
}): { usageIdempotencyKey: string; debitIdempotencyKey: string } {
  return {
    usageIdempotencyKey: `voice.transcription_cost:${input.sourceId}`,
    debitIdempotencyKey: `credit:${VOICE_TRANSCRIPTION_DEBIT_TYPE}:voice_input:${input.workspaceId}:${input.sourceId}`,
  };
}

export type UnsettledVoiceTranscriptionCharge = {
  sourceId: string;
  amountMicros: number;
  attribution: CreditDebitAttribution;
};

/**
 * Voice usage receipts in one workspace whose credit debit never committed
 * (the debit transaction failed after the receipt was durable). Bounded and
 * ordered oldest first; `minAgeMilliseconds` leaves an in-flight inline
 * settlement to finish with its full ledger metadata first. The scan walks the
 * workspace's `model.cost` index range, so the window is short (3 days) and
 * the statement is capped at 2 s; a timeout only defers reconciliation.
 */
export async function listUnsettledVoiceTranscriptionCharges(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    limit?: number;
    minAgeMilliseconds?: number;
  },
): Promise<UnsettledVoiceTranscriptionCharge[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const minAgeSeconds = Math.max(0, Math.floor((input.minAgeMilliseconds ?? 60_000) / 1_000));
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(sql`select set_config('statement_timeout', '2000ms', true)`);
      const rows = await rawRows<{
        source_id: string;
        quantity: string | number;
        attribution: unknown;
      }>(
        scopedDb,
        sql`
          select usage_row.source_resource_id as source_id,
            usage_row.quantity,
            usage_row.initiator_context -> 'creditDebitAttribution' as attribution
          from usage_events usage_row
          where usage_row.account_id = ${input.accountId}::uuid
            and usage_row.workspace_id = ${input.workspaceId}::uuid
            and usage_row.event_type = 'model.cost'
            and usage_row.source_resource_type = ${VOICE_TRANSCRIPTION_SOURCE_TYPE}
            and usage_row.source_resource_id is not null
            and usage_row.quantity > 0
            and usage_row.idempotency_key = 'voice.transcription_cost:' || usage_row.source_resource_id
            and usage_row.occurred_at >= now() - interval '3 days'
            and usage_row.occurred_at <= now() - make_interval(secs => ${minAgeSeconds})
            and not exists (
              select 1 from credit_ledger_entries ledger
              where ledger.idempotency_key = ${`credit:${VOICE_TRANSCRIPTION_DEBIT_TYPE}:voice_input:`}
                || usage_row.workspace_id::text || ':' || usage_row.source_resource_id
            )
          order by usage_row.occurred_at asc
          limit ${limit}
        `,
      );
      return rows.map((row) => {
        const attribution = CreditDebitAttribution.safeParse(row.attribution);
        return {
          sourceId: row.source_id,
          amountMicros: Number(row.quantity),
          attribution: attribution.success ? attribution.data : { kind: "unknown" as const },
        };
      });
    },
  );
}
