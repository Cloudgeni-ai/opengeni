import { sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";

/** Server-only: call after verifying the exact enrollment's Ed25519 renewal
 * signature. The database derives the key and account; no caller-supplied key,
 * label, path, IP address or external account can become correlation evidence.
 *
 * Stored keys are base64 as the agent sent them: agents send standard base64
 * without padding (43 characters for an Ed25519 key), and the renewal check
 * decodes them leniently. PostgreSQL's `decode(..., 'base64')` requires
 * padding, so the key is normalized first (URL-safe characters mapped, anything
 * outside the alphabet dropped, padding restored); otherwise every real
 * machine's renewal fails here and the machine stays offline. */
export async function recordMachinePromotionProof(
  db: Database,
  input: { workspaceId: string; enrollmentId: string; credentialGeneration: number },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`insert into promotion_machine_proofs(account_id,enrollment_id,credential_generation,key_hash)
      select account_id,id,credential_generation,
        encode(sha256(decode(rpad(key.b64, ((length(key.b64) + 3) / 4) * 4, '='), 'base64')), 'hex')
      from enrollments,
        lateral (select regexp_replace(translate(pubkey, '-_', '+/'), '[^A-Za-z0-9+/]', '', 'g') as b64) key
      where workspace_id=${input.workspaceId}::uuid
        and id=${input.enrollmentId}::uuid and credential_generation=${input.credentialGeneration}::integer
        and status='active' and kind='machine' and pubkey is not null
      on conflict do nothing`);
  });
}
