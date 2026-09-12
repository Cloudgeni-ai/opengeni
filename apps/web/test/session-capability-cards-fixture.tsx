import { CapabilityCatalogItem } from "@opengeni/contracts";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  DetailBody,
  type ConnectAction,
} from "../src/components/capabilities/capability-detail-sheet";
import { SessionCapabilityFrame } from "../src/components/capabilities/session-capability-frame";
import { Button } from "../src/components/ui/button";
import "../src/styles.css";

const scenarios = [
  {
    id: "oauth",
    name: "PostHog",
    kind: "mcp",
    authKind: "oauth2",
    domain: "mcp.posthog.com",
    action: "Connect PostHog",
  },
  {
    id: "api-key",
    name: "Example API",
    kind: "mcp",
    authKind: "api_key",
    domain: "api.example.test",
    action: "Add API key",
  },
  {
    id: "skill",
    name: "Writing style",
    kind: "skill",
    authKind: "none",
    domain: "Reviewed library skill · v1.0",
    action: "Review skill",
  },
] as const;

function Scenario({ scenario }: { scenario: (typeof scenarios)[number] }) {
  const skill = scenario.kind === "skill";
  const [expanded, setExpanded] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Retain only content-free receipts, never submitted credentials.
  const [receipt, setReceipt] = useState({ action: "ready", attempts: 0, ownership: "none" });
  const opener = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const item = CapabilityCatalogItem.parse({
    id: `${scenario.kind}:fixture-${scenario.id}`,
    kind: scenario.kind,
    source: skill ? "library" : "manual",
    name: scenario.name,
    description: skill
      ? "Plain-language release notes with consistent structure and tone."
      : "Bring your team's information into this conversation.",
    providerDomain: scenario.domain,
    mcpUrl: skill ? null : `https://${scenario.domain}/mcp`,
    authKind: scenario.authKind,
    enabled: false,
    runtime: { available: true, notes: null },
    metadata: skill
      ? { libraryId: "writing-style", version: "1.0", contentSha256: "a".repeat(64) }
      : {},
  });

  function close() {
    setExpanded(false);
    setError(null);
    requestAnimationFrame(() => (opener.current ?? cardRef.current)?.focus());
  }

  function onAction(action: ConnectAction) {
    if (busy) return;
    setError(null);
    setBusy(true);
    setReceipt((current) => ({
      action: action.type,
      attempts: current.attempts + 1,
      ownership: "ownership" in action ? action.ownership : "workspace",
    }));
    // Only explicitly labelled fixture controls settle this mock operation.
    // No timers, fetch, storage, redirects or implicit successful connections.
  }

  return (
    <div data-testid={`${scenario.id}-fixture`} className="min-w-0">
      <SessionCapabilityFrame
        name={item.name}
        subtitle={scenario.domain}
        logo={null}
        typeLabel={skill ? "Skill" : "MCP server"}
        description={item.description ?? ""}
        skill={skill}
        expanded={expanded}
        complete={complete}
        actionLabel={scenario.action}
        note={
          skill
            ? "Skill content is reviewed separately from permission to use any integration."
            : scenario.id === "api-key"
              ? "Add credentials in the protected form, not in a chat message."
              : "Review access before signing in. You'll return to this conversation after authorization."
        }
        onOpen={() => setExpanded(true)}
        opener={opener}
        cardRef={cardRef}
      >
        <DetailBody
          item={item}
          inline
          showIdentity={false}
          onCancel={close}
          health={{ state: "none" }}
          logoSrc={null}
          busy={busy}
          errorMessage={error}
          canManageSocial
          canManageSkills
          onAction={onAction}
        />
      </SessionCapabilityFrame>
      <fieldset
        className="mt-3 flex flex-wrap gap-2"
        aria-label={`${scenario.name} fixture controls`}
      >
        <legend className="mb-2 text-xs text-fg-muted">
          Explicit fixture outcomes (not product UI)
        </legend>
        <Button
          size="sm"
          variant="outline"
          disabled={!busy}
          onClick={() => {
            setBusy(false);
            setError("Fixture provider rejected this attempt. Review your input and retry.");
          }}
        >
          Fixture fail
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!busy}
          onClick={() => {
            setBusy(false);
            setComplete(true);
            close();
          }}
        >
          Fixture succeed
        </Button>
      </fieldset>
      <output data-testid={`${scenario.id}-receipt`} className="sr-only">
        {JSON.stringify({ ...receipt, busy, complete })}
      </output>
    </div>
  );
}

const theme =
  new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.setAttribute("data-og-theme", theme);
document.documentElement.style.colorScheme = theme;
// The product owns timeline scrolling; this standalone fixture owns page scrolling.
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg p-4 text-fg sm:p-8">
    <h1 className="mb-3 text-xl font-semibold">Session capability cards</h1>
    <p className="session-capability-card mb-6 text-sm text-fg-muted">
      Presentation fixture only. No provider requests or credential persistence.
    </p>
    <h2 className="sr-only">Connection suggestions</h2>
    <div className="grid gap-8">
      {scenarios.map((scenario) => (
        <Scenario key={scenario.id} scenario={scenario} />
      ))}
    </div>
  </main>,
);
