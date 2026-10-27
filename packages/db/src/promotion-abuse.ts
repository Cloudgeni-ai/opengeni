import { sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";

/** Server-only: call after verifying the exact enrollment's Ed25519 renewal
 * signature. The database derives the key and account; no caller-supplied key,
 * label, path, IP address or external account can become correlation evidence. */
export async function recordMachinePromotionProof(
  db: Database,
  input: { workspaceId: string; enrollmentId: string; credentialGeneration: number },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(sql`insert into promotion_machine_proofs(account_id,enrollment_id,credential_generation,key_hash)
      select account_id,id,credential_generation,encode(sha256(decode(pubkey,'base64')),'hex')
      from enrollments where workspace_id=${input.workspaceId}::uuid
        and id=${input.enrollmentId}::uuid and credential_generation=${input.credentialGeneration}::integer
        and status='active' and kind='machine' and pubkey is not null
      on conflict do nothing`);
  });
}
