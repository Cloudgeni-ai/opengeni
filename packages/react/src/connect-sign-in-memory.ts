// Sign-ins a person was sent to and never came back from. An organization
// that requires an administrator to approve the app stops the person on the
// provider's own page, and often never sends them back. Remembering the
// attempt lets the next visit to that connection offer the approval help.
// No DOM; storage is injectable for other renderers.
import {
  organizationAppApproval,
  type ConnectAttempt,
  type OrganizationAppApproval,
} from "@opengeni/contracts/connect";
import type { ConnectTransport } from "@opengeni/connect";
import type { ConnectAttemptHints } from "./connect-window-host";

/** How long an unanswered sign-in still explains a later visit. */
const REMEMBER_MS = 30 * 24 * 60 * 60_000;

type Remembered = {
  attemptId: string;
  startedAt: number;
  approval: OrganizationAppApproval;
};

/**
 * The browser's local storage: unlike the per-tab recovery hint, the memory
 * has to outlive the tab and the chat the person started from. It holds an
 * attempt ID and the public approval details only, never a credential; the
 * server rechecks the signed-in owner before the attempt is read back.
 */
export const browserSignInMemory: ConnectAttemptHints = {
  read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  remember(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Help only. */
    }
  },
  forget(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Help only. */
    }
  },
};

const memoryKey = (workspaceId: string, providerId: string) =>
  `opengeni:connect-sign-in:${workspaceId}:${providerId}`;

function parse(raw: string | null): Remembered | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Remembered>;
    const approval = value.approval;
    if (
      typeof value.attemptId !== "string" ||
      typeof value.startedAt !== "number" ||
      !approval ||
      typeof approval.appId !== "string" ||
      (approval.approvalUrl !== null && typeof approval.approvalUrl !== "string")
    )
      return null;
    // Only ever a provider's own HTTPS page.
    if (approval.approvalUrl) {
      const url = new URL(approval.approvalUrl);
      if (url.protocol !== "https:" || url.username || url.password) return null;
    }
    return { attemptId: value.attemptId, startedAt: value.startedAt, approval };
  } catch {
    return null;
  }
}

/**
 * The person is being sent to sign in for this attempt. Remembered only for
 * providers where an organization can require approval of the app.
 */
export function rememberSignIn(memory: ConnectAttemptHints | null, attempt: ConnectAttempt): void {
  if (!memory || attempt.nextAction.type !== "authorize") return;
  const approval = organizationAppApproval(
    attempt.nextAction.url,
    attempt.nextAction.organizationApprovalUrl,
  );
  if (!approval) return;
  memory.remember(
    memoryKey(attempt.workspaceId, attempt.providerId),
    JSON.stringify({ attemptId: attempt.id, startedAt: Date.now(), approval }),
  );
}

/** The provider answered (or setup finished): this sign-in no longer needs explaining. */
export function forgetSignIn(memory: ConnectAttemptHints | null, attempt: ConnectAttempt): void {
  if (!memory) return;
  const key = memoryKey(attempt.workspaceId, attempt.providerId);
  if (parse(memory.read(key))?.attemptId === attempt.id) memory.forget(key);
}

/** The account is connected, however it got there: no earlier sign-in needs explaining. */
export function forgetSignInsTo(
  memory: ConnectAttemptHints | null,
  workspaceId: string,
  providerId: string,
): void {
  memory?.forget(memoryKey(workspaceId, providerId));
}

/**
 * A provider never answers a sign-in that it ended on its own page: the attempt
 * still waits for the person, ran out of time, or was stopped from this side.
 * A callback always leaves its outcome (or progress) on the attempt.
 */
export function signInNeverReturned(attempt: ConnectAttempt): boolean {
  if (attempt.error) return false;
  return (
    attempt.state === "expired" ||
    attempt.state === "cancelled" ||
    (attempt.state === "requires_user_action" && attempt.nextAction.type === "authorize")
  );
}

/**
 * The approval help for the last sign-in to this connection the person never
 * came back from, checked against the attempt's durable state; null otherwise.
 */
export async function unreturnedSignIn(
  memory: ConnectAttemptHints | null,
  transport: Pick<ConnectTransport, "get">,
  workspaceId: string,
  providerId: string,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationAppApproval | null> {
  if (!memory) return null;
  const key = memoryKey(workspaceId, providerId);
  const remembered = parse(memory.read(key));
  if (!remembered || Date.now() - remembered.startedAt > REMEMBER_MS) {
    memory.forget(key);
    return null;
  }
  let attempt: ConnectAttempt;
  try {
    attempt = await transport.get(workspaceId, remembered.attemptId, options);
  } catch (failure) {
    // Gone, or someone else's: nothing to explain. Anything else may pass.
    const status = (failure as { status?: unknown } | null)?.status;
    if (status === 404 || status === 403) memory.forget(key);
    return null;
  }
  if (
    attempt.id !== remembered.attemptId ||
    attempt.providerId !== providerId ||
    !signInNeverReturned(attempt)
  ) {
    memory.forget(key);
    return null;
  }
  return remembered.approval;
}
