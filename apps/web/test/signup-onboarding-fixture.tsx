import { createRoot } from "react-dom/client";
import { useState } from "react";
import { OrganizationOnboardingPanel } from "../src/components/organization-onboarding-panel";
import { Toaster } from "../src/components/ui/sonner";
import "../src/styles.css";

// Local fixture for the post-signup onboarding: a recording fake client, a
// trial credit balance, and no real keys, workspaces or chats.
const requests: Array<{ method: string; args: unknown[] }> = [];
Object.assign(window, { onboardingRequests: requests });
const record =
  <T,>(method: string, result: (...args: unknown[]) => T, delayMs = 250) =>
  async (...args: unknown[]): Promise<T> => {
    requests.push({ method, args });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return result(...args);
  };

const client = {
  createOrganizationApiKey: record("createOrganizationApiKey", () => ({
    apiKey: { id: "11111111-1111-4111-8111-111111111111", prefix: "ogk_Fx7qK2" },
    token: "ogk_Fx7qK2_preview-only-not-a-real-key-9d3c1a",
  })),
  createWorkspace: record("createWorkspace", () => ({
    id: "33333333-3333-4333-8333-333333333333",
  })),
  createVariableSet: record("createVariableSet", () => ({
    id: "44444444-4444-4444-8444-444444444444",
  })),
  createSession: record(
    "createSession",
    () => ({ id: "55555555-5555-4555-8555-555555555555" }),
    700,
  ),
};

function Fixture() {
  const [landed, setLanded] = useState<string | null>(null);
  if (landed)
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-6 text-fg">
        <p data-testid="landed">{landed}</p>
      </main>
    );
  return (
    <main className="flex min-h-dvh flex-col bg-bg text-fg">
      <OrganizationOnboardingPanel
        client={client as never}
        previewState="required"
        billingMode="stripe"
        codexEnabled
        supergrokEnabled
        includedModel={{ id: "free-model", label: "Opengeni Free", free: true }}
        startingCredits={{
          balance: { balanceMicros: 10_000_000, currency: "usd" },
          model: { id: "gpt-6-luna", label: "GPT-6 Luna", reasoningEffort: "high" },
        }}
        activeEmail="maja@northwind.example"
        onSignOut={() => undefined}
        onComplete={(destination) =>
          setLanded(
            destination
              ? `Opened chat ${destination.sessionId} in workspace ${destination.workspaceId}`
              : "Opened home",
          )
        }
      />
      <Toaster />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
