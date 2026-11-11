import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import { historyCallId, historyItemType } from "./session-tool-call-settlement";

/** Receipt proof metadata only. Canonical model history is never projected here. */
export async function readSessionHistoryToolIdentityPage(
  tx: Pick<Database, "execute">,
  scope: { workspaceId: string; sessionId: string; turnId: string },
  before: number | null,
  limit: number,
): Promise<Array<{ position: number; callId: string | null; type: string | null }>> {
  const rows = await rawRows<{
    position: string;
    item: Record<string, unknown>;
    itemCodecVersion: number | null;
  }>(
    tx,
    sql`
    select page.position, page.item_codec_version as "itemCodecVersion",
      jsonb_build_object(
        'type', identity.type, 'callId', identity."callId", 'call_id', identity.call_id,
        'id', identity.id, 'providerData', jsonb_build_object(
          'callId', identity."providerData"->'callId',
          'call_id', identity."providerData"->'call_id'
        )
      ) as item
    from (
      select position, item, item_codec_version from session_history_items
      where workspace_id = ${scope.workspaceId}::uuid
        and session_id = ${scope.sessionId}::uuid and turn_id = ${scope.turnId}::uuid
        ${before === null ? sql`` : sql`and position < ${before}`}
      order by position desc limit ${limit}
    ) page
    cross join lateral jsonb_to_record(
      case when jsonb_typeof(page.item) in ('object', 'null') then page.item else '{}'::jsonb end
    ) as identity(type jsonb, "callId" jsonb, call_id jsonb, id jsonb, "providerData" jsonb)
    order by page.position desc
  `,
  );
  // The synchronized JSONB mirror has the same field values as item_ordered.
  // Decode only these fields with the original row's codec, then use the same
  // identity precedence/type checks as the full-history reader. jsonb_to_record
  // extracts them in one pass rather than detoasting a large output per field.
  // A malformed JSON null still rejects the read; other primitive/array rows
  // have no named identities, just as with the previous JavaScript lookup.
  return rows.map((row) => {
    const item = fromPostgresLosslessJson(row.item, row.itemCodecVersion);
    return {
      position: Number(row.position),
      callId: historyCallId(item),
      type: historyItemType(item),
    };
  });
}
