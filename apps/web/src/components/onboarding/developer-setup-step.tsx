import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { CheckIcon, CopyIcon, KeyRoundIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { apiBaseUrl } from "@/api";
import { Button } from "@/components/ui/button";
import { CopyField, useCopyToClipboard } from "@/components/ui/copy-field";
import { Disclosure } from "@/components/ui/disclosure";
import { ErrorMessage } from "@/components/ui/error-message";
import { LogoTile } from "@/components/ui/logo-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorDetails, userErrorText, userErrorTextWithoutReference } from "@/lib/api-error";
import { onboardingJourney } from "@/lib/onboarding-analytics";
import {
  DEVELOPER_SETUP_INITIAL_MESSAGE,
  DEVELOPER_SETUP_KEY_REQUEST,
  DEVELOPER_SETUP_KEY_VARIABLE,
  DEVELOPER_SETUP_VARIABLE_SET_NAME,
  DEVELOPER_SETUP_WORKSPACE_NAME,
  codingAgentSetupPrompt,
  deploymentApiOrigin,
  developerSetupModelContext,
} from "@/lib/onboarding-use-case";

/** Where onboarding sends the person when it finishes somewhere other than home. */
export type OnboardingDestination = { workspaceId: string; sessionId: string };

type DeveloperSetupClient = Pick<
  OpenGeniBrowserClient,
  "createOrganizationApiKey" | "createWorkspace" | "createVariableSet" | "createSession"
>;

type KeyState =
  | { status: "creating" }
  | { status: "ready"; token: string; prefix: string }
  | { status: "failed"; error: unknown };

/**
 * "Add AI agents to my product", after the organization and model steps. The
 * signed-in owner's click on that path is what creates the organization's
 * scoped Developer setup key, once, and shows it only here. From there the
 * person either lets Opengeni implement the integration in a new "Opengeni
 * setup" workspace, or copies a ready prompt for their own coding agent.
 *
 * The key never enters chat history: the setup chat reads it from a write-only
 * variable set in its sandbox, and its model context names only where it is.
 */
export function DeveloperSetupStep({
  client,
  organizationId,
  organizationName,
  onComplete,
}: {
  client?: DeveloperSetupClient | undefined;
  organizationId: string;
  organizationName?: string | undefined;
  onComplete: (destination?: OnboardingDestination) => void;
}) {
  const [key, setKey] = useState<KeyState>({ status: "creating" });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  // One key per attempt, even when React runs the effect twice.
  const keyRequests = useRef(
    new Map<number, ReturnType<DeveloperSetupClient["createOrganizationApiKey"]>>(),
  );
  // What "Let Opengeni implement it" already created, so a retry resumes.
  const implementProgress = useRef<{ workspaceId?: string; variableSetId?: string | null }>({});
  const sessionRequestKey = useRef(`onboarding-developer-setup:${crypto.randomUUID()}`);
  const promptCopy = useCopyToClipboard();
  const facts = {
    apiBaseUrl: deploymentApiOrigin(apiBaseUrl, window.location),
    organizationId,
    organizationName,
  };

  useEffect(() => {
    onboardingJourney().viewed("developer_setup");
  }, []);

  useEffect(() => {
    if (!client) {
      setKey({ status: "failed", error: new Error("Sign in again to create your API key.") });
      return;
    }
    let active = true;
    setKey({ status: "creating" });
    let request = keyRequests.current.get(attempt);
    if (!request) {
      request = client.createOrganizationApiKey(organizationId, { ...DEVELOPER_SETUP_KEY_REQUEST });
      keyRequests.current.set(attempt, request);
    }
    request.then(
      (created) => {
        if (active)
          setKey({ status: "ready", token: created.token, prefix: created.apiKey.prefix });
      },
      (error: unknown) => {
        if (active) setKey({ status: "failed", error });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, client, organizationId]);

  const finish = useCallback(
    (via: "copied_prompt" | "skipped") => {
      if (opening) return;
      onboardingJourney().completed("developer_setup", via);
      onComplete();
    },
    [onComplete, opening],
  );

  async function implementWithOpengeni(): Promise<void> {
    if (!client || opening) return;
    setOpening(true);
    const token = key.status === "ready" ? key.token : null;
    const progress = implementProgress.current;
    try {
      progress.workspaceId ??= (
        await client.createWorkspace({
          accountId: organizationId,
          name: DEVELOPER_SETUP_WORKSPACE_NAME,
        })
      ).id;
      const workspaceId = progress.workspaceId;
      if (token && progress.variableSetId === undefined) {
        // Without it the chat still starts; its context says no key is attached.
        progress.variableSetId = await client
          .createVariableSet(workspaceId, {
            scope: "workspace",
            name: DEVELOPER_SETUP_VARIABLE_SET_NAME,
            description: "The Developer setup API key from signup, for the setup chat's sandbox.",
            variables: [{ name: DEVELOPER_SETUP_KEY_VARIABLE, value: token }],
          })
          .then(
            (variableSet) => variableSet.id,
            () => null,
          );
      }
      const variableSetId = progress.variableSetId ?? null;
      const session = await client.createSession(workspaceId, {
        initialMessage: DEVELOPER_SETUP_INITIAL_MESSAGE,
        modelContext: developerSetupModelContext({
          ...facts,
          keyInSandbox: variableSetId !== null,
        }),
        ...(variableSetId ? { variableSetIds: [variableSetId] } : {}),
        idempotencyKey: sessionRequestKey.current,
      });
      onboardingJourney().completed("developer_setup", "implement_with_opengeni");
      onComplete({ workspaceId, sessionId: session.id });
    } catch (error) {
      toast.error("Couldn't open your setup chat", { description: userErrorText(error) });
      setOpening(false);
    }
  }

  async function copyPrompt(): Promise<void> {
    if (key.status !== "ready") return;
    if (await promptCopy.copy(codingAgentSetupPrompt({ ...facts, apiKey: key.token }))) {
      setPromptCopied(true);
    } else {
      toast.error("Couldn't copy the prompt", {
        description: "Copy the key above, then try again.",
      });
    }
  }

  const ready = key.status === "ready";
  return (
    <section className="og-page-glow flex min-h-0 flex-1 overflow-y-auto px-4 py-8">
      <div className="m-auto w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <LogoTile icon={<KeyRoundIcon />} tone="brand" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Add AI agents to your product</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Your API key is ready. Choose who builds the integration.
        </p>

        <div className="mt-6 grid gap-2" aria-live="polite" aria-busy={key.status === "creating"}>
          <h2 className="text-sm font-medium text-fg">API key</h2>
          {key.status === "ready" ? (
            <>
              <CopyField variant="field" wrap value={key.token} label="new API key" />
              <p className="text-xs leading-[18px] text-fg-muted">
                Shown only here. Both options below use it for you. It expires in 24 hours, can set
                up workspaces and tools, and can't create other keys.
              </p>
            </>
          ) : key.status === "creating" ? (
            <div role="status" className="flex items-center gap-2">
              <Skeleton className="h-10 flex-1 rounded-[10px]" />
              <span className="sr-only">Creating your API key</span>
            </div>
          ) : (
            <ErrorMessage
              variant="block"
              title="Couldn't create your API key."
              announce
              action={
                client ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Try again
                  </Button>
                ) : undefined
              }
              {...apiErrorDetails(key.error)}
            >
              {userErrorTextWithoutReference(key.error)}
            </ErrorMessage>
          )}
        </div>

        <div className="mt-6 grid gap-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={!client || opening || key.status === "creating"}
            onClick={() => void implementWithOpengeni()}
          >
            {opening ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SparklesIcon className="size-4" />
            )}
            {opening ? "Opening your setup chat…" : "Let Opengeni implement it"}
          </Button>
          <p className="text-xs leading-[18px] text-fg-muted">
            Opens a chat in a new {DEVELOPER_SETUP_WORKSPACE_NAME} workspace. The agent asks about
            your product, suggests connecting GitHub, and builds it with you.
          </p>
        </div>

        <div className="mt-5 grid gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            disabled={!ready || opening}
            onClick={() => void copyPrompt()}
          >
            {promptCopy.state === "copied" ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {promptCopy.state === "copied" ? "Prompt copied" : "Copy prompt for your coding agent"}
          </Button>
          <p className="text-xs leading-[18px] text-fg-muted" role="status">
            {promptCopied
              ? "Paste it into your coding agent, in your product's repository. It tells the agent to save the key to your server's .env and never repeat it."
              : "For Claude Code, Codex, Cursor or ChatGPT. Includes your key and how to get the Opengeni plugin."}
          </p>
          {ready ? (
            <Disclosure title="Preview the prompt" summary="Your key is hidden here">
              <pre
                tabIndex={0}
                className="max-h-64 max-w-full overflow-auto overscroll-contain rounded-[10px] border border-border bg-surface-2 p-3 text-xs leading-[18px] whitespace-pre-wrap text-fg"
              >
                <code translate="no" className="font-mono">
                  {codingAgentSetupPrompt({ ...facts, apiKey: `${key.prefix}…` })}
                </code>
              </pre>
            </Disclosure>
          ) : null}
        </div>

        <Button
          type="button"
          variant="ghost"
          className="mt-5 w-full text-fg-muted"
          disabled={opening}
          onClick={() => finish(promptCopied ? "copied_prompt" : "skipped")}
        >
          {promptCopied ? "Go to Opengeni" : "Skip for now"}
        </Button>
      </div>
    </section>
  );
}
