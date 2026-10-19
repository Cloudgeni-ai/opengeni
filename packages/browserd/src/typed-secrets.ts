import {
  INTERACTION_MIN_REDACTED_SECRET_CHARS,
  type InteractionSecretValues,
  redactInteractionSecretValues,
} from "@opengeni/contracts";

/** Most distinct secret values one controller remembers; the oldest drop first. */
const MAX_REMEMBERED_SECRETS = 256;
/** Most sessions whose typed values this process keeps; the least recently used drop first. */
const MAX_REMEMBERING_SESSIONS = 1_024;

const sessions = new Map<string, TypedSecretMemory>();

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
  private readonly values = new Set<string>();

  /** The memory shared by every driver of one session in this process. */
  static forSession(kind: "browser" | "computer", sessionId: string): TypedSecretMemory {
    const key = `${kind}:${sessionId}`;
    const existing = sessions.get(key);
    if (existing !== undefined) {
      sessions.delete(key);
      sessions.set(key, existing);
      return existing;
    }
    const memory = new TypedSecretMemory();
    sessions.set(key, memory);
    if (sessions.size > MAX_REMEMBERING_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    return memory;
  }

  remember(secretValues: InteractionSecretValues | undefined): void {
    if (secretValues === undefined) return;
    // One-time codes are remembered too: a code stays valid, and visible in
    // its field, after the action that typed it.
    for (const value of Object.values(secretValues)) {
      if (value.length < INTERACTION_MIN_REDACTED_SECRET_CHARS) continue;
      this.values.delete(value);
      this.values.add(value);
      if (this.values.size > MAX_REMEMBERED_SECRETS) {
        const oldest = this.values.values().next().value;
        if (oldest !== undefined) this.values.delete(oldest);
      }
    }
  }

  /** The remembered values plus any currently supplied ones, in the shape
   * redactInteractionSecretValues takes; undefined when there are none. */
  merged(current?: InteractionSecretValues): InteractionSecretValues | undefined {
    if (this.values.size === 0) return current;
    const merged: Record<string, string> = {};
    let index = 0;
    for (const remembered of this.values) merged[`remembered:${index++}`] = remembered;
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
