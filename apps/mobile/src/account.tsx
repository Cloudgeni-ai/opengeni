import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  organizationLandingWorkspaceId,
  organizationsForSubject,
  type OrgOption,
} from "@opengeni/react/organization-model";
import {
  OpenGeniApiError,
  OpenGeniClient,
  type AccessContext,
  type ClientConfig,
  type ClientModel,
  type Workspace,
} from "@opengeni/sdk";
import {
  createHydratedPersistenceAdapter,
  type OpenGeniReactNativeAdapters,
} from "@opengeni/react-native";
import { createExpoOpenGeniAdapters, expoStreamingFetch } from "@opengeni/react-native/expo";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  forgetAccountToken,
  loadAccounts,
  readAccountToken,
  sameIdentity,
  saveAccounts,
  type AccountsSnapshot,
  type StoredAccount,
  writeAccountToken,
} from "@/account-store";
import { signInThroughWeb, type WebSignInResult } from "@/web-sign-in";

/** The deployment a new account signs in to unless the person names another. */
export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_OPENGENI_URL ?? "https://app.opengeni.ai";

export type AccountStatus = "loading" | "signedOut" | "ready";

interface AccountState {
  status: AccountStatus;
  accounts: StoredAccount[];
  /** The account in use; null while signed out. */
  account: StoredAccount | null;
  client: OpenGeniClient;
  adapters: OpenGeniReactNativeAdapters;
  accessContext: AccessContext | null;
  workspaces: Workspace[];
  /** Organizations of the account, default first (shared web rules). */
  organizations: OrgOption[];
  workspace: Workspace | null;
  /** The deployment's client configuration (defaults, model catalog). */
  config: ClientConfig | null;
  /** The deployment's client model catalog (labels for the composer pill). */
  models: ClientModel[];
  workspaceId: string | null;
  setWorkspaceId(id: string): void;
  /** Switch organization: its remembered workspace, else its first shared one. */
  selectOrganization(accountId: string): void;
  error: Error | null;
  reload(): Promise<void>;
  /** Sign in through the deployment's web sign-in and make it the active account. */
  addAccount(baseUrl: string): Promise<WebSignInResult>;
  switchAccount(id: string): void;
  signOut(id: string): Promise<void>;
}

const AccountContext = createContext<AccountState | null>(null);

function newClient(baseUrl: string, token?: string | null): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl,
    fetch: expoStreamingFetch,
    onDeprecation: false,
    ...(token ? { apiKey: token } : {}),
  });
}

function unauthorized(caught: unknown): boolean {
  return caught instanceof OpenGeniApiError && caught.status === 401;
}

const ORG_WORKSPACE_KEY = "opengeni:native:org-workspaces:";

export function AccountProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [token, setToken] = useState<{ id: string; value: string | null } | null>(null);
  const snapshotRef = useRef<AccountsSnapshot | null>(null);
  snapshotRef.current = snapshot;

  useEffect(() => {
    void loadAccounts().then(setSnapshot);
  }, []);

  const account = snapshot?.accounts.find((each) => each.id === snapshot.activeId) ?? null;
  const accountId = account?.id ?? null;
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void readAccountToken(accountId).then((value) => {
      if (live) setToken({ id: accountId, value });
    });
    return () => {
      live = false;
    };
  }, [accountId]);

  const activeToken = token && token.id === accountId ? token.value : null;
  const baseUrl = account?.baseUrl ?? DEFAULT_SERVER_URL;
  const client = useMemo(() => newClient(baseUrl, activeToken), [baseUrl, activeToken]);
  const adapters = useMemo(
    () =>
      createExpoOpenGeniAdapters({
        persistence: createHydratedPersistenceAdapter(
          AsyncStorage,
          `opengeni:native:${accountId ?? "signed-out"}`,
        ),
      }),
    [accountId],
  );

  const persist = useCallback(async (next: AccountsSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    await saveAccounts(next);
  }, []);

  const updateAccount = useCallback(
    (id: string, patch: Partial<StoredAccount>) => {
      const current = snapshotRef.current;
      if (!current) return;
      void persist({
        ...current,
        accounts: current.accounts.map((each) => (each.id === id ? { ...each, ...patch } : each)),
      });
    },
    [persist],
  );

  const [accessContext, setAccessContext] = useState<AccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const models = useMemo(() => config?.models ?? [], [config]);

  const reload = useCallback(async () => {
    if (!accountId || !activeToken) return;
    try {
      const [nextContext, next, nextConfig] = await Promise.all([
        client.getAccessContext(),
        client.listWorkspaces(),
        client.getClientConfig().catch(() => null),
      ]);
      setAccessContext(nextContext);
      setWorkspaces(next);
      if (nextConfig) setConfig(nextConfig);
      setError(null);
      const current = snapshotRef.current?.accounts.find((each) => each.id === accountId);
      const kept = next.find((workspace) => workspace.id === current?.workspaceId);
      const landing =
        kept?.id ??
        (nextContext.defaultAccountId
          ? organizationLandingWorkspaceId(next, nextContext.defaultAccountId)
          : null) ??
        next[0]?.id ??
        null;
      if (current && (landing !== current.workspaceId || current.signedOut)) {
        updateAccount(accountId, { workspaceId: landing, signedOut: false });
      }
    } catch (caught) {
      if (unauthorized(caught)) updateAccount(accountId, { signedOut: true });
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [accountId, activeToken, client, updateAccount]);

  useEffect(() => {
    setAccessContext(null);
    setWorkspaces([]);
    setConfig(null);
    setError(null);
    void reload();
  }, [reload]);

  const workspaceId = account?.workspaceId ?? null;
  const setWorkspaceId = useCallback(
    (id: string) => {
      if (!accountId) return;
      updateAccount(accountId, { workspaceId: id });
      const owner = workspaces.find((workspace) => workspace.id === id)?.accountId;
      if (owner) void AsyncStorage.setItem(`${ORG_WORKSPACE_KEY}${accountId}:${owner}`, id);
    },
    [accountId, updateAccount, workspaces],
  );
  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (!accountId) return;
      void AsyncStorage.getItem(`${ORG_WORKSPACE_KEY}${accountId}:${organizationId}`).then(
        (remembered) => {
          const landing = organizationLandingWorkspaceId(workspaces, organizationId, remembered);
          if (landing) updateAccount(accountId, { workspaceId: landing });
        },
      );
    },
    [accountId, updateAccount, workspaces],
  );

  const addAccount = useCallback(
    async (serverUrl: string): Promise<WebSignInResult> => {
      const result = await signInThroughWeb(serverUrl);
      if (result.kind !== "signedIn") return result;
      let context: AccessContext;
      try {
        context = await newClient(serverUrl, result.accessToken).getAccessContext();
      } catch (caught) {
        return {
          kind: "failed",
          message: caught instanceof Error ? caught.message : "Couldn't load the account.",
        };
      }
      const current = snapshotRef.current ?? { accounts: [], activeId: null };
      const identity = { baseUrl: serverUrl, subjectId: context.subjectId };
      const existing = current.accounts.find((each) => sameIdentity(each, identity));
      const id = existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      await writeAccountToken(id, result.accessToken);
      const stored: StoredAccount = {
        id,
        baseUrl: serverUrl,
        subjectId: context.subjectId,
        email: context.subjectLabel ?? context.subjectId,
        workspaceId: existing?.workspaceId ?? null,
      };
      setToken({ id, value: result.accessToken });
      await persist({
        accounts: existing
          ? current.accounts.map((each) => (each.id === id ? stored : each))
          : [...current.accounts, stored],
        activeId: id,
      });
      return result;
    },
    [persist],
  );

  const switchAccount = useCallback(
    (id: string) => {
      const current = snapshotRef.current;
      if (!current || current.activeId === id) return;
      void persist({ ...current, activeId: id });
    },
    [persist],
  );

  const signOut = useCallback(
    async (id: string) => {
      const current = snapshotRef.current;
      const target = current?.accounts.find((each) => each.id === id);
      if (!current || !target) return;
      const stored = await readAccountToken(id);
      if (stored) {
        // Revoke on the server first; the device forgets the account either way.
        await newClient(target.baseUrl, stored)
          .signOutNativeApp()
          .catch((error: unknown) => {
            if (__DEV__) console.warn("Native sign-out was not confirmed by the server", error);
          });
      } else if (__DEV__) {
        console.warn("Native sign-out: no stored credential for the account");
      }
      await forgetAccountToken(id);
      const accounts = current.accounts.filter((each) => each.id !== id);
      await persist({
        accounts,
        activeId: current.activeId === id ? (accounts[0]?.id ?? null) : current.activeId,
      });
    },
    [persist],
  );

  const organizations = useMemo(
    () => (accessContext ? organizationsForSubject(accessContext, workspaces) : []),
    [accessContext, workspaces],
  );
  const workspace = workspaces.find((each) => each.id === workspaceId) ?? null;
  const tokenLoaded = token?.id === accountId;
  const status: AccountStatus = !snapshot
    ? "loading"
    : !account || account.signedOut
      ? "signedOut"
      : !tokenLoaded
        ? "loading"
        : activeToken
          ? "ready"
          : "signedOut";

  const value = useMemo<AccountState>(
    () => ({
      status,
      accounts: snapshot?.accounts ?? [],
      account,
      client,
      adapters,
      accessContext,
      workspaces,
      organizations,
      workspace,
      config,
      models,
      workspaceId,
      setWorkspaceId,
      selectOrganization,
      error,
      reload,
      addAccount,
      switchAccount,
      signOut,
    }),
    [
      status,
      snapshot,
      account,
      client,
      adapters,
      accessContext,
      workspaces,
      organizations,
      workspace,
      config,
      models,
      workspaceId,
      setWorkspaceId,
      selectOrganization,
      error,
      reload,
      addAccount,
      switchAccount,
      signOut,
    ],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}
