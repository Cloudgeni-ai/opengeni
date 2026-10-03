import { useNavigate } from "@tanstack/react-router";
import { Blocks, ChevronLeftIcon, CompassIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { useGitHubAppConnectLauncher } from "@/components/github-app-connect-launcher";
import { ModelAccessOnboardingPanel } from "@/components/model-access-onboarding";
import { Confetti } from "@/components/onboarding/confetti";
import { OnboardingFrame, OnboardingStep } from "@/components/onboarding/onboarding-frame";
import { useGetStarted, type GetStartedState } from "@/components/onboarding/use-get-started";
import { UseQuestion } from "@/components/onboarding/use-question";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import { userErrorText, userErrorTextWithoutReference } from "@/lib/api-error";
import { queueComposerPrefill, queueComposerSend } from "@/lib/composer-prefill";
import {
  buildsProduct,
  composeOpengeniPrompt,
  EMPTY_FIRST_AGENT,
  FIRST_AGENT_TASKS,
  hasAnyProductAnswer,
  useForIntents,
  writeFirstChatDraft,
  type FirstAgentAnswers,
  type FirstAgentOutcome,
  type FirstAgentProductAnswer,
  type FirstAgentRepository,
} from "@/lib/first-agent";
import { gitHubRepositoryResource } from "@/lib/session-tools";
import { cn } from "@/lib/utils";

export const FIRST_AGENT_STEPS = ["use", "product", "details", "ready"] as const;
export type FirstAgentStep = (typeof FIRST_AGENT_STEPS)[number];

/** Steps that belong to a product's agent, and so to the shared Development workspace. */
const PRODUCT_STEPS: ReadonlySet<FirstAgentStep> = new Set(["details"]);

/**
 * First run inside the app (`/workspaces/:id/first-agent`), after the first
 * question created the organization:
 *
 * - `use`: "What do you want to use Opengeni for?" (replays and Get started).
 * - `product`: a product exists, or the person explores first.
 * - `details`: the product's website, optional GitHub repository and job.
 * - `ready`: the moment that says what they got (the trial credits, with
 *   confetti) and starts them off: the building chat for a product, first
 *   chats to pick otherwise. Without credits or a usable model it is the
 *   model step first, so nobody is stuck.
 *
 * Every step has Skip, which goes to `ready`; every way out of `ready` lands
 * in a chat or a ready composer with GPT-6 Luna at extra high reasoning when
 * credits pay for it. Answers are kept as the person types.
 */
export function FirstAgentRoute({
  workspaceId,
  step,
}: {
  workspaceId: string;
  step: FirstAgentStep;
}) {
  const state = useGetStarted(workspaceId);
  const context = useAppContext();
  const navigate = useNavigate();
  const answers = state.journey?.firstAgent ?? EMPTY_FIRST_AGENT;
  const developmentId = state.developmentWorkspaceId;
  // A product's agent lives where API keys reach it, so GitHub, the key and
  // its chats are set up there.
  const productWorkspaceId = developmentId ?? workspaceId;
  const homeWorkspaceId = state.personalWorkspaceId ?? workspaceId;
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (PRODUCT_STEPS.has(step) && developmentId && developmentId !== workspaceId)
      void navigate({
        to: "/workspaces/$workspaceId/first-agent",
        params: { workspaceId: developmentId },
        search: { step },
        replace: true,
      });
  }, [developmentId, navigate, step, workspaceId]);

  const go = (next: FirstAgentStep, targetWorkspaceId = workspaceId) =>
    void navigate({
      to: "/workspaces/$workspaceId/first-agent",
      params: { workspaceId: targetWorkspaceId },
      search: next === "use" ? {} : { step: next },
    });

  /** Skip, from any question: straight to the ready moment, answers kept. */
  const skip = () => {
    if (!answers.outcome) state.updateFirstAgent({ outcome: "skipped" });
    go("ready", homeWorkspaceId);
  };

  /**
   * Prepares the new chat (GPT-6 Luna at extra high reasoning on credits, and
   * the message and repository when there are some), then opens the new-chat
   * page; `send` starts the chat there as soon as it can.
   */
  const handOff = async (
    targetWorkspaceId: string,
    message: string | null,
    {
      send,
      repository,
      outcome,
    }: { send: boolean; repository?: FirstAgentRepository | null; outcome: FirstAgentOutcome },
  ) => {
    if (leaving) return;
    setLeaving(true);
    state.updateFirstAgent({ outcome });
    try {
      const written = await writeFirstChatDraft(context.client, targetWorkspaceId, message, {
        repository: repository?.resource ?? null,
        replace: send,
      });
      // A message the person typed stays as it is unless they asked to start.
      if (!written && send && message) queueComposerPrefill(targetWorkspaceId, message);
    } catch {
      // The draft couldn't be saved: hand the message over in memory instead.
      if (message) queueComposerPrefill(targetWorkspaceId, message);
    }
    if (send) queueComposerSend(targetWorkspaceId);
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId: targetWorkspaceId },
    });
  };

  const skipButton = (
    <Button
      type="button"
      variant="ghost"
      className="text-fg-muted pointer-coarse:h-11"
      onClick={skip}
      {...analyticsAction("skip_first_agent")}
    >
      Skip
    </Button>
  );

  let content: ReactNode;
  if (step === "product") {
    content = (
      <ProductQuestionStep
        state={state}
        answers={answers}
        skip={skipButton}
        onBack={() => go("use", homeWorkspaceId)}
        onHave={(id) => go("details", id ?? workspaceId)}
        onExplore={() => go("ready", homeWorkspaceId)}
      />
    );
  } else if (step === "details") {
    content = (
      <ProductStep
        state={state}
        workspaceId={productWorkspaceId}
        answers={answers}
        skip={skipButton}
        onBack={() => go("product", homeWorkspaceId)}
        onContinue={() => go("ready", productWorkspaceId)}
      />
    );
  } else if (step === "ready") {
    content = (
      <ReadyStep
        state={state}
        workspaceId={workspaceId}
        answers={answers}
        busy={leaving}
        onBuild={() =>
          void handOff(productWorkspaceId, composeOpengeniPrompt(answers), {
            send: true,
            repository: answers.repository,
            outcome: "session",
          })
        }
        onOpenApp={() => {
          // Skipping keeps what was entered: a product's prompt waits in the
          // new chat's draft, unsent.
          const product = answers.use === "product" && hasAnyProductAnswer(answers);
          void handOff(
            product ? productWorkspaceId : homeWorkspaceId,
            product ? composeOpengeniPrompt(answers) : null,
            {
              send: false,
              repository: product ? answers.repository : null,
              outcome: answers.outcome === "skipped" ? "skipped" : "app",
            },
          );
        }}
      />
    );
  } else {
    content = (
      <OnboardingStep stepKey="first-agent-use" title="What do you want to use Opengeni for?">
        <UseQuestion
          initialUse={answers.use ?? useForIntents(state.journey?.intents ?? [])}
          onChoose={(use, { submit }) => {
            state.chooseUse(use);
            if (submit) go(use === "product" ? "product" : "ready", homeWorkspaceId);
          }}
          onSkip={skip}
        />
      </OnboardingStep>
    );
  }

  // The frame scrolls itself, like the signed-out setup pages it continues.
  return (
    <div data-workspace-scroll-owner="self-managed" className="flex min-h-0 flex-1 flex-col">
      <OnboardingFrame
        account={
          context.authSession?.user.email ? (
            <p className="min-w-0 truncate text-xs text-fg-muted">
              <span className="max-[480px]:sr-only">Signed in as </span>
              <span className="font-medium text-fg">{context.authSession.user.email}</span>
            </p>
          ) : null
        }
      >
        {content}
      </OnboardingFrame>
    </div>
  );
}

/** The footer every step shares: Back on the left, Skip and the one primary on the right. */
function StepFooter({
  onBack,
  skip,
  children,
}: {
  onBack?: (() => void) | undefined;
  skip?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          className="-ml-2 text-fg-muted pointer-coarse:h-11"
          onClick={onBack}
        >
          <ChevronLeftIcon aria-hidden="true" />
          Back
        </Button>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {skip}
        {children}
      </div>
    </div>
  );
}

const PRODUCT_ANSWERS: ReadonlyArray<{
  value: FirstAgentProductAnswer;
  title: string;
  icon: ReactNode;
}> = [
  {
    value: "have",
    title: "I already have a product",
    icon: <Blocks />,
  },
  {
    value: "explore",
    title: "I want to explore first",
    icon: <CompassIcon />,
  },
];

function ProductQuestionStep({
  state,
  answers,
  skip,
  onBack,
  onHave,
  onExplore,
}: {
  state: GetStartedState;
  answers: FirstAgentAnswers;
  skip: ReactNode;
  onBack: () => void;
  onHave: (developmentId: string | null) => void;
  onExplore: () => void;
}) {
  const [answer, setAnswer] = useState<FirstAgentProductAnswer | null>(answers.product);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    // Nothing is required: no answer goes straight to the ready moment.
    if (!answer) {
      onExplore();
      return;
    }
    if (answer === "explore") {
      onExplore();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onHave(await state.ensureDevelopmentWorkspace());
    } catch (problem) {
      setError(
        `We couldn't set up a workspace for your product. ${userErrorTextWithoutReference(problem, "Try again.")}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <OnboardingStep stepKey="first-agent-product" title="Do you already have a product?">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ChoiceCards
          aria-label="Do you already have a product?"
          value={answer ?? ""}
          onValueChange={(value) => {
            const next = value as FirstAgentProductAnswer;
            setAnswer(next);
            state.updateFirstAgent({ product: next });
          }}
          error={error ?? undefined}
          disabled={busy}
        >
          {PRODUCT_ANSWERS.map((option) => (
            <ChoiceCard
              key={option.value}
              value={option.value}
              title={option.title}
              icon={option.icon}
            />
          ))}
        </ChoiceCards>
        <StepFooter onBack={onBack} skip={skip}>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? "Setting things up…" : "Continue"}
          </Button>
        </StepFooter>
      </form>
    </OnboardingStep>
  );
}

function ProductStep({
  state,
  workspaceId,
  answers,
  skip,
  onBack,
  onContinue,
}: {
  state: GetStartedState;
  workspaceId: string;
  answers: FirstAgentAnswers;
  skip: ReactNode;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <OnboardingStep stepKey="first-agent-product" title="Tell us about your product">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onContinue();
        }}
      >
        <FieldStack>
          <Field label="Website or app">
            <TextInput
              autoComplete="url"
              placeholder="acme.com"
              value={answers.website}
              autoFocus
              onChange={(event) => state.updateFirstAgent({ website: event.target.value })}
            />
          </Field>
          <RepositoryField
            state={state}
            workspaceId={workspaceId}
            repository={answers.repository}
            onChange={(repository) => state.updateFirstAgent({ repository })}
          />
          <TaskField task={answers.task} onChange={(task) => state.updateFirstAgent({ task })} />
        </FieldStack>
        <StepFooter onBack={onBack} skip={skip}>
          <Button type="submit">Continue</Button>
        </StepFooter>
      </form>
    </OnboardingStep>
  );
}

const NO_REPOSITORY = "__none__";

/**
 * "Connect GitHub repo": the connect flow this deployment offers (the
 * workspace GitHub App, or the person's own GitHub), then a pick from its
 * repositories. Says so plainly when GitHub isn't set up here.
 */
function RepositoryField({
  state,
  workspaceId,
  repository,
  onChange,
}: {
  state: GetStartedState;
  workspaceId: string;
  repository: FirstAgentRepository | null;
  onChange: (repository: FirstAgentRepository | null) => void;
}) {
  const context = useAppContext();
  const launcher = useGitHubAppConnectLauncher(workspaceId);
  const [connecting, setConnecting] = useState(false);
  const { github } = state;

  const connect = () => {
    if (github.mode === "workspace") {
      launcher.open();
      return;
    }
    setConnecting(true);
    void context
      .connectPersonalGitHub(workspaceId)
      .catch((error) =>
        toast.error("Couldn't start GitHub sign-in", { description: userErrorText(error) }),
      )
      .finally(() => setConnecting(false));
  };

  const appRepositories = github.mode === "workspace" ? context.githubRepos : [];
  const personalRepositories =
    github.mode === "personal"
      ? context.personalGitHubRepositories.filter((repo) => !repo.archived)
      : [];
  const options: SelectOption[] = [
    { value: NO_REPOSITORY, label: "No repository" },
    ...appRepositories.map((repo) => ({
      value: `app:${repo.id}`,
      label: repo.fullName,
      meta: repo.private ? "Private" : undefined,
      keywords: [repo.name],
    })),
    ...personalRepositories.map((repo) => ({
      value: `personal:${repo.repositoryId}`,
      label: repo.fullName,
      meta: repo.private ? "Private" : undefined,
    })),
  ];
  const choose = (value: string) => {
    if (value === NO_REPOSITORY) return onChange(null);
    if (value.startsWith("app:")) {
      const repo = appRepositories.find((candidate) => `app:${candidate.id}` === value);
      if (repo)
        onChange({
          fullName: repo.fullName,
          url: repo.htmlUrl,
          resource: gitHubRepositoryResource(repo, repo.defaultBranch),
        });
      return;
    }
    const repo = personalRepositories.find(
      (candidate) => `personal:${candidate.repositoryId}` === value,
    );
    // Your own GitHub's repositories are attached from the chat, where access
    // is chosen; here the agent learns which one it is.
    if (repo) onChange({ fullName: repo.fullName, url: repo.canonicalUrl, resource: null });
  };

  let control: ReactNode;
  if (!github.available) {
    control = (
      <p className="text-sm leading-5 text-fg-muted">GitHub isn't set up on this server.</p>
    );
  } else if (github.connected === null) {
    control = (
      <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        Checking GitHub
      </p>
    );
  } else if (!github.connected) {
    control = (
      <div className="flex flex-wrap items-center gap-3">
        {launcher.element}
        <Button
          type="button"
          variant="outline"
          disabled={connecting}
          onClick={connect}
          {...analyticsAction("connect_github")}
        >
          {connecting ? <Loader2Icon aria-hidden="true" className="size-4 animate-spin" /> : null}
          Connect GitHub repo
        </Button>
      </div>
    );
  } else {
    control = (
      <SelectMenu
        variant="combobox"
        options={options}
        value={
          repository
            ? (options.find((option) => option.label === repository.fullName)?.value ??
              NO_REPOSITORY)
            : NO_REPOSITORY
        }
        onValueChange={choose}
        placeholder="Choose a repository"
        searchPlaceholder="Search repositories"
        emptyMessage="No repositories match. Add more in GitHub, then come back."
        loading={
          github.mode === "workspace"
            ? !context.githubCatalogReady
            : !context.personalGitHubCatalogReady
        }
        className="w-full"
      />
    );
  }

  return (
    <Field label="GitHub repository" group={!github.connected}>
      {control}
    </Field>
  );
}

function TaskField({ task, onChange }: { task: string; onChange: (task: string) => void }) {
  return (
    <Field label="What should the agent do?">
      <TextArea
        rows={3}
        value={task}
        placeholder="Answer customer questions, using our docs and the customer's account"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Examples" role="group">
        {FIRST_AGENT_TASKS.map((example) => {
          const selected = task.trim() === example.task;
          return (
            <button
              key={example.label}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(example.task)}
              className={cn(
                "h-7 rounded-full border px-3 text-xs font-medium transition-colors duration-[120ms] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-9",
                selected
                  ? "border-transparent bg-selection text-fg"
                  : "border-border bg-surface-2 text-fg-muted hover:hover-layer",
              )}
            >
              {example.label}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** "$10", or "$10.50": the currency sign is enough, and whole amounts need no cents. */
export function creditAmount(balanceMicros: number, currency: string): string {
  const amount = balanceMicros / 1_000_000;
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    return `${whole ? amount : amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * The ready moment: what the person got and a way straight in. With trial
 * credits it celebrates the real balance and never asks about models (GPT-6
 * Luna at extra high reasoning is preselected). Without credits, and without a
 * model that can run, it is the model step first, so nobody is stuck.
 */
function ReadyStep({
  state,
  workspaceId,
  answers,
  busy,
  onBuild,
  onOpenApp,
}: {
  state: GetStartedState;
  workspaceId: string;
  answers: FirstAgentAnswers;
  busy: boolean;
  onBuild: () => void;
  onOpenApp: () => void;
}) {
  const context = useAppContext();
  const [modelStepDone, setModelStepDone] = useState(false);
  const balance = state.credits.balance;
  const credits = balance && balance.balanceMicros > 0 ? balance : null;
  // The balance is read once the catalog says credits are sold here.
  const checking =
    state.modelReady === null || (state.credits.sold && state.credits.loading && !credits);
  // Only someone who can connect models is asked to (never an option they can't use).
  const needsModel =
    !checking && !credits && state.modelReady === false && state.canManageModels && !modelStepDone;
  const celebrate = !checking && !needsModel;
  const [celebrated] = useState(() => Boolean(state.journey?.marks.celebrated));
  useEffect(() => {
    if (celebrate) state.mark("celebrated");
  }, [celebrate, state]);

  if (checking)
    return (
      <section className="flex flex-1 items-center justify-center" role="status">
        <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
        <span className="sr-only">Getting your agents ready</span>
      </section>
    );

  if (needsModel && state.organizationId)
    return (
      <ModelAccessOnboardingPanel
        client={context.client}
        organizationId={state.organizationId}
        workspaceId={workspaceId}
        billingMode={context.clientConfig.billingMode ?? "disabled"}
        codexEnabled={state.codexEnabled}
        supergrokEnabled={context.clientConfig.models.some((model) => model.source === "supergrok")}
        onComplete={() => setModelStepDone(true)}
      />
    );

  const builds = buildsProduct(answers) && answers.outcome !== "skipped";
  const amount = credits ? creditAmount(credits.balanceMicros, credits.currency) : null;
  return (
    <>
      <Confetti play={!celebrated} />
      <OnboardingStep
        stepKey="first-agent-ready"
        title={amount ? `You got ${amount} in free credits` : "You're all set"}
      >
        {builds ? (
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={onBuild}
            {...analyticsAction("start_first_agent_chat")}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            Start building
          </Button>
        ) : (
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            onClick={onOpenApp}
            {...analyticsAction("skip_first_agent")}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            Start
          </Button>
        )}
      </OnboardingStep>
    </>
  );
}
