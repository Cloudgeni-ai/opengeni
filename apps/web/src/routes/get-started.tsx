import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { apiBaseUrl } from "@/api";
import { useGitHubAppConnectLauncher } from "@/components/github-app-connect-launcher";
import { CodingAgentTabs } from "@/components/onboarding/coding-agent-tabs";
import { OpengeniCreditsPanel } from "@/components/model-payment/opengeni-credits-panel";
import { FirstTaskOptions } from "@/components/onboarding/first-task-options";
import { GetStartedStatusIcon } from "@/components/onboarding/get-started-status";
import { OwnAgentSetup } from "@/components/onboarding/own-agent-setup";
import { useGetStarted, type GetStartedState } from "@/components/onboarding/use-get-started";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { PageHeader } from "@/components/ui/page-header";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import { userErrorText } from "@/lib/api-error";
import {
  apiOriginFor,
  buildWithOpengeniPrompt,
  mcpServerGuides,
  type CodingAgentSetup,
} from "@/lib/coding-agent-setup";
import { queueComposerPrefill } from "@/lib/composer-prefill";
import { composeCodingAgentPrompt, hasProductDetails } from "@/lib/first-agent";
import {
  onboardingIntentsLabel,
  type GetStartedItem,
  type GetStartedItemId,
} from "@/lib/get-started";

const STEP_ANCHORS: Record<GetStartedItemId, string> = {
  path: "path",
  model: "model",
  credits: "credits",
  github: "github",
  first_task: "first-task",
  playground: "playground",
  api_key: "product",
  coding_agent: "coding-agent",
};

/**
 * Get started: every step of the person's first-run path on one page, each
 * with its one action. Reached from first-run setup (Run in the cloud), the
 * checklist card's "See all", and Help & feedback. `step` scrolls to one step.
 */
export function GetStartedRoute({
  workspaceId,
  step,
}: {
  workspaceId: string;
  step: string | null;
}) {
  const state = useGetStarted(workspaceId);
  const navigate = useNavigate();

  useEffect(() => {
    if (!step) return;
    const target = document.getElementById(`get-started-${step}`);
    if (!target) return;
    // Scroll the page's own scroller only: scrollIntoView would also move the
    // document and shift the whole app shell.
    const scroller = target.closest<HTMLElement>('[data-slot="content-page"]');
    if (scroller)
      scroller.scrollTop +=
        target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
    target.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, [step, state.items.length]);

  const intents = state.journey?.intents ?? [];
  const pathLabel = onboardingIntentsLabel(intents);
  return (
    <ContentPage width="standard">
      <div className="w-full max-w-[720px]">
        <PageHeader
          title="Get started"
          description={
            pathLabel || state.journey?.invited
              ? `${pathLabel ? `${pathLabel} · ` : ""}${state.progress.done} of ${state.progress.total} done`
              : "Tell us what you're building, and we'll show the steps."
          }
        />
        {intents.length === 0 && !state.journey?.invited ? (
          <section className="mt-2 max-w-[560px]" aria-label="Build your first agent">
            <Button asChild>
              <Link
                to="/workspaces/$workspaceId/first-agent"
                params={{ workspaceId }}
                {...analyticsAction("open_first_agent")}
              >
                Build your first agent
              </Link>
            </Button>
          </section>
        ) : (
          <ol className="m-0 list-none p-0">
            {state.items.map((item, index) => (
              <StepSection key={item.id} item={item} index={index}>
                <StepBody
                  item={item}
                  state={state}
                  workspaceId={workspaceId}
                  onPrompt={(prompt) => {
                    // Done only once a chat exists; prefilling isn't running it.
                    queueComposerPrefill(workspaceId, prompt);
                    void navigate({
                      to: "/workspaces/$workspaceId/sessions",
                      params: { workspaceId },
                    });
                  }}
                  onSchedule={(template) =>
                    void navigate({
                      to: "/workspaces/$workspaceId/schedules/new",
                      params: { workspaceId },
                      search: { template },
                    })
                  }
                />
              </StepSection>
            ))}
          </ol>
        )}
      </div>
    </ContentPage>
  );
}

function StepSection({
  item,
  index,
  children,
}: {
  item: GetStartedItem;
  index: number;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <li
      id={`get-started-${STEP_ANCHORS[item.id]}`}
      aria-labelledby={headingId}
      className="scroll-mt-6 border-t border-border py-6 first:border-t-0 first:pt-2"
    >
      <div className="flex min-w-0 gap-3">
        <GetStartedStatusIcon done={item.done} optional={item.optional} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            tabIndex={-1}
            className="flex flex-wrap items-baseline gap-x-2 text-base leading-6 font-semibold tracking-[-0.2px] text-fg outline-none"
          >
            <span className="sr-only">Step {index + 1}: </span>
            {item.title}
            {item.optional && !item.done ? (
              <span className="text-2xs font-medium text-fg-subtle">Optional</span>
            ) : null}
          </h2>
          <p className="mt-1 text-sm leading-5 text-fg-muted">{item.description}</p>
          {children}
        </div>
      </div>
    </li>
  );
}

function StepBody({
  item,
  state,
  workspaceId,
  onPrompt,
  onSchedule,
}: {
  item: GetStartedItem;
  state: GetStartedState;
  workspaceId: string;
  onPrompt: (prompt: string) => void;
  onSchedule: (template: "morning-brief") => void;
}) {
  switch (item.id) {
    case "path":
      return (
        <Actions>
          <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
            <Link to="/workspaces/$workspaceId/first-agent" params={{ workspaceId }}>
              {item.done ? "Change your answers" : "Build your first agent"}
            </Link>
          </Button>
          {state.journey?.checklistDismissed ? (
            <Button type="button" size="sm" variant="ghost" onClick={state.restore}>
              Show on new chats
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={state.dismiss}>
              Hide from new chats
            </Button>
          )}
        </Actions>
      );
    case "model": {
      if (!state.canManageModels || item.done) return null;
      const intents = state.journey?.intents ?? [];
      const codexFirst =
        intents.includes("cloud") && !intents.includes("build") && state.codexEnabled;
      return (
        <Actions>
          <Button asChild size="sm">
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId }}
              search={
                {
                  section: "models",
                  view: codexFirst ? "connect-org:codex" : "connect",
                  from: `/workspaces/${workspaceId}/get-started`,
                  fromLabel: "Get started",
                } as never
              }
              {...analyticsAction(codexFirst ? "connect_codex" : "connect_model")}
            >
              {codexFirst ? "Connect ChatGPT" : "Connect a model"}
            </Link>
          </Button>
        </Actions>
      );
    }
    case "credits":
      return item.done || !state.organizationId ? null : (
        <OpengeniCreditsPanel
          className="mt-4 max-w-[400px]"
          credits={state.credits}
          organizationId={state.organizationId}
          margin={state.credits.margin}
          showPrice={false}
          successUrl={`${window.location.origin}/workspaces/${workspaceId}/get-started?step=credits`}
          cancelUrl={`${window.location.origin}/workspaces/${workspaceId}/get-started?step=credits`}
          beforeCheckout={async () => state.mark("credits_checkout")}
        />
      );
    case "github":
      return <GitHubStep done={item.done === true} state={state} workspaceId={workspaceId} />;
    case "first_task":
      return (
        <div className="mt-4">
          <FirstTaskOptions onPrompt={onPrompt} onSchedule={onSchedule} />
          <p className="mt-2 text-xs text-fg-muted">
            Nothing starts until you press Send or Create schedule.
          </p>
        </div>
      );
    case "playground":
      return (
        <Actions>
          <Button asChild variant={item.done ? "outline" : "default"} size="sm">
            <Link
              to="/workspaces/$workspaceId/playground"
              params={{ workspaceId: state.developmentWorkspaceId ?? workspaceId }}
              {...analyticsAction("open_playground")}
            >
              {item.done ? "Open the playground again" : "Open the playground"}
            </Link>
          </Button>
        </Actions>
      );
    case "api_key":
      return <ProductStep state={state} />;
    case "coding_agent":
      return (
        <CodingAgentStep setup={state.codingAgent} onCopied={() => state.mark("coding_agent")} />
      );
  }
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap items-center gap-2">{children}</div>;
}

function GitHubStep({
  done,
  state,
  workspaceId,
}: {
  done: boolean;
  state: GetStartedState;
  workspaceId: string;
}) {
  const context = useAppContext();
  const launcher = useGitHubAppConnectLauncher(workspaceId);
  const [busy, setBusy] = useState(false);
  if (state.github.connected) return null;
  const connect = () => {
    if (state.github.mode === "workspace") {
      launcher.open();
      return;
    }
    setBusy(true);
    void context
      .connectPersonalGitHub(workspaceId)
      .catch((error) =>
        toast.error("Couldn't start GitHub sign-in", { description: userErrorText(error) }),
      )
      .finally(() => setBusy(false));
  };
  const skipped = done;
  return (
    <Actions>
      {launcher.element}
      <Button
        type="button"
        size="sm"
        variant={skipped ? "outline" : "default"}
        disabled={busy}
        onClick={connect}
        {...analyticsAction("connect_github")}
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        Connect GitHub
      </Button>
      {skipped ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => state.mark("github_skipped")}
        >
          Skip for now
        </Button>
      )}
    </Actions>
  );
}

/**
 * Build: put an agent in your own product by having a coding agent build it.
 * Add Opengeni to the coding agent, create the API key the app's server
 * uses (shown once), paste one prompt with the real IDs, and watch for the
 * app's first chat here, which is the Build path's success.
 */
function ProductStep({ state }: { state: GetStartedState }) {
  const context = useAppContext();
  const workspaceId = state.developmentWorkspaceId;
  const organizationId = state.organizationId;
  if (!organizationId) return null;
  if (!workspaceId)
    return (
      <p className="mt-4 text-sm text-fg-muted">
        {state.canCreateWorkspaces
          ? 'Products reach shared workspaces. Answer "Add AI agents to my product" on Build your first agent to set one up.'
          : "Products reach shared workspaces. Ask an organization admin to add you to one."}
      </p>
    );
  const apiOrigin = apiOriginFor(apiBaseUrl, window.location.origin);
  const answers = state.journey?.firstAgent ?? null;
  const fromAnswers = Boolean(answers && answers.use === "product" && hasProductDetails(answers));
  const prompt =
    answers && fromAnswers
      ? composeCodingAgentPrompt(answers, { apiOrigin, organizationId, workspaceId })
      : buildWithOpengeniPrompt({ apiOrigin, organizationId, workspaceId });
  const workspaceName =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Development";
  return (
    <OwnAgentSetup
      className="mt-4 flex min-w-0 flex-col gap-8"
      organizationId={organizationId}
      workspaceId={workspaceId}
      canCreateApiKeys={state.canCreateApiKeys}
      prompt={prompt}
      promptDescription={
        fromAnswers
          ? `It uses what you told us about your product. Each chat your product starts shows up in ${workspaceName}.`
          : `It builds a small web app on your computer with an Opengeni agent chat, and each chat shows up in ${workspaceName}.`
      }
      mcpUrl={state.codingAgent.oauth ? state.codingAgent.mcpUrl : null}
      firstSessionSeen={Boolean(state.journey?.marks.first_api_session)}
      onMark={state.mark}
    />
  );
}

function CodingAgentStep({ setup, onCopied }: { setup: CodingAgentSetup; onCopied: () => void }) {
  return (
    <div className="mt-4 flex min-w-0 flex-col gap-3">
      <CodingAgentTabs guides={mcpServerGuides(setup)} onCopied={onCopied} />
      <p className="text-xs leading-4.5 text-fg-muted">
        Then ask it to run something on Opengeni, for example "Run the flaky-test investigation on
        Opengeni and give me the link." It works with your permissions in this workspace.
      </p>
    </div>
  );
}
