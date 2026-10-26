import { randomUUID } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { ManagedAuth } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { trustedBrowserOrigins } from "../http/browser-mutation-origin";

/**
 * WebAuthn ceremonies for managed accounts: passkey sign-in, account creation
 * with only a passkey, and adding a passkey to a signed-in account.
 *
 * Each ceremony's challenge is stored server-side as a single-use Better Auth
 * verification value bound to the exact browser origin that started it, so a
 * response can be verified once, from the same origin, within five minutes.
 * User verification (a PIN, biometric or device unlock) is always required:
 * a passkey alone is the whole sign-in, not a second factor.
 */

export const MANAGED_PASSKEY_RP_NAME = "Opengeni";
export const MANAGED_PASSKEY_LIMIT = 25;
const CEREMONY_TTL_MS = 5 * 60_000;
const CEREMONY_TIMEOUT_MS = 120_000;
const CEREMONY_IDENTIFIER_PREFIX = "opengeni-passkey:";
const TRANSPORTS = new Set<string>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const UNKNOWN_AAGUID = "00000000-0000-0000-0000-000000000000";

// Public AAGUIDs of common passkey providers, so a new passkey gets a name a
// person recognizes ("Bitwarden", "Apple Passwords") without asking.
const KNOWN_PROVIDERS: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "Apple Passwords",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": "LastPass",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export type ManagedPasskeyCeremonyKind = "sign_in" | "sign_up" | "register";

const StoredCeremony = z
  .object({
    version: z.literal(1),
    kind: z.enum(["sign_in", "sign_up", "register"]),
    challenge: z.string().min(16),
    origin: z.string().url(),
    rpId: z.string().min(1),
    userId: z.string().min(1).optional(),
    name: z.string().min(1).max(80).optional(),
    signupChallengeVerified: z.boolean().optional(),
  })
  .strict();
export type ManagedPasskeyStoredCeremony = z.infer<typeof StoredCeremony>;

/** The verified credential of a registration, ready to store. No secrets. */
export type ManagedPasskeyCredential = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  aaguid: string | null;
  name: string;
  rpId: string;
};

export class ManagedPasskeyError extends Error {
  readonly name = "ManagedPasskeyError";
  constructor(
    readonly code:
      | "PASSKEY_ORIGIN_NOT_ALLOWED"
      | "PASSKEY_CEREMONY_EXPIRED"
      | "PASSKEY_NOT_VERIFIED"
      | "PASSKEY_UNKNOWN_CREDENTIAL",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The relying party for one browser request: its exact origin, which must be
 * one of the deployment's trusted browser origins and a secure context
 * (https, or http on localhost), and that origin's host as the RP ID.
 */
export function managedPasskeyRelyingParty(
  settings: Pick<Settings, "publicBaseUrl"> & Parameters<typeof trustedBrowserOrigins>[0],
  originHeader: string | null | undefined,
): { origin: string; rpId: string } {
  const origins = settings.publicBaseUrl ? trustedBrowserOrigins(settings) : [];
  if (!originHeader || !origins.includes(originHeader)) {
    throw new ManagedPasskeyError(
      "PASSKEY_ORIGIN_NOT_ALLOWED",
      "Passkeys work only from this deployment's own web address",
    );
  }
  const url = new URL(originHeader);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new ManagedPasskeyError(
      "PASSKEY_ORIGIN_NOT_ALLOWED",
      "Passkeys need a secure (https) web address",
    );
  }
  return { origin: url.origin, rpId: url.hostname };
}

/** Whether browsers on this deployment's public address can use passkeys at all. */
export function managedPasskeysAvailable(settings: Pick<Settings, "publicBaseUrl">): boolean {
  if (!settings.publicBaseUrl) return false;
  try {
    const url = new URL(settings.publicBaseUrl);
    return url.protocol === "https:" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

const PASSKEY_STORAGE_GRANT_TTL_MS = 60_000;
const passkeyStorageGrants = new WeakMap<object, { granted: boolean; checkedAt: number }>();

/**
 * Whether the runtime may use passkey storage yet: DML on `auth_passkeys` and
 * EXECUTE on `mutate_managed_passkey`. Migration 0998 withholds both until a
 * release that knows them is the previous release (runtime-posture
 * RUNTIME_DEFERRED_FULL_DML_TABLES and DEFERRED_RUNTIME_TARGET_ROUTINES), and
 * passkeys stay off until a later migration grants them. Checked at most once
 * a minute per database client, in its own statement because privileges are
 * checked when a statement starts.
 */
export async function refreshManagedPasskeyStorageGrant(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const cached = passkeyStorageGrants.get(db);
  if (cached && Date.now() - cached.checkedAt < PASSKEY_STORAGE_GRANT_TTL_MS) {
    return cached.granted;
  }
  const result = await db.execute(sql`
    select coalesce(
      has_table_privilege(to_regclass('auth_passkeys'), 'SELECT')
        and has_table_privilege(to_regclass('auth_passkeys'), 'INSERT')
        and has_table_privilege(to_regclass('auth_passkeys'), 'UPDATE')
        and has_table_privilege(to_regclass('auth_passkeys'), 'DELETE')
        and has_function_privilege(
          to_regprocedure('mutate_managed_passkey(text, text, jsonb)'), 'EXECUTE'),
      false
    ) as granted`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    granted: boolean | null;
  }[];
  const granted = rows[0]?.granted === true;
  passkeyStorageGrants.set(db, { granted, checkedAt: Date.now() });
  return granted;
}

/**
 * The last known passkey storage grant for this database client; false until
 * `refreshManagedPasskeyStorageGrant` has seen it granted. Request paths that
 * offer passkeys refresh it first.
 */
export function managedPasskeyStorageGranted(db: Pick<Database, "execute">): boolean {
  return passkeyStorageGrants.get(db)?.granted === true;
}

export function managedPasskeyDefaultName(aaguid: string | null): string {
  return (aaguid && KNOWN_PROVIDERS[aaguid]) || "Passkey";
}

async function storeCeremony(
  auth: ManagedAuth,
  ceremony: ManagedPasskeyStoredCeremony,
): Promise<string> {
  const challengeId = randomUUID();
  const context = await auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: `${CEREMONY_IDENTIFIER_PREFIX}${challengeId}`,
    value: JSON.stringify(StoredCeremony.parse(ceremony)),
    expiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
  });
  return challengeId;
}

/**
 * Take a ceremony exactly once. A missing, expired, reused or foreign
 * ceremony (another kind, or started from another origin) is refused.
 */
export async function consumeManagedPasskeyCeremony(
  auth: ManagedAuth,
  challengeId: string,
  expected: { kind: ManagedPasskeyCeremonyKind; origin: string },
): Promise<ManagedPasskeyStoredCeremony> {
  const context = await auth.$context;
  const stored = await context.internalAdapter.consumeVerificationValue(
    `${CEREMONY_IDENTIFIER_PREFIX}${challengeId}`,
  );
  const expired = () =>
    new ManagedPasskeyError("PASSKEY_CEREMONY_EXPIRED", "This passkey request expired; try again");
  if (!stored?.value || new Date(stored.expiresAt).getTime() <= Date.now()) throw expired();
  let parsed: ManagedPasskeyStoredCeremony;
  try {
    parsed = StoredCeremony.parse(JSON.parse(stored.value));
  } catch {
    throw expired();
  }
  if (parsed.kind !== expected.kind || parsed.origin !== expected.origin) throw expired();
  return parsed;
}

export async function startManagedPasskeySignIn(
  auth: ManagedAuth,
  relyingParty: { origin: string; rpId: string },
): Promise<{ challengeId: string; options: Record<string, unknown> }> {
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpId,
    userVerification: "required",
    timeout: CEREMONY_TIMEOUT_MS,
  });
  const challengeId = await storeCeremony(auth, {
    version: 1,
    kind: "sign_in",
    challenge: options.challenge,
    ...relyingParty,
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

export async function startManagedPasskeyRegistration(
  auth: ManagedAuth,
  input: {
    kind: "sign_up" | "register";
    relyingParty: { origin: string; rpId: string };
    userId: string;
    userName: string;
    displayName: string;
    name?: string;
    signupChallengeVerified?: boolean;
    exclude: { credentialId: string; transports: string[] }[];
  },
): Promise<{ challengeId: string; options: Record<string, unknown> }> {
  const options = await generateRegistrationOptions({
    rpName: MANAGED_PASSKEY_RP_NAME,
    rpID: input.relyingParty.rpId,
    userID: isoUint8Array.fromUTF8String(input.userId),
    userName: input.userName,
    userDisplayName: input.displayName,
    attestationType: "none",
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: input.exclude.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = await storeCeremony(auth, {
    version: 1,
    kind: input.kind,
    challenge: options.challenge,
    ...input.relyingParty,
    userId: input.userId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.signupChallengeVerified !== undefined
      ? { signupChallengeVerified: input.signupChallengeVerified }
      : {}),
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

/**
 * Whether the browser ran this ceremony inside a frame from another site.
 * Any site may frame these pages, so a ceremony from a frame could be one the
 * person was tricked into; passkeys here are used only on the page itself.
 */
function madeInCrossOriginFrame(response: unknown): boolean {
  const clientData = (response as { response?: { clientDataJSON?: unknown } } | null)?.response
    ?.clientDataJSON;
  if (typeof clientData !== "string") return false;
  try {
    return (
      (JSON.parse(isoBase64URL.toUTF8String(clientData)) as { crossOrigin?: unknown })
        ?.crossOrigin === true
    );
  } catch {
    return false;
  }
}

export async function verifyManagedPasskeyRegistration(
  ceremony: ManagedPasskeyStoredCeremony,
  response: unknown,
  name?: string,
): Promise<ManagedPasskeyCredential> {
  if (madeInCrossOriginFrame(response)) {
    throw new ManagedPasskeyError("PASSKEY_NOT_VERIFIED", "The passkey could not be verified");
  }
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      requireUserVerification: true,
    });
  } catch {
    result = { verified: false };
  }
  if (!result.verified) {
    throw new ManagedPasskeyError("PASSKEY_NOT_VERIFIED", "The passkey could not be verified");
  }
  const info = result.registrationInfo;
  const aaguid = info.aaguid && info.aaguid !== UNKNOWN_AAGUID ? info.aaguid.toLowerCase() : null;
  const transports = (info.credential.transports ?? []).filter((transport) =>
    TRANSPORTS.has(transport),
  );
  return {
    credentialId: info.credential.id,
    publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
    counter: info.credential.counter,
    transports: [...new Set(transports)],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    aaguid,
    // `ceremony.name` is a new account's name, never the passkey's.
    name: name?.trim() || managedPasskeyDefaultName(aaguid),
    rpId: ceremony.rpId,
  };
}

type StoredPasskeyRow = {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: string | number;
  transports: string[];
  rpId: string;
};

async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Verify a sign-in assertion against the stored credential and record its use.
 * Returns the auth user the passkey belongs to.
 */
export async function verifyManagedPasskeySignIn(
  db: Database,
  ceremony: ManagedPasskeyStoredCeremony,
  response: unknown,
): Promise<{ authUserId: string; passkeyId: string }> {
  const assertion = response as AuthenticationResponseJSON;
  const unknown = () =>
    new ManagedPasskeyError(
      "PASSKEY_UNKNOWN_CREDENTIAL",
      "This passkey isn't connected to an account here",
    );
  if (typeof assertion?.id !== "string" || assertion.id !== assertion.rawId) throw unknown();
  if (madeInCrossOriginFrame(assertion)) {
    throw new ManagedPasskeyError("PASSKEY_NOT_VERIFIED", "The passkey could not be verified");
  }
  const [stored] = await rows<StoredPasskeyRow>(
    db,
    sql`select id, user_id as "userId", credential_id as "credentialId", public_key as "publicKey",
      counter, transports, rp_id as "rpId"
      from auth_passkeys where credential_id = ${assertion.id}`,
  );
  if (!stored || stored.rpId !== ceremony.rpId) throw unknown();
  const userHandle = assertion.response?.userHandle;
  if (userHandle && userHandle !== isoBase64URL.fromUTF8String(stored.userId)) throw unknown();
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: Number(stored.counter),
        transports: stored.transports,
      },
    });
  } catch {
    throw new ManagedPasskeyError("PASSKEY_NOT_VERIFIED", "The passkey could not be verified");
  }
  if (!result.verified) {
    throw new ManagedPasskeyError("PASSKEY_NOT_VERIFIED", "The passkey could not be verified");
  }
  // The signature counter only moves forward; a concurrent use that already
  // advanced it past this one leaves it there.
  await db.execute(sql`
    update auth_passkeys
    set counter = greatest(counter, ${result.authenticationInfo.newCounter}),
      backed_up = ${result.authenticationInfo.credentialBackedUp},
      last_used_at = clock_timestamp()
    where id = ${stored.id}`);
  return { authUserId: stored.userId, passkeyId: stored.id };
}

export async function listManagedPasskeyCredentials(
  db: Database,
  authUserId: string,
): Promise<{ credentialId: string; transports: string[] }[]> {
  return await rows(
    db,
    sql`select credential_id as "credentialId", transports from auth_passkeys
      where user_id = ${authUserId} order by created_at, id`,
  );
}
