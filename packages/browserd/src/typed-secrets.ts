import {
  INTERACTION_MIN_REDACTED_SECRET_CHARS,
  type InteractionSecretValues,
  redactInteractionSecretValues,
} from "@opengeni/contracts";

/** Most distinct secret values one controller remembers; the oldest drop first. */
const MAX_REMEMBERED_SECRETS = 256;

/** Typed values per session, for the life of this process. A session enters
 * only once a secret is typed into it, and never leaves while the process
 * runs: it can be reattached at any time, and dropping its values would show
 * them again. */
const sessions = new Map<string, Set<string>>();

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
 */
export class TypedSecretMemory {
  private localValues: Set<string> | null = null;

  /** A memory of its own (tests, one-off use); forSession shares one per session. */
  constructor(private readonly sessionKey: string | null = null) {}

  /** The memory shared by every driver of one session in this process. */
  static forSession(kind: "browser" | "computer", sessionId: string): TypedSecretMemory {
    return new TypedSecretMemory(`${kind}:${sessionId}`);
  }

  private values(create: boolean): Set<string> | null {
    if (this.sessionKey === null) {
      if (create && this.localValues === null) this.localValues = new Set();
      return this.localValues;
    }
    let values = sessions.get(this.sessionKey) ?? null;
    if (values === null && create) {
      values = new Set();
      sessions.set(this.sessionKey, values);
    }
    return values;
  }

  remember(secretValues: InteractionSecretValues | undefined): void {
    if (secretValues === undefined) return;
    // One-time codes are remembered too: a code stays valid, and visible in
    // its field, after the action that typed it.
    for (const value of Object.values(secretValues)) {
      if (value.length < INTERACTION_MIN_REDACTED_SECRET_CHARS) continue;
      const values = this.values(true);
      if (values === null) return;
      values.delete(value);
      values.add(value);
      if (values.size > MAX_REMEMBERED_SECRETS) {
        const oldest = values.values().next().value;
        if (oldest !== undefined) values.delete(oldest);
      }
    }
  }

  /** The remembered values plus any currently supplied ones, in the shape
   * redactInteractionSecretValues takes; undefined when there are none. */
  merged(current?: InteractionSecretValues): InteractionSecretValues | undefined {
    const values = this.values(false);
    if (values === null || values.size === 0) return current;
    const merged: Record<string, string> = {};
    let index = 0;
    for (const remembered of values) merged[`remembered:${index++}`] = remembered;
    if (current !== undefined) {
      for (const [key, secret] of Object.entries(current)) merged[`current:${key}`] = secret;
    }
    return merged;
  }

  /** Deep copy with every remembered (and every currently supplied) secret replaced. */
  redact<T>(value: T, current?: InteractionSecretValues): T {
    return redactInteractionSecretValues(value, this.merged(current));
  }
}
