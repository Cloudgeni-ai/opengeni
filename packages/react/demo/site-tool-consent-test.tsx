// Preview harness: the production Site tool consent dialog with sample data.
// `?theme=dark|light`, `?accounts=1|2` and `?tool=send|create` pick the state.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SiteToolConsentPrompt } from "@opengeni/sdk/site";
import { SiteToolConsentDialog } from "../src/app/lib/site-tool-consent-dialog";
import { PortalContainerProvider } from "../src/ui/portal-container";
import "./styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const accountCount = params.get("accounts") === "1" ? 1 : 2;
const send = params.get("tool") !== "create";
// Themed like the app: the whole document (lib/appearance.tsx), not a subtree.
document.documentElement.dataset.ogTheme = dark ? "dark" : "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const work = { serverId: "account-sample-work", toolName: "send_message" };
const home = { serverId: "account-sample-home", toolName: "send_message" };
const prompt: SiteToolConsentPrompt = send
  ? {
      tool: {
        version: 1,
        entry: { identity: work, title: "Send message" },
        definitionDigest: "0".repeat(64),
      } as unknown as SiteToolConsentPrompt["tool"],
      arguments: {
        to: ["bendik@cloudgeni.ai"],
        subject: "Opengeni newsletter: October",
        body: "<p>Sample body, not shown in the confirmation.</p>",
      },
      accounts: [
        { identity: work, connector: "Gmail", account: "bendik@cloudgeni.ai" },
        { identity: home, connector: "Gmail", account: "bendik.sample@example.com" },
      ].slice(0, accountCount),
      selected: work,
      // As Gmail reads the message it would send.
      review: {
        kind: "gmail",
        email: {
          from: "bendik@cloudgeni.ai",
          to: "bendik@cloudgeni.ai",
          cc: "",
          bcc: "",
          subject: "Opengeni newsletter: October",
          attachments: 0,
        },
      },
      reviewFor: async (identity) => ({
        kind: "gmail",
        email: {
          from:
            identity.serverId === work.serverId
              ? "bendik@cloudgeni.ai"
              : "bendik.sample@example.com",
          to: "bendik@cloudgeni.ai",
          cc: "",
          bcc: "",
          subject: "Opengeni newsletter: October",
          attachments: 0,
        },
      }),
      signal: new AbortController().signal,
    }
  : {
      tool: {
        version: 1,
        entry: { identity: { serverId: "account-sample-linear", toolName: "create_issue" } },
        definitionDigest: "0".repeat(64),
      } as unknown as SiteToolConsentPrompt["tool"],
      arguments: { title: "Sample issue", teamId: "sample-team" },
      accounts: [
        {
          identity: { serverId: "account-sample-linear", toolName: "create_issue" },
          connector: "Linear",
          account: "Sample workspace",
        },
      ],
      selected: { serverId: "account-sample-linear", toolName: "create_issue" },
      review: null,
      reviewFor: async () => null,
      signal: new AbortController().signal,
    };

function Harness() {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  return (
    <div className="og-root min-h-screen bg-og-bg text-og-fg">
      {/* Sample Site content behind the Opengeni frame's confirmation. */}
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-og-xs text-og-fg-muted">Sample Site</p>
        <h1 className="mt-1 text-og-xl font-semibold">Opengeni newsletter</h1>
        <p className="mt-3 text-og-sm text-og-fg-muted">
          {decision ?? "The Site asked to send. Opengeni is asking you to confirm."}
        </p>
      </main>
      <div ref={setLayer} />
      {layer && decision === null ? (
        <PortalContainerProvider container={layer}>
          <SiteToolConsentDialog
            prompt={prompt}
            onDecision={(value) => setDecision(JSON.stringify(value))}
          />
        </PortalContainerProvider>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
