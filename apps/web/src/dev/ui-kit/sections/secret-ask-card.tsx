import { useEffect, useRef, type ReactNode } from "react";
import {
  HumanInputForm,
  SecretRefText,
  SecretsUiProvider,
  ToolActionReviewCard,
} from "@opengeni/react/session-ui";
import { MessageTimeline } from "@opengeni/react";
import type {
  HumanInputQuestion,
  HumanInputSecretSaveTo,
  HumanInputSecretSpec,
  SessionEvent,
  ToolActionReview,
} from "@opengeni/sdk";

import { MarkdownText } from "@/components/markdown";
import { webSecretsUi } from "@/lib/secrets-ui";
import { KitBlock, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   The ask card's secret question and the secret reference chips, rendered by
   the real @opengeni/react components with the console's SecretsUi.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function question(id: string, prompt: string, secret: HumanInputSecretSpec): HumanInputQuestion {
  return {
    id,
    kind: "secret",
    prompt,
    options: [],
    required: true,
    allowOther: false,
    secret,
  };
}

function AskCard({
  id,
  prompt,
  spec,
  allowedSaveTo,
  submitting,
  allowSkip = true,
}: {
  id: string;
  prompt: string;
  spec: HumanInputSecretSpec;
  allowedSaveTo?: HumanInputSecretSaveTo[];
  submitting?: boolean;
  allowSkip?: boolean;
}) {
  return (
    <HumanInputForm
      request={{
        id: `kit-${id}`,
        questions: [question(id, prompt, spec)],
        allowSkip,
        expiresAt: null,
      }}
      autoFocus={false}
      allowedSaveTo={allowedSaveTo}
      submitting={submitting}
      onSubmit={async () => {
        await wait(900);
      }}
    />
  );
}

/**
 * Puts a field into a state that needs input (a typed value, a blur, a
 * click), so the state can be screenshotted. Kit only; never a real secret.
 */
function Drive({
  children,
  type,
  blur = false,
  click,
}: {
  children: ReactNode;
  type?: string;
  blur?: boolean;
  click?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      if (click === "submit") {
        root.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      } else if (click) {
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === click)
          ?.click();
      }
      const input = root.querySelector<HTMLInputElement>('input[name^="secret-"]');
      if (input && type !== undefined) {
        input.value = type;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (input && blur) input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    return () => cancelAnimationFrame(frame);
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="min-w-0">
      {children}
    </div>
  );
}

/* ---- answered history ------------------------------------------------------ */

let sequence = 0;
function event(type: string, payload: unknown): SessionEvent {
  sequence += 1;
  return {
    id: `kit-secret-${sequence}`,
    workspaceId: "ws-kit",
    sessionId: "session-kit",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 8, 26, 11, 48, sequence)).toISOString(),
    turnId: "turn-kit",
  };
}

const askedGithub = {
  id: "github",
  kind: "secret",
  label: "GitHub password",
  prompt: "Your GitHub password",
  options: [],
  required: true,
  secret: { item: "GitHub", username: { prompt: "Username" } },
};

function historyEvents(requestId: string, response: Record<string, unknown>): SessionEvent[] {
  return [
    event("session.humanInput.requested", {
      request: { id: requestId, questions: [askedGithub] },
    }),
    event("user.humanInputResponse", { requestId, response }),
    event("turn.completed", {}),
  ];
}

const ANSWERED = historyEvents("kit-answered", {
  outcome: "answered",
  answers: [
    {
      questionId: "github",
      values: [],
      secret: {
        reference: "{{secret:Private/GitHub/password}}",
        username: "octocat",
        vaultName: "Private",
        itemName: "GitHub",
        saveTo: "user",
      },
    },
  ],
});
const SKIPPED = historyEvents("kit-skipped", { outcome: "skipped" });
const EXPIRED = historyEvents("kit-expired", { outcome: "expired" });

const CONVERSATION: SessionEvent[] = [
  event("user.message", {
    text: "Deploy staging with {{secret:Deploy/token}} and log in as {{secret:Private/GitHub/password}}.",
  }),
  event("agent.toolCall.created", {
    id: "kit-exec",
    name: "exec_command",
    arguments: { cmd: "deploy --env staging --token {{secret:Deploy/token}}" },
  }),
  event("agent.toolCall.output", { id: "kit-exec", output: "Deployed staging in 42s." }),
  event("agent.message.completed", {
    text: "Deployed. The token stays in `{{secret:Deploy/token}}`; the one-time code came from {{secret:GitHub/otp}}.",
  }),
  event("turn.completed", {}),
];

/* ---- chip placements ------------------------------------------------------- */

const MARKDOWN = [
  "I saved your key as {{secret:OpenAI/api_key}} and will use **{{secret:Stripe/api_key}}** for billing.",
  "",
  "- Previous value: {{secret:GitHub/password#previous}}",
  "- Kubeconfig file: {{secretfile:Production/kubeconfig}}",
  "- By ID: {{secret:id:6f1c1b8e-3b1a-4c55-9a51-0d0c8f2e7d11/api_key}}",
  "- Long name: {{secret:Customer success shared mailbox for the Nordics region/password}}",
  "",
  "Inline code with only a reference: `{{secret:Deploy/token}}`. Mixed code stays literal: `export TOKEN={{secret:Deploy/token}}`.",
  "",
  "Malformed stays text: {{secret:}}.",
  "",
  "```sh",
  "curl -H 'Authorization: Bearer {{secret:Stripe/api_key}}' https://api.stripe.com",
  "```",
].join("\n");

const REVIEW = {
  version: 1,
  id: "kit-review",
  actionDigest: "kit",
  revision: "kit-1",
  status: "pending",
  title: "Create a GitHub deploy key",
  effects: [],
  samples: [],
  fields: [
    { label: "Repository", path: "repository", preview: "acme/widget" },
    { label: "Key", path: "key", preview: "{{secretfile:Deploy/public_key}}" },
    {
      label: "Webhook",
      path: "webhook",
      preview: "https://hooks.acme.dev/deploy?token={{secret:Deploy/webhook_secret}}",
      truncated: true,
    },
  ],
  moreFields: 0,
  reason: "Adds a write key to acme/widget.",
  createdAt: "2026-09-26T11:48:00Z",
  updatedAt: "2026-09-26T11:48:00Z",
  approveLabel: "Create key",
  availableActions: ["approve", "reject"],
  detailsAvailable: true,
} as unknown as ToolActionReview;

const noop = () => undefined;

export default function SecretAskCardSection() {
  return (
    <SecretsUiProvider value={webSecretsUi}>
      <KitSection sectionKey="secret-ask-card">
        <StatesGrid
          title="Ask card"
          description="The value is read from the input at submit and never kept. Save to defaults to Only me."
          columns={2}
        >
          <StateCell label="Password" align="stretch">
            <AskCard id="current" prompt="Your GitHub password" spec={{ item: "GitHub" }} />
          </StateCell>
          <StateCell
            label="New password, with Generate"
            align="stretch"
            note="Generate fills the field and shows it."
          >
            <AskCard
              id="new"
              prompt="A password for the staging database"
              spec={{ item: "Staging database", allowGenerate: true, saveTo: "task" }}
            />
          </StateCell>
          <StateCell label="API key, with a format hint" align="stretch">
            <AskCard
              id="api-key"
              prompt="Your OpenAI API key"
              spec={{ item: "OpenAI", itemType: "api_key", looksLike: "sk-…", pattern: "^sk-" }}
            />
          </StateCell>
          <StateCell label="One-time code" align="stretch">
            <AskCard
              id="otp"
              prompt="The 6-digit code from your authenticator"
              spec={{ item: "GitHub", fieldKind: "totp" }}
            />
          </StateCell>
          <StateCell
            label="With username"
            align="stretch"
            note="Username first, so password managers fill both."
          >
            <AskCard
              id="login"
              prompt="Sign in to the AWS console"
              spec={{
                item: "AWS console",
                username: { prompt: "Username", value: "ops@example.com" },
                vault: "Private",
              }}
            />
          </StateCell>
          <StateCell
            label="Save to downgraded"
            align="stretch"
            note="The agent asked for This workspace; this person can't write there."
          >
            <AskCard
              id="downgraded"
              prompt="The shared Stripe key"
              spec={{ item: "Stripe", itemType: "api_key", saveTo: "workspace" }}
              allowedSaveTo={["user", "task"]}
            />
          </StateCell>
          <StateCell label="Format warning" align="stretch" note="Soft: Send still works.">
            <Drive type="not-a-key" blur>
              <AskCard
                id="warning"
                prompt="Your OpenAI API key"
                spec={{ item: "OpenAI", itemType: "api_key", looksLike: "sk-…", pattern: "^sk-" }}
              />
            </Drive>
          </StateCell>
          <StateCell
            label="Generated by the server"
            align="stretch"
            note="No client generator: nothing to show, with Undo."
          >
            <SecretsUiProvider value={null}>
              <Drive click="Generate">
                <AskCard
                  id="server-generate"
                  prompt="A password for the staging database"
                  spec={{ item: "Staging database", allowGenerate: true }}
                />
              </Drive>
            </SecretsUiProvider>
          </StateCell>
          <StateCell label="Sending" align="stretch">
            <Drive type="kit-example-value">
              <AskCard
                id="submitting"
                prompt="Your GitHub password"
                spec={{ item: "GitHub" }}
                submitting
              />
            </Drive>
          </StateCell>
          <StateCell label="Missing answer" align="stretch">
            <Drive click="submit">
              <AskCard
                id="required"
                prompt="Your GitHub password"
                spec={{ item: "GitHub" }}
                allowSkip={false}
              />
            </Drive>
          </StateCell>
        </StatesGrid>

        <StatesGrid
          title="After answering"
          description="Where it was saved, never the value."
          columns={3}
        >
          <StateCell label="Saved" align="stretch">
            <MessageTimeline events={ANSWERED} />
          </StateCell>
          <StateCell label="Skipped" align="stretch">
            <MessageTimeline events={SKIPPED} />
          </StateCell>
          <StateCell label="Expired" align="stretch">
            <MessageTimeline events={EXPIRED} />
          </StateCell>
        </StatesGrid>

        <StatesGrid
          title="Reference chips"
          description="A lock, the item and the field; the full reference on hover. Parsing only: chips never show a value."
          columns={2}
        >
          <StateCell label="Agent message" align="stretch" span="full">
            <MarkdownText text={MARKDOWN} />
          </StateCell>
          <StateCell
            label="Conversation: user message, command and reply"
            align="stretch"
            span="full"
          >
            <MessageTimeline events={CONVERSATION} />
          </StateCell>
          <StateCell label="Approval" align="stretch">
            <ToolActionReviewCard
              review={REVIEW}
              onApprove={noop}
              onReject={noop}
              onViewDetails={noop}
            />
          </StateCell>
          <StateCell label="Inbox approval line" align="stretch">
            <code className="my-0.5 inline-block max-w-full truncate rounded-[6px] bg-surface-2 px-1.5 py-0.5 align-top font-mono text-xs text-fg">
              <SecretRefText
                text="github.create_deploy_key({ key: {{secretfile:Deploy/public_key}} })"
                linkable={false}
              />
            </code>
          </StateCell>
          <StateCell
            label="Without a SecretsUi provider"
            align="stretch"
            note="Embedders without the tokenizer see the text as written."
          >
            <SecretsUiProvider value={null}>
              <MarkdownText text="Saved as {{secret:OpenAI/api_key}}." />
            </SecretsUiProvider>
          </StateCell>
        </StatesGrid>

        <KitBlock title="Labels">
          <ul className="m-0 grid list-none gap-2 p-0 text-sm text-fg">
            {[
              "{{secret:GitHub}}",
              "{{secret:GitHub/password}}",
              "{{secret:Private/GitHub/password}}",
              "{{secret:GitHub/otp}}",
              "{{secret:GitHub/password#previous}}",
              "{{secret:id:6f1c1b8e-3b1a-4c55-9a51-0d0c8f2e7d11/api_key}}",
              "{{secretfile:Production/kubeconfig}}",
            ].map((reference) => (
              <li key={reference} className="flex min-w-0 flex-wrap items-center gap-3">
                <SecretRefText text={reference} />
                <code className="font-mono text-xs text-fg-subtle">{reference}</code>
              </li>
            ))}
          </ul>
        </KitBlock>

        <UsageNotes
          use={[
            "Ask for a password, API key or one-time code the agent needs, and save it straight to a vault.",
            "Show references the agent or a person wrote as chips, wherever text is shown.",
          ]}
          avoid={[
            "Never put a secret value in a chip, an answer or a copy action.",
            "Never chip inside fenced code or links: code reads and copies as written.",
          ]}
        />
      </KitSection>
    </SecretsUiProvider>
  );
}
