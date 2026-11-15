import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
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
import { APIError } from "better-auth/api";
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
const HANDOFF_TTL_MS = 10 * 60_000;
const HANDOFF_IDENTIFIER_PREFIX = "opengeni-passkey-handoff:";
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

export type ManagedPasskeyCeremonyKind = "sign_in" | "sign_up" | "register" | "step_up";

const StoredCeremony = z
  .object({
    version: z.literal(1),
    kind: z.enum(["sign_in", "sign_up", "register", "step_up"]),
    challenge: z.string().min(16),
    origin: z.string().url(),
    rpId: z.string().min(1),
    userId: z.string().min(1).optional(),
    /** A step-up: the browser session it confirms. */
    authSessionId: z.string().min(1).optional(),
    /** A step-up confirming, too, the app session that handed it over. */
    handoffId: z.string().uuid().optional(),
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
 * A Better Auth refusal (session admission or a sign-up gate) with its error
 * code, or null when the error is anything else, such as a database outage.
 */
export function managedAuthRefusal(error: unknown): { code: string | null } | null {
  if (!(error instanceof APIError)) return null;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  return { code: typeof code === "string" ? code : null };
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

/**
 * A signed-in person confirming it's them with one of their own passkeys
 * (admin step-up). The ceremony is bound to that person.
 */
export async function startManagedPasskeyStepUp(
  auth: ManagedAuth,
  relyingParty: { origin: string; rpId: string },
  input: {
    userId: string;
    authSessionId: string;
    allow: { credentialId: string; transports: string[] }[];
    /** A handoff from the person's app session that this step-up confirms too. */
    handoffId?: string;
  },
): Promise<{ challengeId: string; options: Record<string, unknown> }> {
  const options = await generateAuthenticationOptions({
    rpID: relyingParty.rpId,
    userVerification: "required",
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: input.allow.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
  });
  const challengeId = await storeCeremony(auth, {
    version: 1,
    kind: "step_up",
    challenge: options.challenge,
    ...relyingParty,
    userId: input.userId,
    authSessionId: input.authSessionId,
    ...(input.handoffId ? { handoffId: input.handoffId } : {}),
  });
  return { challengeId, options: options as unknown as Record<string, unknown> };
}

/* ----------------------------------------------------------------------------
   Step-up handoff. An app that shows the web console but can't show passkey
   prompts itself (the desktop app: Electron has no WebAuthn UI on macOS or
   Linux, so a ceremony there never reaches the system sheet or a password
   manager) hands its step-up to the person's own browser on the same server.

   1. The app's session starts a handoff, bound to that session.
   2. In their browser, signed in to the same account, the person uses one of
      their passkeys for it. Only then does the server make a random one-time
      code, which that browser page shows.
   3. The person types the code into the app; the app's own session claims the
      handoff with it, which confirms that session.

   A browser confirmation alone never confirms another session: whoever
   started the handoff must also hold the code the passkey produced, so a
   forwarded link can't lend someone else's passkey to a stolen session. A
   handoff is single-use, short-lived, and void after a few wrong codes.
   -------------------------------------------------------------------------- */

export const MANAGED_PASSKEY_HANDOFF_MAX_CODE_ATTEMPTS = 5;

const StoredHandoff = z
  .object({
    version: z.literal(1),
    userId: z.string().min(1),
    /** The app's session the step-up confirms. */
    authSessionId: z.string().min(1),
    expiresAt: z.string(),
    /** Set once the browser confirmed with a passkey. */
    confirmation: z
      .object({ codeHash: z.string().min(1), attempts: z.number().int().min(0) })
      .strict()
      .optional(),
  })
  .strict();
export type ManagedPasskeyHandoff = z.infer<typeof StoredHandoff> & { handoffId: string };

function handoffIdentifier(handoffId: string): string {
  return `${HANDOFF_IDENTIFIER_PREFIX}${handoffId}`;
}

function handoffCodeHash(handoffId: string, code: string): Buffer {
  return createHash("sha256").update(`opengeni-passkey-handoff:${handoffId}:${code}`).digest();
}

async function storeHandoff(
  auth: ManagedAuth,
  handoffId: string,
  handoff: z.infer<typeof StoredHandoff>,
): Promise<void> {
  const context = await auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: handoffIdentifier(handoffId),
    value: JSON.stringify(StoredHandoff.parse(handoff)),
    expiresAt: new Date(handoff.expiresAt),
  });
}

function withoutId(handoff: ManagedPasskeyHandoff): z.infer<typeof StoredHandoff> {
  const { handoffId: _handoffId, ...stored } = handoff;
  return stored;
}

export async function startManagedPasskeyHandoff(
  auth: ManagedAuth,
  input: { userId: string; authSessionId: string },
): Promise<ManagedPasskeyHandoff & { expiresInSeconds: number }> {
  const handoffId = randomUUID();
  const stored = StoredHandoff.parse({
    version: 1,
    userId: input.userId,
    authSessionId: input.authSessionId,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS).toISOString(),
  });
  await storeHandoff(auth, handoffId, stored);
  return { ...stored, handoffId, expiresInSeconds: HANDOFF_TTL_MS / 1000 };
}

function parseHandoff(
  handoffId: string,
  stored: { value?: string | null; expiresAt: Date | string } | null | undefined,
): ManagedPasskeyHandoff | null {
  if (!stored?.value || new Date(stored.expiresAt).getTime() <= Date.now()) return null;
  try {
    return { ...StoredHandoff.parse(JSON.parse(stored.value)), handoffId };
  } catch {
    return null;
  }
}

/** A live handoff, without using it up; null when missing or expired. */
export async function findManagedPasskeyHandoff(
  auth: ManagedAuth,
  handoffId: string,
): Promise<ManagedPasskeyHandoff | null> {
  const context = await auth.$context;
  return parseHandoff(
    handoffId,
    await context.internalAdapter.findVerificationValue(handoffIdentifier(handoffId)),
  );
}

/** Take a handoff exactly once; null when missing, expired or already taken. */
async function takeManagedPasskeyHandoff(
  auth: ManagedAuth,
  handoffId: string,
): Promise<ManagedPasskeyHandoff | null> {
  const context = await auth.$context;
  return parseHandoff(
    handoffId,
    await context.internalAdapter.consumeVerificationValue(handoffIdentifier(handoffId)),
  );
}

/**
 * The browser confirmed the handoff with the person's passkey: make the
 * one-time code the app claims it with. Null when the handoff is gone, is
 * someone else's, or was already confirmed (a second confirmation voids it).
 */
export async function confirmManagedPasskeyHandoff(
  auth: ManagedAuth,
  handoffId: string,
  userId: string,
): Promise<{ code: string } | null> {
  const handoff = await takeManagedPasskeyHandoff(auth, handoffId);
  if (!handoff || handoff.userId !== userId || handoff.confirmation) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await storeHandoff(auth, handoffId, {
    ...withoutId(handoff),
    confirmation: { codeHash: handoffCodeHash(handoffId, code).toString("hex"), attempts: 0 },
  });
  return { code };
}

export type ManagedPasskeyHandoffClaim =
  | { kind: "claimed" }
  | { kind: "expired" }
  | { kind: "other_session" }
  | { kind: "not_confirmed" }
  | { kind: "wrong_code"; attemptsLeft: number }
  | { kind: "too_many_attempts" };

/**
 * The app's session claims its handoff with the code the browser showed.
 * Only the session that started it can; each wrong code uses up a try, and
 * the last one voids the handoff.
 */
export async function claimManagedPasskeyHandoff(
  auth: ManagedAuth,
  handoffId: string,
  input: { userId: string; authSessionId: string; code: string },
): Promise<ManagedPasskeyHandoffClaim> {
  const found = await findManagedPasskeyHandoff(auth, handoffId);
  if (!found) return { kind: "expired" };
  if (found.userId !== input.userId || found.authSessionId !== input.authSessionId) {
    return { kind: "other_session" };
  }
  if (!found.confirmation) return { kind: "not_confirmed" };
  const handoff = await takeManagedPasskeyHandoff(auth, handoffId);
  if (!handoff?.confirmation) return { kind: "expired" };
  const expected = Buffer.from(handoff.confirmation.codeHash, "hex");
  const given = handoffCodeHash(handoffId, input.code);
  if (expected.length === given.length && timingSafeEqual(expected, given)) {
    return { kind: "claimed" };
  }
  const attempts = handoff.confirmation.attempts + 1;
  if (attempts >= MANAGED_PASSKEY_HANDOFF_MAX_CODE_ATTEMPTS) return { kind: "too_many_attempts" };
  await storeHandoff(auth, handoffId, {
    ...withoutId(handoff),
    confirmation: { ...handoff.confirmation, attempts },
  });
  return { kind: "wrong_code", attemptsLeft: MANAGED_PASSKEY_HANDOFF_MAX_CODE_ATTEMPTS - attempts };
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
