/**
 * Field rules that depend on the item type, shared by workspace-hosted and
 * connected vaults so an item is written the same way everywhere.
 *
 * - A type's standard fields (`VAULT_ITEM_TYPE_FIELDS`) default to their own
 *   kind: a card's "number" is concealed, an SSH key's "public key" is text.
 * - An `ssh_key` item's "public key" and "fingerprint" always match its
 *   "private key": Opengeni derives them whenever the private key is written
 *   (or generated with `generateKey`), and refuses a public key that belongs
 *   to another key. A passphrase-protected PEM key cannot be read, so its
 *   public key must be given; the fingerprint is then derived from it.
 */
import {
  VAULT_ITEM_TYPE_FIELDS,
  standardVaultFieldName,
  type GenerateSshKeySpec,
  type VaultFieldKind,
  type VaultItemType,
} from "@opengeni/contracts";
import { VaultError } from "@opengeni/db";
import {
  generateSshKeyPair,
  looksLikeSshPrivateKey,
  sshPublicKeyFingerprint,
  sshPublicKeyFromPrivateKey,
} from "@opengeni/vaults";

export interface TypedFieldSource {
  name: string;
  kind?: VaultFieldKind | undefined;
  value?: string | undefined;
  generate?: unknown;
  generateKey?: GenerateSshKeySpec | { algorithm?: GenerateSshKeySpec["algorithm"] } | undefined;
  fromReference?: string | undefined;
  fileBase64?: string | undefined;
  restoreVersion?: number | undefined;
  remove?: true | undefined;
}

/** The kind a standard field of this type has, else null. */
export function standardFieldKind(type: VaultItemType, name: string): VaultFieldKind | null {
  const standard = standardVaultFieldName(type, name);
  return VAULT_ITEM_TYPE_FIELDS[type].find((field) => field.name === standard)?.kind ?? null;
}

function isStandard(type: VaultItemType, field: { name: string }, standard: string): boolean {
  return standardVaultFieldName(type, field.name) === standard;
}

/**
 * The fields to write for an item of `type`: SSH key pairs generated and
 * public keys and fingerprints derived (see the module comment). Other types
 * pass through unchanged, except that `generateKey` belongs only to an SSH
 * key's "private key".
 */
export async function prepareTypedFields<T extends TypedFieldSource>(
  type: VaultItemType,
  fields: readonly T[],
  resolveReference: (raw: string) => Promise<string>,
  generated: string[],
): Promise<T[]> {
  for (const field of fields) {
    if (
      field.generateKey !== undefined &&
      (type !== "ssh_key" || !isStandard(type, field, "private key"))
    ) {
      throw new VaultError(
        "invalid_secret_name",
        'generateKey makes a key pair for the "private key" field of an ssh_key item',
        { field: field.name, type },
      );
    }
  }
  if (type !== "ssh_key") return [...fields];
  const out = [...fields];
  const privateIndex = out.findIndex(
    (field) =>
      isStandard(type, field, "private key") &&
      !field.remove &&
      field.restoreVersion === undefined &&
      field.fileBase64 === undefined,
  );
  if (privateIndex < 0) return out;
  const source = out[privateIndex]!;
  let privateKey: string;
  let derived: { publicKey: string; fingerprint: string } | null;
  if (source.generateKey !== undefined) {
    const pair = generateSshKeyPair(source.generateKey.algorithm ?? "ed25519");
    privateKey = pair.privateKey;
    derived = pair;
    generated.push(source.name);
  } else {
    privateKey =
      source.fromReference !== undefined
        ? await resolveReference(source.fromReference)
        : (source.value ?? "");
    if (!looksLikeSshPrivateKey(privateKey)) {
      throw new VaultError(
        "invalid_secret_name",
        `${source.name} is not an SSH private key (OpenSSH or PEM text)`,
        { field: source.name },
      );
    }
    derived = sshPublicKeyFromPrivateKey(privateKey);
  }
  out[privateIndex] = {
    ...source,
    kind: "concealed",
    value: privateKey,
    generateKey: undefined,
    fromReference: undefined,
  } as T;
  const given = out.find(
    (field) => isStandard(type, field, "public key") && !field.remove && field.value !== undefined,
  );
  const givenFingerprint = given?.value ? sshPublicKeyFingerprint(given.value) : null;
  if (given?.value && !givenFingerprint) {
    throw new VaultError("invalid_secret_name", `${given.name} is not an OpenSSH public key`, {
      field: given.name,
    });
  }
  if (derived && givenFingerprint && givenFingerprint !== derived.fingerprint) {
    throw new VaultError(
      "invalid_secret_name",
      `${given!.name} belongs to another key than ${source.name}`,
      { field: given!.name },
    );
  }
  const publicKey = derived?.publicKey ?? given?.value ?? null;
  const fingerprint = derived?.fingerprint ?? givenFingerprint;
  const set = (standard: string, value: string | null) => {
    if (value === null) return;
    const index = out.findIndex((field) => isStandard(type, field, standard));
    const field = { name: standard, kind: "text" as const, value } as T;
    if (index >= 0)
      out[index] = {
        ...out[index]!,
        kind: "text",
        value,
        remove: undefined,
        generate: undefined,
        fromReference: undefined,
      } as T;
    else out.push(field);
  };
  // A given public key keeps its own comment.
  set("public key", given?.value && givenFingerprint === fingerprint ? given.value : publicKey);
  set("fingerprint", fingerprint);
  return out;
}
