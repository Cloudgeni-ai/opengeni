import AsyncStorage from "@react-native-async-storage/async-storage";
import { OpenGeniClient, type ClientModel, type Workspace } from "@opengeni/sdk";
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
  useState,
} from "react";

/** One signed-in deployment identity. Multiple accounts are a list of these. */
export interface Account {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
}

interface AccountState {
  account: Account;
  client: OpenGeniClient;
  adapters: OpenGeniReactNativeAdapters;
  workspaces: Workspace[];
  /** The deployment's client model catalog (labels for the composer pill). */
  models: ClientModel[];
  workspaceId: string | null;
  setWorkspaceId(id: string): void;
  error: Error | null;
  reload(): Promise<void>;
}

const AccountContext = createContext<AccountState | null>(null);

const defaultAccount: Account = {
  id: "default",
  label: "Development",
  baseUrl: process.env.EXPO_PUBLIC_OPENGENI_URL ?? "http://127.0.0.1:8000",
  ...(process.env.EXPO_PUBLIC_OPENGENI_API_KEY
    ? { apiKey: process.env.EXPO_PUBLIC_OPENGENI_API_KEY }
    : {}),
};

export function AccountProvider({ children }: { children: ReactNode }) {
  const account = defaultAccount;
  const client = useMemo(
    () =>
      new OpenGeniClient({
        baseUrl: account.baseUrl,
        fetch: expoStreamingFetch,
        onDeprecation: false,
        ...(account.apiKey ? { apiKey: account.apiKey } : {}),
      }),
    [account],
  );
  const adapters = useMemo(
    () =>
      createExpoOpenGeniAdapters({
        persistence: createHydratedPersistenceAdapter(
          AsyncStorage,
          `opengeni:native:${account.id}`,
        ),
      }),
    [account.id],
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [models, setModels] = useState<ClientModel[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    try {
      const [next, config] = await Promise.all([
        client.listWorkspaces(),
        client.getClientConfig().catch(() => null),
      ]);
      setWorkspaces(next);
      if (config) setModels(config.models);
      setWorkspaceId((current) => current ?? next[0]?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<AccountState>(
    () => ({
      account,
      client,
      adapters,
      workspaces,
      models,
      workspaceId,
      setWorkspaceId,
      error,
      reload,
    }),
    [account, client, adapters, workspaces, models, workspaceId, error, reload],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}
