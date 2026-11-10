import { useLayoutEffect, useState } from "react";
import type { OwnSubscriptionPlan, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { ModelPolicyPicker, projectPickerRows } from "@opengeni/react";
import { t } from "@opengeni/react/app/lib/console-text";
import {
  OwnSubscriptionPlanNote,
  OwnSubscriptionPlanNotice,
} from "@opengeni/react/app/components/credits/own-subscription-plan-notice";
import { CodexConnectPage, type CodexPlaces } from "@/components/models/codex-models";
import type { CodexSubscriptions } from "@/components/codex-connection";

/**
 * DEV only. Where a plan without own subscriptions is said: the connect page,
 * the model picker, and the new-chat notices. Production components with
 * fixtures; `?theme=dark|light`, `?desktop=macos`, `?view=connect|picker|notices`.
 */
const PRO: OwnSubscriptionPlan = { key: "pro", label: "Pro", monthlyPriceMicros: 20_000_000 };
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function model(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    cost: "credits",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: { status: "ready", reason: null, basis: "connection", checkedAt: null },
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

function subscription(
  id: string,
  label: string,
  provider: "codex" | "supergrok",
  providerLabel: string,
): WorkspaceModelCatalogModel {
  return model({
    id,
    label,
    provider,
    providerLabel,
    source: provider,
    cost: "subscription",
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
    requiredPlan: PRO,
  } as Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">);
}

const rows = projectPickerRows(t, [
  model({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", shortLabel: "5.6 Sol" }),
  model({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", shortLabel: "5.6 Luna" }),
  subscription("codex/gpt-6-astra", "GPT-6 Astra", "codex", "Codex"),
  subscription("codex/gpt-5.6-sol", "GPT-5.6 Sol", "codex", "Codex"),
  subscription("supergrok/grok-4.6", "Grok 4.6", "supergrok", "SuperGrok"),
]);

const codex = {
  canManage: true,
  busy: false,
  pending: null,
  connect: async () => undefined,
} as unknown as CodexSubscriptions;

const places: CodexPlaces = {
  workspaceName: "Personal",
  organizationName: "Acme Robotics",
  scope: {} as CodexPlaces["scope"],
  openAccount: () => undefined,
  openConnect: () => undefined,
  openAccess: () => undefined,
  backToList: () => undefined,
};

export function OwnSubscriptionPlanPreview() {
  const search = new URLSearchParams(window.location.search);
  const theme = search.get("theme");
  const desktop = search.get("desktop");
  const view = search.get("view");
  useLayoutEffect(() => {
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.ogTheme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
    if (desktop === "macos") document.documentElement.dataset.desktop = "macos";
  }, [theme, desktop]);
  const [selected, setSelected] = useState("codex/gpt-6-astra");
  const [dismissed, setDismissed] = useState(false);

  return (
    <main className="flex min-h-screen flex-col gap-10 bg-bg p-8 text-fg">
      {!view || view === "connect" ? (
        <section data-preview="connect" className="w-full max-w-[720px]">
          <h2 className="mb-3 text-xs font-medium tracking-wide text-fg-subtle uppercase">
            Settings → Models → Connect Codex
          </h2>
          <CodexConnectPage
            codex={codex}
            places={places}
            onClose={() => undefined}
            fields={<OwnSubscriptionPlanNote plan={PRO} />}
          />
        </section>
      ) : null}
      {!view || view === "picker" ? (
        <section data-preview="picker" className="flex min-h-[520px] w-full flex-col items-start">
          <h2 className="mb-3 text-xs font-medium tracking-wide text-fg-subtle uppercase">
            Model picker (Free plan)
          </h2>
          <ModelPolicyPicker
            rows={rows}
            model={selected}
            effort="medium"
            latencyMode="standard"
            menuSide="bottom"
            defaultOpen
            onModelChange={setSelected}
            onEffortChange={() => undefined}
            onLatencyModeChange={() => undefined}
          />
        </section>
      ) : null}
      {!view || view === "notices" ? (
        <section data-preview="notices" className="flex w-full max-w-[720px] flex-col gap-6">
          <h2 className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
            New chat: a subscription model is chosen (owner)
          </h2>
          <OwnSubscriptionPlanNotice plan={PRO} workspaceId={WORKSPACE_ID} canUpgrade />
          <h2 className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
            New chat: one-time heads-up, connected earlier (owner)
          </h2>
          {dismissed ? (
            <p className="text-sm text-fg-muted">Dismissed for good.</p>
          ) : (
            <OwnSubscriptionPlanNotice
              plan={PRO}
              workspaceId={WORKSPACE_ID}
              canUpgrade
              onDismiss={() => setDismissed(true)}
            />
          )}
          <h2 className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
            New chat: a member who can't change the plan
          </h2>
          <OwnSubscriptionPlanNotice plan={PRO} workspaceId={WORKSPACE_ID} canUpgrade={false} />
        </section>
      ) : null}
    </main>
  );
}
