import { describe, expect, test } from "bun:test";
import { useState } from "react";
import {
  OpenGeniApiError,
  OpenGeniAllowanceExhaustedError,
  OpenGeniSetupError,
  OpenGeniSecureContextRequiredError,
} from "@opengeni/sdk";
import { OpenGeniProvider } from "../src/provider";
import { OpenGeniChat } from "../src/components/open-geni-chat";
import { SessionConversation } from "../src/components/session-conversation";
import { ApprovalSurface } from "../src/components/approval-surface";
import { ChatComposer } from "../src/components/chat-composer";
import { MessageTimeline } from "../src/components/message-timeline";
import { SessionList } from "../src/components/session-list";
import { HumanInputForm } from "../src/components/human-input-form";
import { GeneratedVideoPlayer } from "../src/components/generated-video-player";
import { QueueErrorAlert } from "../src/components/queue-surface-state";
import { defaultCommands } from "../src/commands/registry";
import type { Notice } from "../src/commands/types";
import { useSlashCommands, type UseSlashCommandsResult } from "../src/hooks/use-slash-commands";
import {
  useFileAttachments,
  type UseFileAttachmentsResult,
} from "../src/hooks/use-file-attachments";
import { useComposer, type ComposerControllerState } from "../src/hooks/use-composer";
import { conversationTimeline } from "../src/conversation-timeline";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function errors() {
  return [
    new OpenGeniApiError(
      403,
      JSON.stringify({
        error: {
          code: "permission_denied",
          message: "OpenGeni denied this action",
          requestId: "acme-403",
          details: { missingPermission: "sessions:create" },
        },
      }),
      { mutation: true },
    ),
    new OpenGeniSetupError(new OpenGeniApiError(409, "", { correlationId: "acme-setup" })),
    new OpenGeniAllowanceExhaustedError(
      429,
      JSON.stringify({
        error: {
          code: "allowance_exhausted",
          message: "OpenGeni usage reached",
          details: { scope: "member", resetsAt: "2026-10-03T00:00:00Z" },
        },
      }),
    ),
    new OpenGeniApiError(0, "", {
      code: "network_error",
      retryable: true,
      outcomeUnknown: true,
      correlationId: "acme-unknown",
      displayMessage: "OpenGeni could not confirm delivery",
    }),
    new TypeError("OpenGeni transport private diagnostic"),
  ];
}

function client() {
  return fakeClient({
    getWorkspace: async () => ({ inferenceControl: { revision: 0 } }) as never,
    streamWorkspaceLiveEvents: async function* () {},
    listSessionPage: async () => ({ sessions: [], pinned: [], nextCursor: null }) as never,
    getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
    getQueue: async () => ({ version: 0, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* () {},
  });
}

async function submitNewChat(container: HTMLElement) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    "[data-og-new-chat-composer] textarea",
  )!;
  await actRun(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "A private ACME question",
    );
    const key = Object.keys(textarea).find((name) => name.startsWith("__reactProps$"))!;
    (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({
      target: textarea,
    });
  });
  await actRun(() => textarea.form!.requestSubmit());
  await flush(30);
}

describe("native branded-host error paths", () => {
  test("the host formatter receives non-Error rejections unchanged", async () => {
    const failure = { code: "host_error", message: "OpenGeni diagnostic" };
    let received: unknown;
    const view = await renderComponent(
      <OpenGeniProvider
        client={client()}
        workspaceId={WORKSPACE_ID}
        formatError={(original, message) => {
          received = original;
          return message;
        }}
      >
        <OpenGeniChat
          createSession={async () => {
            throw failure;
          }}
        />
      </OpenGeniProvider>,
    );
    try {
      await submitNewChat(view.container);
      expect(received).toBe(failure);
      expect(view.container.querySelector("[role='alert']")!.textContent).toBe(
        "The request could not be completed.",
      );
    } finally {
      await view.unmount();
    }
  });
  test("native command failures use host copy but successful returned content remains exact", async () => {
    const sdk = client();
    const error = errors()[0]!;
    let calls = 0;
    let command!: UseSlashCommandsResult;
    sdk.compactSessionContext = async () => {
      if (++calls === 1) throw error;
      return { status: "completed", message: "The OpenGeni source was compacted." };
    };
    const received: unknown[] = [];
    function Harness() {
      const [value, setValue] = useState("/compact");
      const [notice, setNotice] = useState<Notice | null>(null);
      command = useSlashCommands({
        commands: defaultCommands,
        context: {
          client: sdk,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          status: null,
          permissions: ["sessions:control"] as never,
        },
        handlers: {
          notice: setNotice,
          openHelp: () => {},
          clearView: () => false,
          confirm: async () => true,
        },
        value,
        setValue,
      });
      return <p role={notice?.tone === "error" ? "alert" : "status"}>{notice?.message}</p>;
    }
    const view = await renderComponent(
      <OpenGeniProvider
        client={sdk}
        workspaceId={WORKSPACE_ID}
        formatError={(original, message) => {
          received.push(original);
          return `ACME: ${message}`;
        }}
      >
        <Harness />
      </OpenGeniProvider>,
    );
    try {
      await actRun(() => command.runHighlighted());
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "ACME: You don’t have permission",
      );
      expect(received).toContain(error);
      await actRun(() => command.runHighlighted());
      expect(view.container.querySelector("[role='status']")!.textContent).toBe(
        "The OpenGeni source was compacted.",
      );
    } finally {
      await view.unmount();
    }
  });
  for (const error of errors()) {
    test(`NewChat defaults are neutral for ${error.name} ${"code" in error ? error.code : "transport"}`, async () => {
      const view = await renderComponent(
        <OpenGeniChat
          client={client()}
          workspaceId={WORKSPACE_ID}
          labels={{ heading: "ACME conversations", newChatPlaceholder: "Ask ACME" }}
          createSession={async () => {
            throw error;
          }}
        />,
      );
      try {
        await submitNewChat(view.container);
        const alert = view.container.querySelector("[role='alert']")!;
        expect(alert).not.toBeNull();
        expect(alert.textContent).not.toMatch(/opengeni/i);
        expect(view.container.textContent).toContain("ACME");
        expect(view.container.querySelector("textarea")!.value).toBe("A private ACME question");
        if (error instanceof OpenGeniApiError && error.outcomeUnknown)
          expect(alert.textContent).toContain("Check its status before retrying");
        if (error instanceof OpenGeniSetupError)
          expect(alert.textContent).toContain("administrator");
        if (error instanceof OpenGeniAllowanceExhaustedError)
          expect(alert.textContent).toContain("Usage limit reached");
      } finally {
        await view.unmount();
      }
    });
  }

  test("one provider formatter customizes NewChat and receives original typed diagnostics", async () => {
    const error = errors()[0]!;
    const received: unknown[] = [];
    const view = await renderComponent(
      <OpenGeniProvider
        client={client()}
        workspaceId={WORKSPACE_ID}
        formatError={(original, defaultMessage) => {
          received.push(original);
          return `ACME Assistant: ${defaultMessage}`;
        }}
      >
        <OpenGeniChat
          labels={{ heading: "ACME conversations", newChatPlaceholder: "Ask ACME" }}
          createSession={async () => {
            throw error;
          }}
        />
      </OpenGeniProvider>,
    );
    try {
      await submitNewChat(view.container);
      expect(view.container.querySelector("[role='alert']")!.textContent).toBe(
        "ACME Assistant: You don’t have permission to do that. Reference: acme-403.",
      );
      expect(received).toContain(error);
      expect(error).toMatchObject({
        code: "permission_denied",
        retryable: false,
        outcomeUnknown: false,
        details: { missingPermission: "sessions:create" },
      });
      expect(error.message).toContain("OpenGeni denied this action");
    } finally {
      await view.unmount();
    }
  });

  test("conversation reads use the same host formatter without masking failed loading as empty", async () => {
    const sdk = client();
    sdk.getSession = async () => {
      throw errors()[0];
    };
    const view = await renderComponent(
      <OpenGeniProvider
        client={sdk}
        workspaceId={WORKSPACE_ID}
        formatError={(_error, message) => `ACME: ${message}`}
      >
        <SessionConversation sessionId={SESSION_ID} modelPicker={false} attachments={false} />
      </OpenGeniProvider>,
    );
    try {
      await flush(60);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "ACME: You don’t have permission",
      );
      expect(view.container.textContent).not.toMatch(/opengeni/i);
    } finally {
      await view.unmount();
    }
  });

  test("approval failures keep unknown-outcome guidance and the requested action remains pending", async () => {
    const error = errors()[3]!;
    const view = await renderComponent(
      <ApprovalSurface
        approvals={[
          { id: "approval", name: "update_profile", arguments: { title: "ACME profile" } },
        ]}
        onApprove={async () => {
          throw error;
        }}
        onReject={() => {}}
      />,
    );
    try {
      await actRun(() =>
        view.container
          .querySelectorAll<HTMLButtonElement>("[data-approval-id='approval'] button")[1]!
          .click(),
      );
      await flush(20);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "Check its status before retrying",
      );
      expect(view.container.textContent).not.toMatch(/opengeni/i);
      expect(view.container.textContent).toContain("Approval required");
    } finally {
      await view.unmount();
    }
  });

  test("composer delivery copy is neutral while original diagnostics and uncertainty survive", async () => {
    const sdk = client();
    const error = errors()[3]!;
    sdk.sendMessage = async () => {
      throw error;
    };
    let composer!: ComposerControllerState;
    let deliveredError: Error | undefined;
    function Harness() {
      composer = useComposer(SESSION_ID, {
        draftPersistence: "disabled",
        initialPolicy: { model: "model-x", reasoningEffort: "medium", latencyMode: "standard" },
        onDeliveryError: (original) => {
          deliveredError = original;
        },
      });
      return (
        <>
          <MessageTimeline
            items={conversationTimeline([], { queue: [], snapshot: null }, composer)}
          />
          <ChatComposer composer={composer} />
        </>
      );
    }
    const view = await renderComponent(
      <OpenGeniProvider
        client={sdk}
        workspaceId={WORKSPACE_ID}
        formatError={(_error, message) => `ACME: ${message}`}
      >
        <Harness />
      </OpenGeniProvider>,
    );
    try {
      await actRun(() => composer.setValue("A private question"));
      await actRun(() => composer.send());
      await flush(60);
      expect(view.container.textContent).toContain("ACME: The request could not be confirmed");
      expect(view.container.textContent).toContain("Reference: acme-unknown.");
      expect(view.container.textContent).not.toMatch(/opengeni/i);
      expect(composer.optimisticMessages?.[0]).toMatchObject({
        state: "failed",
        retryable: true,
        outcomeUnknown: true,
        text: "A private question",
      });
      expect(deliveredError).toBe(error);
      expect(deliveredError?.message).toContain("OpenGeni could not confirm delivery");
    } finally {
      await view.unmount();
    }
  });

  test("user and assistant quotations are not rewritten by the error presenter", async () => {
    const view = await renderComponent(
      <MessageTimeline
        items={[
          {
            kind: "user-message",
            id: "user",
            text: "My source mentions OpenGeni.",
            tools: [],
            resources: [],
            occurredAt: "2026-10-02T07:00:00Z",
          },
          {
            kind: "agent-message",
            id: "agent",
            turnId: null,
            text: "The quoted source says OpenGeni.",
            streaming: false,
            occurredAt: "2026-10-02T07:00:01Z",
          },
        ]}
      />,
    );
    try {
      expect(view.container.textContent).toContain("My source mentions OpenGeni.");
      expect(view.container.textContent).toContain("The quoted source says OpenGeni.");
    } finally {
      await view.unmount();
    }
  });

  test("a failed list read is not presented as a successful empty chat list", async () => {
    const sdk = client();
    sdk.listSessionPage = async () => {
      throw errors()[0];
    };
    const view = await renderComponent(
      <SessionList client={sdk} workspaceId={WORKSPACE_ID} onSelect={() => {}} />,
    );
    try {
      await flush(40);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "You don’t have permission",
      );
      expect(view.container.textContent).not.toContain("No chats yet");
      expect(view.container.textContent).not.toMatch(/opengeni/i);
    } finally {
      await view.unmount();
    }
  });

  test("upload errors retain the original cause and display secure-connection guidance", async () => {
    const sdk = client();
    const failure = new OpenGeniSecureContextRequiredError("insecure_context");
    sdk.uploadFile = async () => {
      throw failure;
    };
    let uploads!: UseFileAttachmentsResult;
    function Harness() {
      const composer = useComposer(SESSION_ID, {
        draftPersistence: "disabled",
        initialPolicy: { model: "model-x", reasoningEffort: "medium", latencyMode: "standard" },
      });
      uploads = useFileAttachments();
      return <ChatComposer composer={composer} attachments={uploads} />;
    }
    const view = await renderComponent(
      <OpenGeniProvider
        client={sdk}
        workspaceId={WORKSPACE_ID}
        formatError={(_cause, message) => `ACME: ${message}`}
      >
        <Harness />
      </OpenGeniProvider>,
    );
    try {
      await actRun(() =>
        uploads.addFiles([new File(["notes"], "notes.txt", { type: "text/plain" })]),
      );
      await flush(30);
      expect(view.container.textContent).toContain("ACME: Attachments require HTTPS");
      expect(view.container.textContent).not.toMatch(/opengeni/i);
      expect(uploads.attachments[0]).toMatchObject({
        status: "failed",
        errorCode: "secure_context_required",
        errorCause: failure,
      });
      expect(uploads.hasUnresolved).toBe(true);
      expect(uploads.readyResources).toEqual([]);
      expect(failure.message).toContain("OpenGeni");
    } finally {
      await view.unmount();
    }
  });

  test("human-input failures remain pending and preserve question content", async () => {
    const view = await renderComponent(
      <HumanInputForm
        request={{
          id: "request",
          allowSkip: false,
          expiresAt: null,
          questions: [
            {
              id: "q",
              kind: "text",
              prompt: "The source says OpenGeni. Continue?",
              options: [],
              required: false,
              allowOther: false,
            },
          ],
        }}
        onSubmit={async () => {
          throw errors()[3];
        }}
      />,
    );
    try {
      await actRun(() => view.container.querySelector("form")!.requestSubmit());
      await flush(20);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "Check its status before retrying",
      );
      expect(view.container.querySelector("[role='alert']")!.textContent).not.toMatch(/opengeni/i);
      expect(view.container.textContent).toContain("The source says OpenGeni. Continue?");
      expect(view.container.querySelector("button[type='submit']")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("Skill previews fail closed with neutral actionable copy when no reader exists", async () => {
    let submissions = 0;
    const view = await renderComponent(
      <HumanInputForm
        request={{
          id: "review",
          allowSkip: false,
          expiresAt: null,
          questions: [
            {
              id: "skill",
              kind: "single_select",
              prompt: "Save the OpenGeni integration Skill?",
              options: [{ id: "save", label: "Save" }],
              required: true,
              allowOther: false,
              skillReview: {
                sourceOperationId: "operation",
                skillId: "skill",
                revisionId: "revision",
                expectedRevisionId: null,
                expectedScopeVersion: 1,
              },
            },
          ],
        }}
        onSubmit={() => {
          submissions += 1;
        }}
      />,
    );
    try {
      await flush(20);
      expect(view.container.textContent).toContain(
        "Ask your administrator for a review-capable client",
      );
      expect(view.container.textContent).not.toContain("Open this request in Opengeni");
      await actRun(() =>
        view.container.querySelector<HTMLInputElement>("input[type='radio']")!.click(),
      );
      await actRun(() => view.container.querySelector("form")!.requestSubmit());
      expect(submissions).toBe(0);
      expect(view.container.textContent).toContain(
        "Ask your administrator for a review-capable client",
      );
      expect(view.container.textContent).toContain("Save the OpenGeni integration Skill?");
    } finally {
      await view.unmount();
    }
  });

  test("queue and generated-video loaders share the host formatter", async () => {
    const failure = errors()[0]!;
    const view = await renderComponent(
      <OpenGeniProvider
        client={client()}
        workspaceId={WORKSPACE_ID}
        formatError={(_cause, message) => `ACME: ${message}`}
      >
        <QueueErrorAlert
          queue={
            {
              mutationError: failure,
              error: null,
              clearMutationError: () => {},
              refresh: async () => {},
            } as never
          }
        />
        <GeneratedVideoPlayer
          receipt={{ artifact: { artifactId: "video" } } as never}
          loadPlaybackSource={async () => {
            throw failure;
          }}
        />
      </OpenGeniProvider>,
    );
    try {
      await flush(20);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "ACME: You don’t have permission",
      );
      expect(view.container.querySelector("[role='status']")!.textContent).toContain(
        "ACME: You don’t have permission",
      );
      expect(view.container.textContent).not.toMatch(/opengeni/i);
    } finally {
      await view.unmount();
    }
  });

  test("a partial host formatter can fall back to the neutral default", async () => {
    const view = await renderComponent(
      <OpenGeniProvider client={client()} workspaceId={WORKSPACE_ID} formatError={() => undefined}>
        <OpenGeniChat
          createSession={async () => {
            throw errors()[0];
          }}
        />
      </OpenGeniProvider>,
    );
    try {
      await submitNewChat(view.container);
      expect(view.container.querySelector("[role='alert']")!.textContent).toContain(
        "You don’t have permission",
      );
      expect(view.container.querySelector("[role='alert']")!.textContent).not.toMatch(/opengeni/i);
    } finally {
      await view.unmount();
    }
  });
});
