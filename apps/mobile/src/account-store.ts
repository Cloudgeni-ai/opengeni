import * as SecureStore from "expo-secure-store";

/**
 * One signed-in identity on one deployment. The app keeps several (other
 * deployments, other people) and works in one at a time. The credential is
 * the app's own revocable session from `/native-sign-in`, kept in the
 * platform keychain; the list itself holds no secret.
 */
export interface StoredAccount {
  id: string;
  /** The deployment's web origin, e.g. https://app.opengeni.ai. */
  baseUrl: string;
  subjectId: string;
  email: string;
  /** The workspace last used with this account. */
  workspaceId: string | null;
  /** Set when the deployment rejected the credential; sign in again. */
  signedOut?: boolean;
}

export interface AccountsSnapshot {
  accounts: StoredAccount[];
  activeId: string | null;
}

const INDEX_KEY = "opengeni.accounts.v1";
const ACTIVE_KEY = "opengeni.accounts.active.v1";
const tokenKey = (id: string) => `opengeni.accounts.token.${id}`;

export async function loadAccounts(): Promise<AccountsSnapshot> {
  const [index, activeId] = await Promise.all([
    SecureStore.getItemAsync(INDEX_KEY),
    SecureStore.getItemAsync(ACTIVE_KEY),
  ]);
  let accounts: StoredAccount[] = [];
  try {
    const parsed = index ? (JSON.parse(index) as unknown) : [];
    if (Array.isArray(parsed)) accounts = parsed as StoredAccount[];
  } catch {
    accounts = [];
  }
  const active = accounts.find((account) => account.id === activeId) ?? accounts[0] ?? null;
  return { accounts, activeId: active?.id ?? null };
}

export async function saveAccounts(snapshot: AccountsSnapshot): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(snapshot.accounts));
  if (snapshot.activeId) await SecureStore.setItemAsync(ACTIVE_KEY, snapshot.activeId);
  else await SecureStore.deleteItemAsync(ACTIVE_KEY);
}

export async function readAccountToken(id: string): Promise<string | null> {
  return await SecureStore.getItemAsync(tokenKey(id));
}

export async function writeAccountToken(id: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(id), token);
}

export async function forgetAccountToken(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id));
}

/** The same person on the same deployment is one account, signed in again. */
export function sameIdentity(
  account: Pick<StoredAccount, "baseUrl" | "subjectId">,
  other: Pick<StoredAccount, "baseUrl" | "subjectId">,
): boolean {
  return account.baseUrl === other.baseUrl && account.subjectId === other.subjectId;
}

/** A deployment address as typed: trimmed, https by default, no trailing slash. */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  const match = /^(https?):\/\/([a-z0-9.-]+(?::\d{1,5})?)(?:[/?#].*)?$/iu.exec(withScheme);
  return match ? `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}` : null;
}

/** The host a person recognizes, e.g. app.opengeni.ai. */
export function serverLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//iu, "");
}
