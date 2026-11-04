import {
  INTERACTION_REDACTED_SECRET,
  INTERACTION_SECRET_MASK_OPTIONS,
  type InteractionSecretValues,
  SecretValueMemory,
  maskSecretValues,
} from "@opengeni/contracts";

/** Most distinct secret values one controller remembers; the oldest drop first. */
const MAX_REMEMBERED_SECRETS = 256;

/** Typed values per session, for the life of this process. A session enters
 * only once a secret is typed into it, and never leaves while the process
 * runs: it can be reattached at any time, and dropping its values would show
 * them again. */
type SessionSecrets = {
  memory: SecretValueMemory;
  paymentTargets: Set<string>;
  /** Card numbers and security codes must not age out behind other values. */
  paymentValues: Set<string>;
};
const sessions = new Map<string, SessionSecrets>();

function newMemory(): SecretValueMemory {
  return new SecretValueMemory({
    ...INTERACTION_SECRET_MASK_OPTIONS,
    maxEntries: MAX_REMEMBERED_SECRETS,
  });
}

function newSessionSecrets(): SessionSecrets {
  return { memory: newMemory(), paymentTargets: new Set(), paymentValues: new Set() };
}

/**
 * Secret values typed into one browser or computer session's pages or desktop.
 *
 * A value typed from a secret reference stays in the field (and can be echoed
 * elsewhere on the page) after the action that typed it. Every later
 * observation, read, tab list, dialog and error for the same session is
 * redacted against all of them, not only the action that carried the value,
 * so form field values can be shown without ever showing a typed secret. The
 * memory belongs to the session, not to one driver, so a controller that
 * reattaches to the same live browser or desktop keeps it.
 *
 * This is the shared known-value `SecretValueMemory` (the one agent tool
 * results use) with the interaction options: `[secret]` as the label, a
 * three-character minimum (including CVCs) and identifier keys left alone.
 */
export class TypedSecretMemory {
  private localState: SessionSecrets | null = null;

  protectPaymentImages(targetId: string): void {
    this.state(true)!.paymentTargets.add(targetId);
  }

  paymentImagesProtected(targetId: string): boolean {
    return this.state(false)?.paymentTargets.has(targetId) === true;
  }

  containsPaymentValue(candidate: unknown): boolean {
    const entries = [...(this.state(false)?.paymentValues ?? [])]
      .filter((value) => value.length >= 12)
      .map((value) => ({ value, label: INTERACTION_REDACTED_SECRET }));
    return (
      entries.length > 0 &&
      maskSecretValues(candidate, entries, INTERACTION_SECRET_MASK_OPTIONS) !== candidate
    );
  }

  /** A memory of its own (tests, one-off use); forSession shares one per session. */
  constructor(private readonly sessionKey: string | null = null) {}

  /** The memory shared by every driver of one session in this process. */
  static forSession(kind: "browser" | "computer", sessionId: string): TypedSecretMemory {
    return new TypedSecretMemory(`${kind}:${sessionId}`);
  }

  private state(create: boolean): SessionSecrets | null {
    if (this.sessionKey === null) {
      if (create && this.localState === null) this.localState = newSessionSecrets();
      return this.localState;
    }
    let state = sessions.get(this.sessionKey) ?? null;
    if (state === null && create) {
      state = newSessionSecrets();
      sessions.set(this.sessionKey, state);
    }
    return state;
  }

  private entries() {
    const state = this.state(false);
    return [
      ...(state?.memory.entries() ?? []),
      ...[...(state?.paymentValues ?? [])].map((value) => ({
        value,
        label: INTERACTION_REDACTED_SECRET,
      })),
    ];
  }

  remember(secretValues: InteractionSecretValues | undefined): void {
    if (secretValues === undefined) return;
    // One-time codes are remembered too: a code stays valid, and visible in
    // its field, after the action that typed it.
    for (const value of Object.values(secretValues)) {
      if (value.length < INTERACTION_SECRET_MASK_OPTIONS.minChars!) continue;
      const state = this.state(true)!;
      state.memory.remember(value, INTERACTION_REDACTED_SECRET);
      // These came from an explicit secret use or primary password/payment
      // field discovery, never from arbitrary hidden/private page metadata.
      const digits = value.replace(/[\s-]/gu, "");
      if (/^(?:[0-9]{3,4}|[0-9]{12,19})$/u.test(digits)) state.paymentValues.add(digits);
    }
  }

  /** The remembered values plus any currently supplied ones, in the shape
   * redactInteractionSecretValues takes; undefined when there are none. */
  merged(current?: InteractionSecretValues): InteractionSecretValues | undefined {
    const entries = this.entries();
    if (entries.length === 0) return current;
    const merged: Record<string, string> = {};
    let index = 0;
    for (const { value } of entries) merged[`remembered:${index++}`] = value;
    if (current !== undefined) {
      for (const [key, secret] of Object.entries(current)) merged[`current:${key}`] = secret;
    }
    return merged;
  }

  /** Deep copy with every remembered (and every currently supplied) secret replaced. */
  redact<T>(value: T, current?: InteractionSecretValues): T {
    const extra = Object.values(current ?? {}).map((secret) => ({
      value: secret,
      label: INTERACTION_REDACTED_SECRET,
    }));
    // Browser output is a security boundary: unlike best-effort masking in
    // general telemetry, a masking error must withhold the result, not return
    // the original plaintext. The pure engine propagates such failures.
    return maskSecretValues(value, [...this.entries(), ...extra], INTERACTION_SECRET_MASK_OPTIONS);
  }
}
