/**
 * The hosted values of secrets a session tree already used, for masking only
 * (docs/secrets.md, Masking): a value written to a file in an earlier turn is
 * still masked when a later turn prints it.
 *
 * Values are looked up with the attempt's own vault reach and decrypted in
 * memory. They are never delivered anywhere, so this is not a use: no audit
 * row, no approval. Connected vaults (1Password, host) are skipped, since
 * reading them costs provider calls. Best effort: callers ignore failures.
 */
import {
  parseSecretReference,
  secretReferenceMaskLabel,
  type SecretPrincipal,
  type SecretValueMaskEntry,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  listSessionTreeSecretUses,
  resolveSecretReferenceCandidates,
  type Database,
  type SecretReferenceLookup,
} from "@opengeni/db";

/** Fields looked up per attempt start or refresh. */
const USED_SECRET_VALUES_MAX_FIELDS = 200;

export async function loadSessionTreeSecretValues(
  deps: { db: Database; encryptionKey: Uint8Array | null },
  principal: Extract<SecretPrincipal, { kind: "attempt" }>,
  options: { after?: Date | null; limit?: number; timeoutMs?: number } = {},
): Promise<{ entries: SecretValueMaskEntry[]; latestAt: Date | null }> {
  if (deps.encryptionKey === null) return { entries: [], latestAt: null };
  const { uses, latestAt } = await listSessionTreeSecretUses(deps.db, {
    accountId: principal.accountId,
    workspaceId: principal.workspaceId,
    sessionId: principal.sessionId,
    ...(options.after ? { after: options.after } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  // Current values only: a one-time code or an earlier version is a
  // different value from what the reference resolves to now.
  const wanted = uses
    .filter((use) => {
      try {
        const reference = parseSecretReference(use.reference);
        return !reference.otp && !reference.previous;
      } catch {
        return false;
      }
    })
    .slice(0, USED_SECRET_VALUES_MAX_FIELDS);
  if (wanted.length === 0) return { entries: [], latestAt };
  const refs: SecretReferenceLookup[] = wanted.map((use, index) => ({
    index,
    form: "id",
    itemId: use.itemId,
    field: use.fieldName,
    otp: false,
    previous: false,
  }));
  const found = await resolveSecretReferenceCandidates(
    deps.db,
    { kind: "principal", principal },
    { refs },
  );
  const entries: SecretValueMaskEntry[] = [];
  const done = new Set<number>();
  for (const candidate of found.candidates) {
    const use = wanted[candidate.refIndex];
    if (!use || done.has(candidate.refIndex)) continue;
    if (candidate.source !== "opengeni" || candidate.valueEncrypted === null) continue;
    if (candidate.itemId !== use.itemId || candidate.archived) continue;
    // A setup key is not what appears in text, file contents are bytes, and
    // a plain text field (a username, a host) is not secret.
    if (
      candidate.fieldKind === "totp" ||
      candidate.fieldKind === "file" ||
      candidate.fieldKind === "text"
    )
      continue;
    if (use.fieldId !== null && candidate.fieldId !== null && candidate.fieldId !== use.fieldId)
      continue;
    let value: string;
    try {
      value = decryptEnvironmentValue(deps.encryptionKey, candidate.valueEncrypted);
    } catch {
      continue;
    }
    done.add(candidate.refIndex);
    entries.push({
      value,
      // The ID form: the reference as another session in the tree wrote it
      // could name a different item here (another person's vault).
      label: secretReferenceMaskLabel({
        raw: "",
        itemId: candidate.itemId,
        fieldName: candidate.fieldName,
      }),
    });
  }
  return { entries, latestAt };
}
