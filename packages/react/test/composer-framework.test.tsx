import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import * as Composer from "../src/composer";
import { ChatComposer } from "../src/components/chat-composer";
import type { SlashCommand } from "../src/commands/types";
import type { ComposerState } from "../src/hooks/use-composer";
import type { UseFileAttachmentsResult } from "../src/hooks/use-file-attachments";
import type { SlashCommandContext } from "../src/hooks/use-slash-commands";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

function delivery(
  value: string,
  setValue: (value: string) => void,
  overrides: Partial<Composer.ComposerDelivery> = {},
): Composer.ComposerDelivery {
  return {
    value,
    setValue,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

function fullComposer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    ...delivery("hello", () => {}),
    hasDraftContent: () => false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    ...overrides,
  };
}

function attachments(overrides: Partial<UseFileAttachmentsResult> = {}): UseFileAttachmentsResult {
  return {
    attachments: [],
    readyResources: [],
    uploading: false,
    addFiles: () => {},
    addFromPaste: () => {},
    retry: () => {},
    remove: () => {},
    clear: () => {},
    ...overrides,
  };
}

const commandContext: SlashCommandContext = {
  client: fakeClient({}),
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  status: null,
  permissions: [],
};

const activeControl = {
  state: "active" as const,
  controlVersion: 0,
  controlEtag: "active",
  directState: "active" as const,
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

function DraftAccessory() {
  const controller = Composer.useChatComposer();
  return (
    <button
      type="button"
      onClick={() => {
        controller.setValue(`${controller.value} from accessory`);
        controller.focusInput();
      }}
    >
      Insert dictated text
    </button>
  );
}

function DeliveryOnlyComposer() {
  const [value, setValue] = useState("hello");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const controller = Composer.useChatComposerController({
    delivery: delivery(value, setValue),
  });
  return (
    <Composer.Root controller={controller}>
      <Composer.Surface>
        <Composer.Input ref={inputRef} data-custom-input />
        <Composer.Footer>
          <Composer.Controls>
            <DraftAccessory />
          </Composer.Controls>
          <Composer.Actions>
            <Composer.SendButton />
          </Composer.Actions>
        </Composer.Footer>
      </Composer.Surface>
    </Composer.Root>
  );
}

describe("compound composer framework", () => {
  test("existing preset slots can consume the safe composer context", async () => {
    function Harness() {
      const [value, setValue] = useState("hello");
      return (
        <ChatComposer
          composer={fullComposer({ value, setValue, canSend: value.trim().length > 0 })}
          controlsStart={<DraftAccessory />}
        />
      );
    }
    mounted = await renderComponent(<Harness />);
    const textarea = mounted.container.querySelector("textarea");
    const accessory = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Insert dictated text",
    );
    await act(async () => accessory?.click());
    expect(textarea?.value).toBe("hello from accessory");
    expect(document.activeElement).toBe(textarea);
  });

  test("a delivery-only composition supports custom accessories and forwarded input refs", async () => {
    mounted = await renderComponent(<DeliveryOnlyComposer />);
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>("[data-custom-input]");
    const accessory = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Insert dictated text",
    );

    await act(async () => accessory?.click());

    expect(textarea?.value).toBe("hello from accessory");
    expect(document.activeElement).toBe(textarea);
    expect(mounted.container.querySelector('[aria-label="Send message"]')).not.toBeNull();
  });

  test("custom action controls cannot bypass the controller upload gate", async () => {
    let sends = 0;
    function UnsafeLookingAccessory() {
      const controller = Composer.useChatComposer();
      return (
        <button type="button" onClick={() => void controller.submit("queue")}>
          Submit through controller
        </button>
      );
    }
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery("ready", () => {}, {
          send: async () => {
            sends += 1;
            return true;
          },
        }),
        attachments: attachments({ uploading: true }),
      });
      return (
        <Composer.Root controller={controller}>
          <UnsafeLookingAccessory />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    expect(sends).toBe(0);
  });

  test("Input only emits palette relationships when the matching primitive is mounted", async () => {
    function Harness({ withPalette }: { withPalette: boolean }) {
      const controller = Composer.useChatComposerController({
        delivery: delivery("/", () => {}),
        commandContext,
      });
      return (
        <Composer.Root controller={controller}>
          {withPalette ? <Composer.CommandPalette /> : null}
          <Composer.Input />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness withPalette={false} />);
    expect(mounted.container.querySelector("textarea")?.getAttribute("aria-controls")).toBeNull();

    await mounted.rerender(<Harness withPalette />);
    const textarea = mounted.container.querySelector("textarea");
    const listbox = mounted.container.querySelector('[role="listbox"]');
    expect(textarea?.getAttribute("aria-controls")).toBe(listbox?.id);
  });

  test("an omitted palette cannot execute a slash command invisibly", async () => {
    let commandsRun = 0;
    let sends = 0;
    const sideEffectingCommand: SlashCommand = {
      name: "side-effect",
      description: "Run a side effect",
      run: async () => {
        commandsRun += 1;
        return { status: "ok", keepDraft: false };
      },
    };
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery("/side-effect", () => {}, {
          send: async () => {
            sends += 1;
            return true;
          },
        }),
        commands: [sideEffectingCommand],
        commandContext,
      });
      return (
        <Composer.Root controller={controller}>
          <Composer.Input />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector("textarea")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(commandsRun).toBe(0);
    expect(sends).toBe(0);
  });

  test("the controller rejects same-tick duplicate submissions", async () => {
    let sends = 0;
    let resolveFirst: ((value: boolean) => void) | undefined;
    function SubmitTwice() {
      const controller = Composer.useChatComposer();
      return (
        <button
          type="button"
          onClick={() => {
            void controller.submit("queue");
            void controller.submit("queue");
          }}
        >
          Submit twice
        </button>
      );
    }
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery("ready", () => {}, {
          send: async () => {
            sends += 1;
            if (sends === 1) {
              return await new Promise<boolean>((resolve) => {
                resolveFirst = resolve;
              });
            }
            return true;
          },
        }),
      });
      return (
        <Composer.Root controller={controller}>
          <SubmitTwice />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    const button = mounted.container.querySelector<HTMLButtonElement>("button");

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(sends).toBe(1);

    await act(async () => {
      resolveFirst?.(true);
      await Promise.resolve();
    });
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(sends).toBe(2);
  });

  test("control actions share one same-tick operation fence", async () => {
    let pauses = 0;
    let resumes = 0;
    let scopedResumes = 0;
    let resolvePause: (() => void) | undefined;
    let resolveResume: (() => void) | undefined;
    const resumeOption = {
      scope: "selected" as const,
      targetId: SESSION_ID,
      selectedStateAfter: "active" as const,
      impactCopy: "Resume",
    };
    function RaceControls() {
      const controller = Composer.useChatComposer();
      return (
        <>
          <button
            type="button"
            onClick={() => {
              void controller.pause();
              void controller.pause();
              void controller.resume();
            }}
          >
            Race pause
          </button>
          <button
            type="button"
            onClick={() => {
              void controller.resume();
              void controller.resumeScope(resumeOption);
            }}
          >
            Race resume
          </button>
        </>
      );
    }
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery("ready", () => {}),
        control: {
          pause: async () => {
            pauses += 1;
            await new Promise<void>((resolve) => {
              resolvePause = resolve;
            });
          },
          pausing: false,
          resume: async () => {
            resumes += 1;
            await new Promise<void>((resolve) => {
              resolveResume = resolve;
            });
          },
          resumeScope: async () => {
            scopedResumes += 1;
          },
          resuming: false,
        },
      });
      return (
        <Composer.Root controller={controller}>
          <RaceControls />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    const [pauseButton, resumeButton] = mounted.container.querySelectorAll("button");

    await act(async () => {
      pauseButton?.click();
      await Promise.resolve();
    });
    expect(pauses).toBe(1);
    expect(resumes).toBe(0);

    await act(async () => {
      resolvePause?.();
      await Promise.resolve();
    });
    await act(async () => {
      resumeButton?.click();
      await Promise.resolve();
    });
    expect(resumes).toBe(1);
    expect(scopedResumes).toBe(0);

    await act(async () => {
      resolveResume?.();
      await Promise.resolve();
    });
  });

  test("a scoped open-control event focuses only the requested composer", async () => {
    mounted = await renderComponent(
      <>
        <ChatComposer composer={fullComposer()} effectiveControl={activeControl} />
        <ChatComposer composer={fullComposer()} effectiveControl={activeControl} />
      </>,
    );
    const roots = mounted.container.querySelectorAll<HTMLElement>("[data-og-composer-id]");
    const pauseButtons = mounted.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Pause this workstream"]',
    );
    expect(roots).toHaveLength(2);
    expect(pauseButtons).toHaveLength(2);

    await act(async () => {
      document.dispatchEvent(
        new CustomEvent(Composer.OPEN_WORKSTREAM_CONTROL_EVENT, {
          detail: { composerId: roots[1]?.dataset.ogComposerId },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(pauseButtons.item(1));
  });

  test("unmounting a pending danger confirmation cancels its promise", async () => {
    let confirmed: boolean | undefined;
    const danger: SlashCommand = {
      name: "danger",
      description: "Dangerous test action",
      danger: true,
      run: async (_args, context) => {
        confirmed = await context.confirm();
        return { status: "ok", keepDraft: true };
      },
    };
    function Harness() {
      const controller = Composer.useChatComposerController({
        delivery: delivery("/danger", () => {}),
        commands: [danger],
        commandContext,
      });
      return (
        <Composer.Root controller={controller}>
          <Composer.CommandPalette />
          <Composer.Input />
          <Composer.Confirmation />
        </Composer.Root>
      );
    }
    mounted = await renderComponent(<Harness />);
    await act(async () => {
      mounted?.container
        .querySelector("textarea")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    expect(mounted.container.querySelector('[role="alertdialog"]')).not.toBeNull();

    const current = mounted;
    mounted = null;
    await current.unmount();
    await Promise.resolve();
    expect(confirmed).toBe(false);
  });

  test("the preset accepts typed static and dynamic message overrides", async () => {
    mounted = await renderComponent(
      <ChatComposer
        composer={fullComposer()}
        messages={{
          inputLabel: "Task input",
          sendMessageAriaLabel: "Dispatch task",
          keyboardHint: "Custom keyboard help",
        }}
      />,
    );
    expect(mounted.container.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Task input",
    );
    expect(mounted.container.querySelector('[aria-label="Dispatch task"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("Custom keyboard help");

    await mounted.rerender(
      <ChatComposer
        composer={fullComposer()}
        attachments={attachments({
          attachments: [
            {
              id: "attachment-1",
              name: "notes.txt",
              contentType: "text/plain",
              sizeBytes: 12,
              status: "ready",
            },
          ],
        })}
        messages={{ removeAttachment: (name) => `Discard ${name}` }}
      />,
    );
    expect(mounted.container.querySelector('[aria-label="Discard notes.txt"]')).not.toBeNull();

    await mounted.rerender(
      <ChatComposer
        composer={fullComposer({ value: "/", canSend: true })}
        commandContext={commandContext}
        messages={{ slashCommandsLabel: "Operator commands" }}
      />,
    );
    expect(mounted.container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      "Operator commands",
    );
  });

  test("the compound composition is server-renderable with deterministic ownership markup", () => {
    const html = renderToString(<DeliveryOnlyComposer />);
    expect(html).toContain("data-og-composer-id");
    expect(html).toContain("data-custom-input");
    expect(html).toContain("Insert dictated text");
  });

  test("the server-rendered composition hydrates without recovering from a mismatch", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<DeliveryOnlyComposer />);
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];
    const root = hydrateRoot(container, <DeliveryOnlyComposer />, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
    try {
      await act(async () => await Promise.resolve());
      expect(recoverableErrors).toEqual([]);
      expect(container.querySelectorAll("textarea")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
