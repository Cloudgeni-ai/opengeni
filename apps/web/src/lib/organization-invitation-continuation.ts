const STORAGE_KEY = "opengeni:organization-invitation-continuation:v1";
const MAX_AGE_MS = 60 * 60_000;

export type OrganizationInvitationContinuation = {
  organizationId: string;
  organizationName: string;
  targetEmail: string;
  expiresAt: string;
  createdAt: number;
};

function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

export function storeOrganizationInvitationContinuation(
  input: Omit<OrganizationInvitationContinuation, "createdAt">,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        targetEmail: input.targetEmail,
        expiresAt: input.expiresAt,
        createdAt: now,
      }),
    );
  } catch {
    // A blocked or full session store must not prevent ordinary sign-in.
  }
}

export function readOrganizationInvitationContinuation(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = browserStorage(),
  now = Date.now(),
): OrganizationInvitationContinuation | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const discard = () => {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Invalid browser storage is already unusable for this handoff.
    }
  };
  try {
    const value = JSON.parse(raw) as Partial<OrganizationInvitationContinuation>;
    if (
      typeof value.organizationId !== "string" ||
      !value.organizationId.trim() ||
      typeof value.organizationName !== "string" ||
      !value.organizationName.trim() ||
      typeof value.targetEmail !== "string" ||
      !value.targetEmail.trim() ||
      typeof value.expiresAt !== "string" ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      discard();
      return null;
    }
    const invitationExpiry = Date.parse(value.expiresAt);
    if (
      !Number.isFinite(invitationExpiry) ||
      invitationExpiry <= now ||
      value.createdAt > now + 60_000 ||
      now - value.createdAt > MAX_AGE_MS
    ) {
      discard();
      return null;
    }
    return value as OrganizationInvitationContinuation;
  } catch {
    discard();
    return null;
  }
}

export function clearOrganizationInvitationContinuation(
  storage: Pick<Storage, "removeItem"> | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked session store must not prevent ordinary invitation handling.
  }
}
