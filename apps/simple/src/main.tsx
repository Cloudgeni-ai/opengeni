import { OpenGeniProvider } from "@opengeni/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Splash } from "./components/Splash";
import { StartProblem } from "./components/StartProblem";
import { client } from "./lib/app-api";
import { NoWorkspaceError } from "./lib/start-error";
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
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    let cancelled = false;
    client
      .listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const stored = readStored(WORKSPACE_KEY);
        const chosen = workspaces.find((workspace) => workspace.id === stored) ?? workspaces[0];
        if (!chosen) setError(new NoWorkspaceError());
        else setWorkspaceId(chosen.id);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause ?? new Error("Unknown"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== undefined) {
    return <StartProblem error={error} onRetry={() => window.location.reload()} />;
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
