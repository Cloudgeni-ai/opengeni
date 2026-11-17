import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Relay for a native sign-in that can't receive a redirect: the Excel add-in on
// desktop Office opens /native-sign-in in the person's own browser, which has no
// way back into the task pane. The pane creates a relay holding its PKCE
// challenge and gets a short confirmation code to show. The signed-in browser
// approves the relay only with that code typed in; the server then mints the
// ordinary one-time native app code and parks it in the relay. The pane polls
// with its verifier, takes the code once and redeems it at /v1/native-app/token.
//
// The code never passes through the browser, a relay id alone releases
// nothing (polls need the verifier), and every state lives in short-lived
// single-use verification rows.

export const NATIVE_APP_RELAY_TTL_MS = 5 * 60 * 1_000;
/** Wrong confirmation codes a relay accepts before it is refused for good. */
export const NATIVE_APP_RELAY_MAX_ATTEMPTS = 5;
const RELAY_IDENTIFIER_PREFIX = "opengeni-native-app-relay:";
/** Unambiguous letters and digits (no 0/O, 1/I/L, 5/S, 2/Z). */
const CONFIRMATION_ALPHABET = "ABCDEFGHJKMNPQRTUVWXY346789";
const CONFIRMATION_LENGTH = 6;
export const NATIVE_APP_RELAY_ID = /^[A-Za-z0-9_-]{43}$/u;

/** The short-lived single-use rows the relay lives in (Better Auth verification values). */
export type NativeAppRelayStore = {
  find(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  /** Atomically takes the row: exactly one concurrent caller gets it. */
  consume(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  create(row: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  update(identifier: string, row: { value: string }): Promise<unknown>;
};

export type NativeAppRelayRequest = {
  codeChallenge: string;
  redirectUri: string;
  platform: string;
  deviceName: string | null;
};

type RelayState = NativeAppRelayRequest & {
  confirmationCode: string;
  attempts: number;
  /** pending → approved (holds the app code) | refused. */
  status: "pending" | "approved" | "refused";
  code?: string;
};

export type NativeAppRelayPoll =
  | { status: "pending" }
  | { status: "approved"; code: string }
  | { status: "refused" }
  /** Unknown, expired, already taken, or not this verifier's. */
  | { status: "gone" };

export type NativeAppRelayApproval =
  | { status: "approved" }
  | { status: "mismatch"; attemptsLeft: number }
  | { status: "gone" };

function relayIdentifier(relayId: string): string {
  return `${RELAY_IDENTIFIER_PREFIX}${createHash("sha256").update(relayId, "utf8").digest("hex")}`;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function parseState(value: string): RelayState | null {
  try {
    const state = JSON.parse(value) as RelayState;
    return typeof state.codeChallenge === "string" && typeof state.confirmationCode === "string"
      ? state
      : null;
  } catch {
    return null;
  }
}

export function newConfirmationCode(): string {
  let code = "";
  for (let index = 0; index < CONFIRMATION_LENGTH; index += 1) {
    code += CONFIRMATION_ALPHABET[randomInt(CONFIRMATION_ALPHABET.length)];
  }
  return code;
}

/** What the person typed, as stored: case, spaces and dashes don't matter. */
export function normalizeConfirmationCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/gu, "");
}

export function createNativeAppRelays(store: NativeAppRelayStore, now: () => number = Date.now) {
  const live = async (relayId: string) => {
    const row = await store.find(relayIdentifier(relayId));
    if (!row || row.expiresAt.getTime() <= now()) return null;
    const state = parseState(row.value);
    return state ? { state, expiresAt: row.expiresAt } : null;
  };

  return {
    async create(
      request: NativeAppRelayRequest,
    ): Promise<{ relayId: string; confirmationCode: string; expiresAt: Date }> {
      const relayId = randomBytes(32).toString("base64url");
      const confirmationCode = newConfirmationCode();
      const expiresAt = new Date(now() + NATIVE_APP_RELAY_TTL_MS);
      const state: RelayState = { ...request, confirmationCode, attempts: 0, status: "pending" };
      await store.create({
        identifier: relayIdentifier(relayId),
        value: JSON.stringify(state),
        expiresAt,
      });
      return { relayId, confirmationCode, expiresAt };
    },

    /**
     * The signed-in browser approves with the code the pane shows. `mint`
     * makes the app's one-time code for this relay's request; it runs only
     * for the single caller that wins the relay.
     */
    async approve(
      relayId: string,
      typedCode: string,
      mint: (request: NativeAppRelayRequest) => Promise<string>,
    ): Promise<NativeAppRelayApproval> {
      const found = await live(relayId);
      if (!found || found.state.status !== "pending") return { status: "gone" };
      const identifier = relayIdentifier(relayId);
      if (!sameText(normalizeConfirmationCode(typedCode), found.state.confirmationCode)) {
        const attempts = found.state.attempts + 1;
        const refused = attempts >= NATIVE_APP_RELAY_MAX_ATTEMPTS;
        await store.update(identifier, {
          value: JSON.stringify({
            ...found.state,
            attempts,
            status: refused ? "refused" : "pending",
          }),
        });
        return refused
          ? { status: "gone" }
          : { status: "mismatch", attemptsLeft: NATIVE_APP_RELAY_MAX_ATTEMPTS - attempts };
      }
      // Single use: only the caller that takes the pending row goes on.
      const taken = await store.consume(identifier);
      const state = taken ? parseState(taken.value) : null;
      if (!taken || !state || state.status !== "pending" || taken.expiresAt.getTime() <= now()) {
        return { status: "gone" };
      }
      const code = await mint(state);
      await store.create({
        identifier,
        value: JSON.stringify({ ...state, status: "approved", code }),
        expiresAt: taken.expiresAt,
      });
      return { status: "approved" };
    },

    /** The pane asks with its verifier; an approved code is handed out once. */
    async poll(relayId: string, codeVerifier: string): Promise<NativeAppRelayPoll> {
      const found = await live(relayId);
      if (!found || !sameText(found.state.codeChallenge, challengeOf(codeVerifier))) {
        return { status: "gone" };
      }
      if (found.state.status === "pending") return { status: "pending" };
      if (found.state.status === "refused") return { status: "refused" };
      const taken = await store.consume(relayIdentifier(relayId));
      const state = taken ? parseState(taken.value) : null;
      if (!state || state.status !== "approved" || !state.code) return { status: "gone" };
      return { status: "approved", code: state.code };
    },
  };
}

export type NativeAppRelays = ReturnType<typeof createNativeAppRelays>;
