import type { AccountsSnapshot, StoredAccount } from "@/account-store";
import { serverLabel } from "@/server-url";

/**
 * Picking an account the person is not signed in to never makes it the active
 * account: its sign-in opens over the account in use, so cancelling (or
 * leaving the app) keeps them where they were. Every account keeps its own
 * credential either way.
 */
export type AccountPick =
  | { kind: "stay" }
  | { kind: "switch"; next: AccountsSnapshot }
  | { kind: "signIn"; account: StoredAccount };

/** Whether an account must sign in again before it can be used. */
export function needsSignIn(
  account: Pick<StoredAccount, "signedOut">,
  hasCredential: boolean,
): boolean {
  return Boolean(account.signedOut) || !hasCredential;
}

/**
 * An account's line in the account menus: its email, its server when the
 * device uses several, and whether it must sign in again (native menus have
 * no subtitle).
 */
export function accountMenuTitle(
  account: Pick<StoredAccount, "email" | "baseUrl" | "signedOut">,
  servers: number,
): string {
  const name = servers > 1 ? `${account.email} · ${serverLabel(account.baseUrl)}` : account.email;
  return account.signedOut ? `${name} · Signed out` : name;
}

export function planAccountPick(
  snapshot: AccountsSnapshot,
  id: string,
  hasCredential: boolean,
): AccountPick {
  const account = snapshot.accounts.find((each) => each.id === id);
  if (!account || snapshot.activeId === id) return { kind: "stay" };
  if (needsSignIn(account, hasCredential)) return { kind: "signIn", account };
  return { kind: "switch", next: { ...snapshot, activeId: id } };
}

/**
 * The account to offer first as the way back when leaving the active one: it,
 * if it is signed in. Leaving a signed-out account keeps the earlier way back.
 */
export function wayBackWhenLeaving(
  snapshot: AccountsSnapshot,
  nextId: string,
  current: string | null,
): string | null {
  const leaving = snapshot.accounts.find((each) => each.id === snapshot.activeId);
  if (!leaving || leaving.id === nextId || leaving.signedOut) return current;
  return leaving.id;
}

export interface SignInSwitchChoice {
  account: StoredAccount;
  signedIn: boolean;
}

/**
 * The other accounts the full-screen sign-in offers, so a sign-in is never the
 * only way forward: the account the person came from first, then the rest in
 * their saved order.
 */
export function signInSwitchChoices(
  accounts: readonly StoredAccount[],
  activeId: string | null,
  previousId: string | null,
): SignInSwitchChoice[] {
  const others = accounts.filter((each) => each.id !== activeId);
  const previous = others.find((each) => each.id === previousId);
  const ordered = previous ? [previous, ...others.filter((each) => each !== previous)] : others;
  return ordered.map((account) => ({ account, signedIn: !account.signedOut }));
}
