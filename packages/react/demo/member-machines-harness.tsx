// A non-admin Member of a shared workspace connects their own computer: the
// real Machines dashboard with Connect, the real Connect a machine dialog with
// "This workspace" disabled, and the real pairing-code consent. A synthetic
// client mints commands, so nothing reaches an API.
//   ?view=page|connect|consent   ?theme=light|dark
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { EnrollmentConsent, MachinesDashboard, OpenGeniProvider } from "@opengeni/react";
import type { MachineView } from "@opengeni/sdk";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { ConnectMachineDialog } from "@opengeni/react/app/components/machines/connect-machine-dialog";
import { consentMachine, onlineMachine, sharedMachine } from "./machines-fixtures";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "page";
const dark = params.get("theme") === "dark";

const own: MachineView = {
  ...onlineMachine,
  sandboxId: "sh-own",
  enrollmentId: "enr-own",
  name: "Kari's MacBook Air",
  scope: "user",
};
const shared: MachineView = { ...sharedMachine, scope: "workspace" };

class PreviewClient extends MockOpenGeniClient {
  override async mintEnrollToken(_workspaceId: string, input: { scope?: string }) {
    return {
      token: "oget_preview.sig",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresInSeconds: 3600,
      scope: input.scope ?? "user",
      allowScreenControl: false,
    } as never;
  }
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
    if (view !== "connect") return;
    const id = setInterval(() => {
      const advanced = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.startsWith("Connect a server instead"),
      );
      if (!advanced) return;
      advanced.click();
      clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          subjectId: "user:kari",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              principalKind: "human_session",
              permissions: ["sessions:read", "sessions:control", "enrollments:read"],
            },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "shared" }],
        workspaceCapabilityCatalog: [],
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{
          api: { apiBaseUrl: "https://app.opengeni.ai" } as never,
          navigation: undefined as never,
        }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root min-h-screen bg-og-bg text-og-fg">
            <main className="mx-auto max-w-[960px] px-5 py-8" data-shot="">
              {view === "consent" ? (
                <EnrollmentConsent
                  userCode="WXYZ-4821"
                  machine={consentMachine}
                  phase="review"
                  allowWorkspaceScope={false}
                  onApprove={() => {}}
                  onDeny={() => {}}
                />
              ) : (
                <MachinesDashboard
                  machines={[own, shared]}
                  activeSandboxId={null}
                  onEnroll={() => {}}
                  onRefresh={() => {}}
                  onAttach={() => {}}
                />
              )}
              <ConnectMachineDialog
                open={view === "connect"}
                onOpenChange={() => {}}
                workspaceId={WORKSPACE_ID}
                origin="https://app.opengeni.ai"
                machines={[own, shared]}
                machinesLoading={false}
                canShareWithWorkspace={false}
              />
            </main>
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
