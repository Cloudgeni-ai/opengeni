/**
 * The display label frozen with a person's work when the request that started
 * it carried none.
 *
 * A chat started in the app freezes the signed-in person's label from their
 * session. Work started for them elsewhere (a Slack or Teams message, a
 * Personal workspace grant, an API call on their behalf) can reach session
 * creation with only their subject id, and the sidebar would then have
 * nothing to show but an id fragment. This resolves the same label the app
 * freezes: their contact email, else their profile name.
 *
 * Display only, never an authorization input. Best effort: any failure
 * leaves the creator unlabeled rather than failing the work.
 */
import type { TurnInitiator } from "@opengeni/contracts";
import { accountContactEmail } from "@opengeni/contracts/passkey-only-account";
import { getManagedUserProfilesByIds, type Database } from "@opengeni/db";

const MANAGED_PERSON_PREFIX = "user:";

/** The managed person's label as the app freezes it, or null when unknown. */
export async function managedPersonLabel(db: Database, subjectId: string): Promise<string | null> {
  if (!subjectId.startsWith(MANAGED_PERSON_PREFIX)) return null;
  const userId = subjectId.slice(MANAGED_PERSON_PREFIX.length);
  if (!userId) return null;
  try {
    const [profile] = await getManagedUserProfilesByIds(db, [userId]);
    if (!profile || profile.id !== userId) return null;
    const label = accountContactEmail(profile.email?.trim()) || profile.name?.trim();
    return label ? label : null;
  } catch {
    return null;
  }
}

/**
 * The initiator with the person's label filled in when it is a managed person
 * without one. Every other initiator is returned unchanged.
 */
export async function withPersonCreatorLabel<T extends TurnInitiator | undefined>(
  db: Database,
  initiator: T,
): Promise<T> {
  if (!initiator || initiator.kind !== "subject" || initiator.label?.trim()) return initiator;
  const label = await managedPersonLabel(db, initiator.subjectId);
  return label ? ({ ...initiator, label } as T) : initiator;
}
