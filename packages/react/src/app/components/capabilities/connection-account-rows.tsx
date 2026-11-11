import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import type { ConnectionMetadata } from "@opengeni/sdk";

/** The workspaces a person can see, for naming where an account was added. */
export type AccountOriginWorkspace = { id: string; name: string; kind: "personal" | "shared" };

export type ConnectionAccountRow = {
  /** Who the account is: its identity, or "<name> account" when the provider gave none. */
  label: string;
  /** "Shared", "Yours", "Yours · From Personal workspace", or "Shared · From
   * <workspace>" for a shared account added in another workspace. */
  scope: string;
  /** The workspace it was added in, when that is not the one being viewed.
   * Removing or reconnecting it acts there. */
  origin: string | null;
};

/** Why another account of a service can't be added yet. */
export type AddAccountLimit = "single" | "reconnect";

export const ADD_ACCOUNT_LIMIT_COPY: Readonly<Record<AddAccountLimit, string>> = {
  single:
    "This service doesn't tell us which account you signed in with, so you can connect one account. Disconnect it to use a different one.",
  reconnect: "Reconnect your existing account once, then add another.",
};

/**
 * Mirrors the server's account rule for adding one more account in the given
 * ownership. A service that can't identify accounts allows each person one
 * connection: none beside one in the same place, no personal one beside a
 * shared one, and no shared one beside the person's own. A service that can
 * identify accounts first needs any older account in the same place signed in
 * again. Only the viewer's own and shared accounts count. The API decides.
 */
export function addAccountLimit(
  accounts: readonly Pick<ConnectionMetadata, "subjectId" | "status" | "accountIdentity">[],
  input: { viewerSubjectId: string | null; ownership: "personal" | "workspace" },
): AddAccountLimit | null {
  const live = accounts.filter(
    (account) =>
      account.status !== "revoked" &&
      (account.subjectId === null || account.subjectId === input.viewerSubjectId),
  );
  if (live.some((account) => account.accountIdentity === "single")) return "single";
  const sameBucket = live.filter((account) =>
    input.ownership === "workspace" ? account.subjectId === null : account.subjectId !== null,
  );
  return sameBucket.some((account) => account.accountIdentity === "reconnect") ? "reconnect" : null;
}

function originName(workspaceId: string, workspaces: readonly AccountOriginWorkspace[]): string {
  const origin = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!origin) return "another workspace";
  return origin.kind === "personal" ? "Personal workspace" : origin.name;
}

function connectedOn(createdAt: string, withTime: boolean): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return `Connected ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}${
    withTime ? ` ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""
  }`;
}

/**
 * Rows a person can tell apart: each account's identity, who can use it and,
 * for one of their own accounts added in another workspace, where it came
 * from. Accounts that would still read the same also get when they were
 * connected. Display only; never used to select credentials.
 */
export function connectionAccountRows(
  accounts: readonly ConnectionMetadata[],
  input: {
    /** "<fallbackName> account" when the provider gave no identity. */
    fallbackName: string;
    /** The workspace being viewed; omit when unknown (no origin is shown). */
    workspaceId?: string | null | undefined;
    workspaces?: readonly AccountOriginWorkspace[] | undefined;
    /** The base label, when the caller words unfinished sign-ins differently. */
    labelOf?: ((account: ConnectionMetadata) => string) | undefined;
  },
): Map<string, ConnectionAccountRow> {
  const fallback = `${input.fallbackName} account`;
  const base = accounts.map((account) => {
    const origin =
      input.workspaceId && account.workspaceId !== input.workspaceId
        ? originName(account.workspaceId, input.workspaces ?? [])
        : null;
    const scope =
      account.subjectId === null
        ? origin
          ? `Shared · From ${origin}`
          : "Shared"
        : origin
          ? `Yours · From ${origin}`
          : "Yours";
    return {
      account,
      label: input.labelOf?.(account) ?? connectionAccountIdentityLabel(account.metadata, fallback),
      scope,
      origin,
    };
  });
  const key = (row: { label: string; scope: string }) => `${row.label}\u0000${row.scope}`;
  const count = (rows: Array<{ label: string; scope: string }>) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return counts;
  };
  const sameAsAnother = count(base);
  const dated = base.map((row) => {
    if ((sameAsAnother.get(key(row)) ?? 0) < 2) return row;
    const day = connectedOn(row.account.createdAt, false);
    return day ? { ...row, label: `${row.label} · ${day}` } : row;
  });
  const sameDay = count(dated);
  const rows = new Map<string, ConnectionAccountRow>();
  dated.forEach((row, index) => {
    const time =
      (sameDay.get(key(row)) ?? 0) > 1 && row.label !== base[index]!.label
        ? connectedOn(row.account.createdAt, true)
        : null;
    rows.set(row.account.id, {
      label: time ? `${base[index]!.label} · ${time}` : row.label,
      scope: row.scope,
      origin: row.origin,
    });
  });
  return rows;
}
