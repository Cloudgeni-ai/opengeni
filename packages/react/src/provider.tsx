import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SessionClientLike } from "./client";

export type OpenGeniContextValue = {
  client: SessionClientLike;
  workspaceId: string;
};

const OpenGeniContext = createContext<OpenGeniContextValue | null>(null);

export type OpenGeniProviderProps = {
  client: SessionClientLike;
  workspaceId: string;
  children?: ReactNode;
};

/**
 * Supplies the OpenGeni client + workspace to all hooks below it. Hooks also
 * accept `{ client, workspaceId }` overrides per call for multi-workspace UIs.
 */
export function OpenGeniProvider({ client, workspaceId, children }: OpenGeniProviderProps) {
  const value = useMemo(() => ({ client, workspaceId }), [client, workspaceId]);
  return <OpenGeniContext.Provider value={value}>{children}</OpenGeniContext.Provider>;
}

export type ClientOverride = {
  client?: SessionClientLike | undefined;
  workspaceId?: string | undefined;
};

/** Resolve client + workspace from explicit overrides or the provider. */
export function useOpenGeni(override: ClientOverride = {}): OpenGeniContextValue {
  const context = useContext(OpenGeniContext);
  const client = override.client ?? context?.client;
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  if (!client || !workspaceId) {
    throw new Error(
      "@opengeni/react: no OpenGeni client/workspace available. Wrap the tree in <OpenGeniProvider> or pass { client, workspaceId } to the hook.",
    );
  }
  return { client, workspaceId };
}
