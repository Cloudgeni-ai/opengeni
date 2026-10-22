import { OpenGeniProvider } from "@opengeni/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Splash } from "./components/Splash";
import { client } from "./lib/app-api";
import "./styles.css";

const WORKSPACE_KEY = "simple:workspace";

function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function Root() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const stored = readStored(WORKSPACE_KEY);
        const chosen = workspaces.find((workspace) => workspace.id === stored) ?? workspaces[0];
        if (!chosen) setError("No workspace is available for this account.");
        else setWorkspaceId(chosen.id);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[var(--app-muted)]">
        <div>
          <p className="text-lg font-medium text-[var(--app-fg)]">Opengeni is not reachable</p>
          <p className="mt-1 text-sm">{error}</p>
          <button
            type="button"
            className="mt-4 rounded-full bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!workspaceId) return <Splash />;
  return (
    <OpenGeniProvider
      key={workspaceId}
      client={client}
      workspaceId={workspaceId}
      toolDetails="plain"
      productName="Opengeni"
    >
      <App
        workspaceId={workspaceId}
        onSwitchWorkspace={(id) => {
          try {
            localStorage.setItem(WORKSPACE_KEY, id);
          } catch {
            // The choice simply is not remembered.
          }
          setWorkspaceId(id);
        }}
      />
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
