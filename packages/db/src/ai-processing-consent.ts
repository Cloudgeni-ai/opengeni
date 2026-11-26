import type {
  AiProcessingConsentPlatform,
  AiProcessingConsentResponse,
  AiProcessingDisclosure,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { setSubjectRlsContext, type Database } from "./database";

type Consent = NonNullable<AiProcessingConsentResponse["consent"]>;
type ConsentChange =
  | { kind: "grant"; disclosure: AiProcessingDisclosure; platform: AiProcessingConsentPlatform }
  | { kind: "withdraw" };

/** Scope must come from the authenticated human, never an HTTP parameter or delegated grant. */
export async function selfAiProcessingConsent(
  db: Database,
  authUserId: string,
  version: string,
  change?: ConsentChange,
): Promise<Consent | null> {
  return await db.transaction(async (tx) => {
    await setSubjectRlsContext(tx as unknown as Database, `user:${authUserId}`);
    if (change) {
      // Serialize grant/withdraw even when the person has no row yet.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        ${`ai-processing-consent:${authUserId}`}, 0))`);
      await tx.execute(sql`
        update ai_processing_consents set withdrawn_at = greatest(granted_at, clock_timestamp())
        where auth_user_id = ${authUserId} and withdrawn_at is null
        ${change.kind === "grant" ? sql`and disclosure_version <> ${change.disclosure.version}` : sql``}
      `);
      if (change.kind === "withdraw") return null;
      await tx.execute(sql`
        insert into ai_processing_consents (auth_user_id, disclosure_version, disclosure, platform)
        values (${authUserId}, ${change.disclosure.version}, ${JSON.stringify(change.disclosure)}::jsonb, ${change.platform})
        on conflict (auth_user_id) where withdrawn_at is null do nothing
      `);
    }
    const [row] = await tx.execute<{
      version: string;
      grantedAt: string | Date;
      platform: AiProcessingConsentPlatform;
    }>(sql`
      select disclosure_version as version, granted_at as "grantedAt", platform
      from ai_processing_consents
      where auth_user_id = ${authUserId} and disclosure_version = ${version} and withdrawn_at is null
    `);
    return row ? { ...row, grantedAt: new Date(row.grantedAt).toISOString() } : null;
  });
}
