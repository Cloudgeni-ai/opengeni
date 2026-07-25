import { afterEach, describe, expect, test } from "bun:test";
import type {
  TranscriptionAdapter,
  TranscriptionAdapterStartContext,
  TranscriptionDiagnostic,
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
  type TranscriptionLifecycleTimeouts,
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
  autoDetectLanguage: false,
  diarization: { enabled: false, maxSpeakers: null },
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
  context: TranscriptionAdapterStartContext | null = null;
  cancels = 0;
  closes = 0;

  async start(
    request: TranscriptionSessionRequest,
    listener: TranscriptionEventListener,
    context: TranscriptionAdapterStartContext,
  ): Promise<TranscriptionSession> {
    this.request = request;
    this.listener = listener;
    this.context = context;
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function TestComposer({
  adapter,
  sends,
  acceptedPolicy = policy,
  lifecycleTimeouts,
  onDiagnostic,
}: {
  adapter: TranscriptionAdapter;
  sends: string[];
  acceptedPolicy?: WorkspaceTranscriptionPolicy;
  lifecycleTimeouts?: Partial<TranscriptionLifecycleTimeouts>;
  onDiagnostic?: (diagnostic: TranscriptionDiagnostic) => void;
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
  return (
    <ChatComposer
      composer={composer}
      transcription={{
        adapter,
        policy: acceptedPolicy,
        lifecycleTimeouts,
        onDiagnostic,
      }}
    />
  );
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
        metadata: {
          detectedLanguage: "en-US",
          span: { startMilliseconds: 0, endMilliseconds: 750 },
          confidence: 0.8,
          speaker: { id: "speaker-1", label: "Speaker 1" },
        },
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
        metadata: {
          detectedLanguage: "en-US",
          span: { startMilliseconds: 0, endMilliseconds: 900 },
          confidence: 0.94,
          speaker: { id: "speaker-1", label: "Speaker 1" },
          words: [
            {
              text: "accepted",
              span: { startMilliseconds: 0, endMilliseconds: 500 },
              confidence: 0.95,
              speaker: { id: "speaker-1" },
            },
            {
              text: "words",
              span: { startMilliseconds: 520, endMilliseconds: 900 },
              confidence: 0.93,
              speaker: { id: "speaker-1" },
            },
          ],
        },
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
        error: { code: "provider" as const, recoverable: false },
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

  test("does not consume an acceptance ID for an empty final", () => {
    const listening = {
      ...INITIAL_TRANSCRIPTION_CONTROL_STATE,
      status: "listening" as const,
      generation: 1,
      localSessionId: "local-1",
    };
    const empty = transitionTranscriptionControl(listening, {
      type: "event",
      generation: 1,
      event: event("local-1", 1, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "   \n",
        providerAcceptanceId: "correctable-1",
      }),
    });
    expect(empty.commit).toBeNull();
    expect(empty.state.acceptedFinalIds).toEqual([]);

    const corrected = transitionTranscriptionControl(empty.state, {
      type: "event",
      generation: 1,
      event: event("local-1", 2, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "corrected final",
        providerAcceptanceId: "correctable-1",
      }),
    });
    expect(corrected.commit).toBe("corrected final");
    expect(corrected.state.acceptedFinalIds).toEqual(["correctable-1"]);

    const replay = transitionTranscriptionControl(corrected.state, {
      type: "event",
      generation: 1,
      event: event("local-1", 3, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "corrected final",
        providerAcceptanceId: "correctable-1",
      }),
    });
    expect(replay.commit).toBeNull();
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
        metadata: {
          detectedLanguage: "en-US",
          span: { startMilliseconds: 0, endMilliseconds: 500 },
          confidence: 0.75,
          speaker: { id: "speaker-1" },
        },
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
        metadata: {
          detectedLanguage: "en-US",
          span: { startMilliseconds: 0, endMilliseconds: 800 },
          confidence: 0.96,
          speaker: { id: "speaker-1" },
          words: [
            {
              text: "final transcript",
              span: { startMilliseconds: 0, endMilliseconds: 800 },
              confidence: 0.96,
              speaker: { id: "speaker-1" },
            },
          ],
        },
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

  test("accepts a same-ID correction after an empty final and deduplicates its replay", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    const textarea = mounted.container.querySelector<HTMLTextAreaElement>("textarea")!;

    await act(async () => {
      adapter.emit(3, {
        type: "transcript.final",
        segmentId: "correctable",
        text: " \n ",
        providerAcceptanceId: "same-id",
      });
      adapter.emit(4, {
        type: "transcript.final",
        segmentId: "correctable",
        text: "corrected once",
        providerAcceptanceId: "same-id",
      });
      adapter.emit(5, {
        type: "transcript.final",
        segmentId: "replayed",
        text: "corrected once",
        providerAcceptanceId: "same-id",
      });
    });

    expect(textarea.value).toBe("Existing draft corrected once");
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
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        listener(
          event(request.localSessionId, 2, {
            type: "session.error",
            code: "permission_denied",
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
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Microphone permission was denied. Your draft was not changed.",
    );
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
        recoverable: false,
      });
      await Promise.resolve();
    });

    expect(adapter.cancels).toBe(0);
    expect(adapter.closes).toBe(1);
    expect(
      mounted.container.querySelector('button[aria-label="Retry voice input"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The transcription service could not continue.",
    );

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

  test("aborts a pending start and cleans a handle that resolves after cancellation", async () => {
    const started = deferred<void>();
    const startResult = deferred<TranscriptionSession>();
    const cancelInvoked = deferred<void>();
    const closeInvoked = deferred<void>();
    class PendingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        started.resolve();
        return await startResult.promise;
      }
    }

    const adapter = new PendingAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await started.promise;
    });
    expect(adapter.context?.signal.aborted).toBe(false);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(adapter.context?.signal.aborted).toBe(true);
    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(mounted.container.querySelector("textarea"));

    await act(async () => {
      startResult.resolve({
        localSessionId: adapter.request!.localSessionId,
        cancel: async () => {
          adapter.cancels += 1;
          cancelInvoked.resolve();
        },
        close: async () => {
          adapter.closes += 1;
          closeInvoked.resolve();
        },
      });
      await Promise.all([cancelInvoked.promise, closeInvoked.promise]);
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

  test("aborts a hanging start at a bounded timeout and exposes controlled retry copy", async () => {
    const started = deferred<void>();
    const timedOut = deferred<void>();
    const diagnostics: TranscriptionDiagnostic[] = [];
    class HangingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        started.resolve();
        return await new Promise<TranscriptionSession>(() => {});
      }
    }

    const adapter = new HangingAdapter();
    mounted = await renderComponent(
      <TestComposer
        adapter={adapter}
        sends={[]}
        lifecycleTimeouts={{ startMs: 20, cleanupMs: 10 }}
        onDiagnostic={(diagnostic) => {
          diagnostics.push(diagnostic);
          if (diagnostic.operation === "start" && diagnostic.code === "timeout") {
            timedOut.resolve();
          }
        }}
      />,
    );
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await started.promise;
      await timedOut.promise;
      await Promise.resolve();
    });

    expect(adapter.context?.signal.aborted).toBe(true);
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Voice input took too long to start. Try again.",
    );
    expect(
      mounted.container.querySelector('button[aria-label="Retry voice input"]'),
    ).not.toBeNull();
    expect(diagnostics).toEqual([
      {
        operation: "start",
        code: "timeout",
        detail: "Transcription adapter start exceeded 20ms.",
      },
    ]);
  });

  test("aborts a pending start on policy replacement and cleans its late handle", async () => {
    const started = deferred<void>();
    const startResult = deferred<TranscriptionSession>();
    const cancelInvoked = deferred<void>();
    const closeInvoked = deferred<void>();
    class PendingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        started.resolve();
        return await startResult.promise;
      }
    }

    const adapter = new PendingAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await started.promise;
    });
    const revisedPolicy: WorkspaceTranscriptionPolicy = {
      ...policy,
      acceptanceId: "44444444-4444-4444-8444-444444444444",
      diarization: { enabled: true, maxSpeakers: 4 },
    };
    await mounted.rerender(
      <TestComposer adapter={adapter} sends={[]} acceptedPolicy={revisedPolicy} />,
    );

    expect(adapter.context?.signal.aborted).toBe(true);
    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(mounted.container.querySelector("textarea"));

    startResult.resolve({
      localSessionId: adapter.request!.localSessionId,
      cancel: async () => {
        adapter.cancels += 1;
        cancelInvoked.resolve();
      },
      close: async () => {
        adapter.closes += 1;
        closeInvoked.resolve();
      },
    });
    await Promise.all([cancelInvoked.promise, closeInvoked.promise]);
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);
  });

  test("aborts a pending start on unmount and synchronizes on real late cleanup", async () => {
    const started = deferred<void>();
    const startResult = deferred<TranscriptionSession>();
    const cleanupInvoked = deferred<void>();
    const closeInvoked = deferred<void>();
    class PendingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        started.resolve();
        return await startResult.promise;
      }
    }

    const adapter = new PendingAdapter();
    mounted = await renderComponent(<TestComposer adapter={adapter} sends={[]} />);
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await started.promise;
    });
    const current = mounted;
    mounted = null;
    await current.unmount();
    expect(adapter.context?.signal.aborted).toBe(true);

    startResult.resolve({
      localSessionId: adapter.request!.localSessionId,
      cancel: async () => {
        adapter.cancels += 1;
        cleanupInvoked.resolve();
      },
      close: async () => {
        adapter.closes += 1;
        closeInvoked.resolve();
      },
    });
    await Promise.all([cleanupInvoked.promise, closeInvoked.promise]);
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);
  });

  test("consumes a late secret-bearing rejection after cancellation without reviving UI", async () => {
    const started = deferred<void>();
    const startResult = deferred<TranscriptionSession>();
    const lateDiagnostic = deferred<void>();
    const diagnostics: TranscriptionDiagnostic[] = [];
    class PendingAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        started.resolve();
        return await startResult.promise;
      }
    }

    const adapter = new PendingAdapter();
    mounted = await renderComponent(
      <TestComposer
        adapter={adapter}
        sends={[]}
        onDiagnostic={(diagnostic) => {
          diagnostics.push(diagnostic);
          lateDiagnostic.resolve();
        }}
      />,
    );
    await act(async () => {
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click();
      await started.promise;
    });
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    startResult.reject(
      new Error("late provider rejection api-key=topsecret Bearer opaque-token sk-fixture123"),
    );
    await lateDiagnostic.promise;
    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();
    expect(mounted.container.querySelector("textarea")?.value).toBe("Existing draft");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.detail).not.toContain("topsecret");
    expect(diagnostics[0]?.detail).not.toContain("opaque-token");
    expect(diagnostics[0]?.detail).not.toContain("sk-fixture123");
    expect(diagnostics[0]?.detail.length).toBeLessThanOrEqual(512);
  });

  test("restores idle focus while independently bounding hanging cancel and close", async () => {
    const diagnostics: TranscriptionDiagnostic[] = [];
    const cleanupTimedOut = deferred<void>();
    class HangingCleanupAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        listener(event(request.localSessionId, 1, { type: "permission.requested" }));
        listener(
          event(request.localSessionId, 2, {
            type: "session.opened",
            providerSessionId: "provider-session-hanging-cleanup",
          }),
        );
        return {
          localSessionId: request.localSessionId,
          cancel: async () => {
            this.cancels += 1;
            return await new Promise<void>(() => {});
          },
          close: async () => {
            this.closes += 1;
            return await new Promise<void>(() => {});
          },
        };
      }
    }

    const adapter = new HangingCleanupAdapter();
    mounted = await renderComponent(
      <TestComposer
        adapter={adapter}
        sends={[]}
        lifecycleTimeouts={{ cleanupMs: 15 }}
        onDiagnostic={(diagnostic) => {
          diagnostics.push(diagnostic);
          if (diagnostics.length === 2) cleanupTimedOut.resolve();
        }}
      />,
    );
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    await act(async () => {
      adapter.emit(3, {
        type: "session.reconnecting",
        attempt: 1,
        reason: "fixture interruption",
      });
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(
      mounted.container.querySelector('button[aria-label="Start voice input"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(mounted.container.querySelector("textarea"));
    expect(adapter.cancels).toBe(1);
    expect(adapter.closes).toBe(1);
    await cleanupTimedOut.promise;
    expect(diagnostics.map(({ operation, code }) => ({ operation, code }))).toEqual([
      { operation: "cancel", code: "timeout" },
      { operation: "close", code: "timeout" },
    ]);
  });

  test("renders only controlled copy for a secret-bearing thrown start failure", async () => {
    const diagnostics: TranscriptionDiagnostic[] = [];
    const rawDetail =
      "FixtureProvider exploded api-key=topsecret Bearer opaque-token sk-fixture123";
    class SecretStartAdapter extends FixtureAdapter {
      override async start(
        request: TranscriptionSessionRequest,
        listener: TranscriptionEventListener,
        context: TranscriptionAdapterStartContext,
      ): Promise<TranscriptionSession> {
        this.request = request;
        this.listener = listener;
        this.context = context;
        context.reportDiagnostic({ operation: "start", code: "provider", detail: rawDetail });
        throw new Error(rawDetail);
      }
    }

    const adapter = new SecretStartAdapter();
    mounted = await renderComponent(
      <TestComposer
        adapter={adapter}
        sends={[]}
        onDiagnostic={(diagnostic) => diagnostics.push(diagnostic)}
      />,
    );
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Voice input could not start. Try again.",
    );
    expect(mounted.container.textContent).not.toContain("FixtureProvider");
    expect(mounted.container.textContent).not.toContain("topsecret");
    expect(mounted.container.textContent).not.toContain("opaque-token");
    expect(mounted.container.textContent).not.toContain("sk-fixture123");
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.detail).not.toContain("topsecret");
      expect(diagnostic.detail).not.toContain("opaque-token");
      expect(diagnostic.detail).not.toContain("sk-fixture123");
      expect(diagnostic.detail.length).toBeLessThanOrEqual(512);
    }
  });

  test("ignores event-injected display text and forwards only redacted diagnostics", async () => {
    const diagnostics: TranscriptionDiagnostic[] = [];
    const rawDetail = "Provider raw detail secret=topsecret Bearer opaque-token";
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(
      <TestComposer
        adapter={adapter}
        sends={[]}
        onDiagnostic={(diagnostic) => diagnostics.push(diagnostic)}
      />,
    );
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    await act(async () => {
      adapter.context?.reportDiagnostic({
        operation: "session",
        code: "provider",
        detail: rawDetail,
      });
      adapter.listener?.({
        ...event(adapter.request!.localSessionId, 3, {
          type: "session.error",
          code: "provider",
          recoverable: false,
        }),
        message: rawDetail,
      } as unknown as TranscriptionEvent);
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The transcription service could not continue.",
    );
    expect(mounted.container.textContent).not.toContain("Provider raw detail");
    expect(mounted.container.textContent).not.toContain("topsecret");
    expect(mounted.container.textContent).not.toContain("opaque-token");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.detail).not.toContain("topsecret");
    expect(diagnostics[0]?.detail).not.toContain("opaque-token");
  });

  test("changing the diagnostic callback does not run unmount cleanup", async () => {
    const adapter = new FixtureAdapter();
    mounted = await renderComponent(
      <TestComposer adapter={adapter} sends={[]} onDiagnostic={() => {}} />,
    );
    await act(async () =>
      mounted?.container
        .querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]')
        ?.click(),
    );
    await mounted.rerender(<TestComposer adapter={adapter} sends={[]} onDiagnostic={() => {}} />);

    expect(adapter.context?.signal.aborted).toBe(false);
    expect(adapter.cancels).toBe(0);
    expect(adapter.closes).toBe(0);
    expect(
      mounted.container.querySelector('[data-transcription-status="listening"]'),
    ).not.toBeNull();
  });
});
