import {
  INTERACTION_MIN_REDACTED_SECRET_CHARS,
  type InteractionSecretValues,
  redactInteractionSecretValues,
} from "@opengeni/contracts";

/** Most distinct secret values one controller remembers; the oldest drop first. */
const MAX_REMEMBERED_SECRETS = 256;

/**
 * Secret values this controller has typed into its pages or desktop.
 *
 * A value typed from a secret reference stays in the field (and can be echoed
 * elsewhere on the page) after the action that typed it. Every later
 * observation, read, dialog and error from the same controller is redacted
 * against all of them, not only the action that carried the value, so form
 * field values can be shown without ever showing a typed secret.
 */
export class TypedSecretMemory {
  private readonly values = new Set<string>();

  remember(secretValues: InteractionSecretValues | undefined): void {
    if (secretValues === undefined) return;
    for (const [key, value] of Object.entries(secretValues)) {
      if (value.length < INTERACTION_MIN_REDACTED_SECRET_CHARS) continue;
      // A one-time code expires within a minute; remembering it would only
      // blank unrelated numbers that later happen to match it.
      if (key.split("|")[2] === "otp") continue;
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
