import { afterEach, describe, expect, test } from "bun:test";
import type {
  TranscriptionAdapter,
  TranscriptionEvent,
  TranscriptionEventListener,
  TranscriptionSession,
  TranscriptionSessionRequest,
  WorkspaceTranscriptionPolicy,
} from "@opengeni/sdk";
import { act, useState } from "react";
import { ChatComposer } from "../src/components/chat-composer";
import {
  INITIAL_TRANSCRIPTION_CONTROL_STATE,
  appendFinalTranscript,
  transitionTranscriptionControl,
} from "../src/hooks/use-transcription";
import type { ComposerState } from "../src/hooks/use-composer";
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

const policy: WorkspaceTranscriptionPolicy = {
  enabled: true,
  acceptanceId: "11111111-1111-4111-8111-111111111111",
  primary: {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "managed",
    credentialConnectionId: null,
    region: null,
  },
  language: "en-US",
  retention: { mode: "none", maxDays: null },
  privacy: { allowProviderLogging: false, allowProviderTraining: false },
  fallback: { mode: "disabled", targets: [] },
  cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
};

class FixtureAdapter implements TranscriptionAdapter {
  readonly descriptor = {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "managed" as const,
    region: null,
  };
  listener: TranscriptionEventListener | null = null;
  request: TranscriptionSessionRequest | null = null;
  cancels = 0;
  closes = 0;

  async start(
    request: TranscriptionSessionRequest,
    listener: TranscriptionEventListener,
  ): Promise<TranscriptionSession> {
    this.request = request;
    this.listener = listener;
    listener(event(request.localSessionId, 1, { type: "permission.requested" }));
    listener(
      event(request.localSessionId, 2, {
        type: "session.opened",
        providerSessionId: "provider-session-1",
      }),
    );
    return {
      localSessionId: request.localSessionId,
      cancel: async () => {
        this.cancels += 1;
      },
      close: async () => {
        this.closes += 1;
      },
    };
  }

  emit(sequence: number, payload: EventPayload): void {
    if (!this.listener || !this.request) throw new Error("fixture adapter has not started");
    this.listener(event(this.request.localSessionId, sequence, payload));
  }
}

type EventPayload = TranscriptionEvent extends infer Event
  ? Event extends TranscriptionEvent
    ? Omit<Event, "localSessionId" | "sequence" | "occurredAt">
    : never
  : never;

function event(
  localSessionId: string,
  sequence: number,
  payload: EventPayload,
): TranscriptionEvent {
  return {
    localSessionId,
    sequence,
    occurredAt: "2026-07-21T12:00:00.000Z",
    ...payload,
  } as TranscriptionEvent;
}

function TestComposer({
  adapter,
  sends,
  acceptedPolicy = policy,
}: {
  adapter: TranscriptionAdapter;
  sends: string[];
  acceptedPolicy?: WorkspaceTranscriptionPolicy;
}) {
  const [value, setValue] = useState("Existing draft");
  const composer: ComposerState = {
    value,
    setValue,
    send: async () => {
      sends.push(value);
      return true;
    },
    steer: async () => true,
    sending: false,
    canSend: value.trim().length > 0,
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
    error: null,
    clearError: () => {},
  };
  return <ChatComposer composer={composer} transcription={{ adapter, policy: acceptedPolicy }} />;
}

describe("transcription lifecycle reducer", () => {
  test("fences stale sequences/generations and accepts each final exactly once", () => {
    const started = transitionTranscriptionControl(INITIAL_TRANSCRIPTION_CONTROL_STATE, {
      type: "start",
      generation: 1,
      localSessionId: "local-1",
    }).state;
    const opened = transitionTranscriptionControl(started, {
      type: "event",
      generation: 1,
      event: event("local-1", 1, {
        type: "session.opened",
        providerSessionId: "provider-1",
      }),
    }).state;
    const partial = transitionTranscriptionControl(opened, {
      type: "event",
      generation: 1,
      event: event("local-1", 2, {
        type: "transcript.partial",
        segmentId: "segment-1",
        text: "ephemeral words",
      }),
    }).state;
    expect(partial.partial).toBe("ephemeral words");

    const final = transitionTranscriptionControl(partial, {
      type: "event",
      generation: 1,
      event: event("local-1", 3, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "accepted words",
        providerAcceptanceId: "accepted-1",
      }),
    });
    expect(final.commit).toBe("accepted words");
    expect(final.state.partial).toBe("");

    const replay = transitionTranscriptionControl(final.state, {
      type: "event",
      generation: 1,
      event: event("local-1", 4, {
        type: "transcript.final",
        segmentId: "segment-1-replay",
        text: "accepted words",
        providerAcceptanceId: "accepted-1",
      }),
    });
    expect(replay.commit).toBeNull();
    expect(
      transitionTranscriptionControl(replay.state, {
        type: "event",
        generation: 1,
        event: event("local-1", 2, {
          type: "transcript.partial",
          segmentId: "stale",
          text: "must not return",
        }),
      }).state,
    ).toBe(replay.state);
    expect(
      transitionTranscriptionControl(replay.state, {
        type: "event",
        generation: 0,
        event: event("local-1", 5, {
          type: "transcript.partial",
          segmentId: "old-generation",
          text: "must not return",
        }),
      }).state,
    ).toBe(replay.state);
  });

  test("clears ephemeral text at reconnect, cancellation, failure, and close", () => {
    const listening = {
      ...INITIAL_TRANSCRIPTION_CONTROL_STATE,
      status: "listening" as const,
      generation: 1,
      localSessionId: "local-1",
      partial: "do not commit",
    };
    const reconnecting = transitionTranscriptionControl(listening, {
      type: "event",
      generation: 1,
      event: event("local-1", 1, {
        type: "session.reconnecting",
        attempt: 1,
        reason: "fixture network interruption",
      }),
    }).state;
    expect(reconnecting).toMatchObject({ status: "reconnecting", partial: "" });
    const cancelling = transitionTranscriptionControl(
      { ...reconnecting, partial: "still ephemeral" },
      { type: "cancel", generation: 1 },
    ).state;
    expect(cancelling).toMatchObject({ status: "cancelling", partial: "" });
    const lateFinal = transitionTranscriptionControl(cancelling, {
      type: "event",
      generation: 1,
      event: event("local-1", 2, {
        type: "transcript.final",
        segmentId: "late",
        text: "must never enter the draft",
        providerAcceptanceId: "late-acceptance",
      }),
    });
    expect(lateFinal.commit).toBeNull();
    expect(lateFinal.state.status).toBe("cancelling");
    expect(
      transitionTranscriptionControl(lateFinal.state, {
        type: "cancel.settled",
        generation: 1,
      }).state.status,
    ).toBe("closed");
  });

  test("terminal close and error states fence every late callback", () => {
    const terminalStates = [
      {
        ...INITIAL_TRANSCRIPTION_CONTROL_STATE,
        status: "closed" as const,
        generation: 1,
        localSessionId: "local-1",
      },
      {
        ...INITIAL_TRANSCRIPTION_CONTROL_STATE,
        status: "error" as const,
        generation: 1,
        localSessionId: "local-1",
        error: { code: "provider" as const, message: "terminal", recoverable: false },
      },
    ];

    for (const terminal of terminalStates) {
      const lateFinal = transitionTranscriptionControl(terminal, {
        type: "event",
        generation: 1,
        event: event("local-1", 1, {
          type: "transcript.final",
          segmentId: "late",
          text: "must never enter the draft",
          providerAcceptanceId: "late-acceptance",
        }),
      });
      expect(lateFinal).toEqual({ state: terminal, commit: null });
      expect(
        transitionTranscriptionControl(terminal, {
          type: "start.failed",
          generation: 1,
          code: "unknown",
          message: "late start rejection",
        }).state,
      ).toBe(terminal);
    }
  });

  test("appends final text without replacing an editable draft", () => {
    expect(appendFinalTranscript("", "  hello world  ")).toBe("hello world");
    expect(appendFinalTranscript("Existing draft", "hello world")).toBe(
      "Existing draft hello world",
    );
    expect(appendFinalTranscript("Existing draft\n", "hello world")).toBe(
      "Existing draft\nhello world",
    );
  });
});

describe("composer transcription control", () => {
  test("keeps partials ephemeral, inserts one editable final, and uses ordinary Send", async () => {
    const adapter = new FixtureAdapter();
    const sends: string[] = [];
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={sends} />);
    const start = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start voice input"]',
    );
    expect(start).not.toBeNull();
    await act(async () => start?.click());
    expect(adapter.request?.policyAcceptanceId).toBe(policy.acceptanceId!);
    expect(
      mounted.container.querySelector('[data-transcription-status="listening"]'),
    ).not.toBeNull();

    await act(async () =>
      adapter.emit(3, {
        type: "transcript.partial",
        segmentId: "segment-1",
        text: "draft partial",
      }),
    );
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Existing draft");
    expect(mounted.container.textContent).toContain("draft partial");

    await act(async () =>
      adapter.emit(4, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "final transcript",
        providerAcceptanceId: "accepted-final-1",
      }),
    );
    expect(textarea.value).toBe("Existing draft final transcript");
    expect(document.activeElement).toBe(textarea);

    await act(async () =>
      adapter.emit(5, {
        type: "transcript.final",
        segmentId: "segment-1-replay",
        text: "final transcript",
        providerAcceptanceId: "accepted-final-1",
      }),
    );
    expect(textarea.value).toBe("Existing draft final transcript");

    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
        ?.click(),
    );
    expect(sends).toEqual(["Existing draft final transcript"]);
  });

  test("Escape cancels, clears partials, closes the adapter, and returns input focus", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    await act(async () =>
      adapter.emit(3, {
        type: "transcript.partial",
        segmentId: "segment-1",
        text: "never commit this",
      }),
    );
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);
    expect(mounted.container.textContent).not.toContain("never commit this");
    expect(mounted.container.querySelector("textarea")?.value).toBe("Existing draft");
    expect(document.activeElement).toBe(mounted.container.querySelector("textarea"));
  });

  test("renders one policy-directed mic without exposing provider configuration", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    expect(
      mounted.container.querySelectorAll('button[aria-label="Start voice input"]'),
    ).toHaveLength(1);
    expect(mounted.container.textContent).not.toContain("fixture-speech");
    expect(mounted.container.textContent).not.toContain("fixture-v1");
    expect(mounted.container.querySelector("select")).toBeNull();
  });

  test("closes a synchronously denied session handle instead of retaining it", async () => {
    class DeniedAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        listener(
          event(request.localSessionId, 2, {
            type: "session.error",
            code: "permission_denied",
            message: "Permission denied without changing the draft.",
            recoverable: false,
          }),
        );
        return {
          localSessionId: request.localSessionId,
          cancel: async () => {
            this.cancels += 1;
          },
          close: async () => {
            this.closes += 1;
          },
        };
      }
    }

    const adapter = new DeniedAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    expect(adapter.cancels).toBe(0);
    expect(adapter.closes).toBe(1);
    expect(
      mounted.container.querySelector('button[aria-label="Retry voice input"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector("textarea")?.value).toBe("Existing draft");
  });

  test("releases a stored session after an asynchronous terminal error", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );

    await act(async () => {
      adapter.emit(3, {
        type: "session.error",
        code: "provider",
        message: "Provider ended the fixture session.",
        recoverable: false,
      });
      await Promise.resolve();
    });

    expect(adapter.cancels).toBe(0);
    expect(adapter.closes).toBe(1);
    expect(
      mounted.container.querySelector('button[aria-label="Retry voice input"]'),
    ).not.toBeNull();

    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Retry voice input"]')
        ?.click(),
    );
    expect(
      mounted.container.querySelector('[data-transcription-status="listening"]'),
    ).not.toBeNull();
  });

  test("revokes an active session when its accepted workspace policy changes", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );

    const revisedPolicy: WorkspaceTranscriptionPolicy = {
      ...policy,
      acceptanceId: "33333333-3333-4333-8333-333333333333",
      privacy: { ...policy.privacy, allowProviderLogging: true },
    };
    await mounted.rerender(
      <TestComposer adapter={adapter} sends={[]} acceptedPolicy={revisedPolicy} />,
    );
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);
    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();

    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    expect(adapter.request?.policyAcceptanceId).toBe(revisedPolicy.acceptanceId!);
  });

  test("cancels a session handle that resolves after local cancellation", async () => {
    let resolveStart!: (session: TranscriptionSession) => void;
    class PendingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        return await new Promise<TranscriptionSession>((resolve) => {
          resolveStart = resolve;
        });
      }
    }

    const adapter = new PendingAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveStart({
        localSessionId: adapter.request!.localSessionId,
        cancel: async () => {
          adapter.cancels += 1;
        },
        close: async () => {
          adapter.closes += 1;
        },
      });
      await Promise.resolve();
    });
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);

    await act(async () =>
      adapter.emit(2, {
        type: "transcript.final",
        segmentId: "late",
        text: "must never enter the draft",
        providerAcceptanceId: "late-final",
      }),
    );
    expect(mounted.container.querySelector("textarea")?.value).toBe("Existing draft");
    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();
  });
});
