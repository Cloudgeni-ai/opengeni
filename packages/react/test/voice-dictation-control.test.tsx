import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";

import { VoiceDictationControl } from "../src/components/voice-dictation-control";
import { appendFinalTranscript, useTranscription } from "../src/hooks/use-transcription";
import type {
  TranscriptionEvent,
  TranscriptionEventSink,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionRequest,
} from "../src/transcription/types";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

type EventWithoutSession = TranscriptionEvent extends infer Event
  ? Event extends TranscriptionEvent
    ? Omit<Event, "sessionId" | "providerId">
    : never
  : never;

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

class FakeProvider implements TranscriptionProvider {
  readonly id = "fake";
  starts = 0;
  cancels = 0;
  closes = 0;
  requests: TranscriptionSessionRequest[] = [];
  emitters: TranscriptionEventSink[] = [];
  startBehavior: (sessionIndex: number) => Promise<void> = async () => {};

  createSession(
    request: TranscriptionSessionRequest,
    emit: TranscriptionEventSink,
  ): TranscriptionSession {
    const index = this.requests.length;
    this.requests.push(request);
    this.emitters.push(emit);
    return {
      id: request.sessionId,
      providerId: this.id,
      start: async () => {
        this.starts += 1;
        await this.startBehavior(index);
      },
      cancel: async () => {
        this.cancels += 1;
      },
      close: async () => {
        this.closes += 1;
      },
    };
  }

  emit(index: number, event: EventWithoutSession): void {
    const request = this.requests[index];
    if (!request) throw new Error(`missing fake session ${index}`);
    this.emitters[index]?.({
      ...event,
      sessionId: request.sessionId,
      providerId: this.id,
    } as TranscriptionEvent);
  }
}

function button(): HTMLButtonElement {
  const found = mounted?.container.querySelector<HTMLButtonElement>("button");
  if (!found) throw new Error("dictation button not found");
  return found;
}

describe("appendFinalTranscript", () => {
  test("preserves the draft and inserts exactly one separator", () => {
    expect(appendFinalTranscript("", "  hello  ")).toBe("hello");
    expect(appendFinalTranscript("existing", " next ")).toBe("existing next");
    expect(appendFinalTranscript("existing\n", "next")).toBe("existing\nnext");
    expect(appendFinalTranscript("existing ", "   ")).toBe("existing ");
  });
});

describe("useTranscription", () => {
  test("preserves a terminal provider event emitted during startup", async () => {
    const provider = new FakeProvider();
    provider.startBehavior = async (index) => {
      provider.emit(index, {
        type: "error",
        sequence: 1,
        code: "provider_rejected",
        message: "Voice dictation was rejected by policy.",
        retryable: false,
      });
      throw new Error("less specific startup failure");
    };
    const observed: {
      start: (() => Promise<boolean>) | null;
      errorMessage: string | null;
    } = { start: null, errorMessage: null };
    function HookHarness() {
      const result = useTranscription({
        provider,
        value: "",
        setValue: () => {},
        sessionIdFactory: () => "dictation-1",
      });
      observed.start = result.start;
      observed.errorMessage = result.state.error?.message ?? null;
      return null;
    }
    mounted = await renderComponent(<HookHarness />);

    let started = true;
    await act(async () => {
      started = await observed.start!();
    });
    await flush();

    expect(started).toBe(false);
    expect(observed.errorMessage).toBe("Voice dictation was rejected by policy.");
    expect(provider.closes).toBe(1);
  });
});

describe("VoiceDictationControl", () => {
  test("inserts accepted finals exactly once and never submits the composer", async () => {
    const provider = new FakeProvider();
    const values: string[] = [];
    function ControlledComposer() {
      const [value, setValue] = useState("Existing draft");
      return (
        <VoiceDictationControl
          provider={provider}
          value={value}
          setValue={(next) => {
            values.push(next);
            setValue(next);
          }}
          sessionIdFactory={() => "dictation-1"}
        />
      );
    }
    mounted = await renderComponent(<ControlledComposer />);

    await act(async () => button().click());
    await act(async () => {
      provider.emit(0, { type: "session.ready", sequence: 1 });
      provider.emit(0, {
        type: "transcript.partial",
        sequence: 2,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "first fin",
      });
    });
    await flush();
    expect(mounted.container.textContent).toContain("first fin");
    expect(button().getAttribute("aria-pressed")).toBe("true");

    const firstFinal = {
      type: "transcript.final" as const,
      sequence: 3,
      attempt: 0,
      segmentId: "item-1",
      logicalSegmentId: "logical-1",
      providerAcceptanceId: "accepted-1",
      providerEventId: "completed-1",
      text: "first final",
    };
    await act(async () => {
      provider.emit(0, firstFinal);
      provider.emit(0, { ...firstFinal, sequence: 4, providerEventId: "completed-1-replay" });
      provider.emit(0, {
        type: "transcript.final",
        sequence: 5,
        attempt: 0,
        segmentId: "item-2",
        logicalSegmentId: "logical-2",
        providerAcceptanceId: "accepted-2",
        text: "second",
      });
    });
    await flush();
    // Both accepted finals were dispatched in one React batch. Neither may be
    // overwritten by the reducer's latest-commit projection.
    expect(values).toEqual(["Existing draft first final", "Existing draft first final second"]);
  });

  test("shows requesting/listening truth and Escape cancels without inserting a partial", async () => {
    const provider = new FakeProvider();
    let resolveStart!: () => void;
    provider.startBehavior = () =>
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
    const values: string[] = [];
    mounted = await renderComponent(
      <div className="og-root">
        <textarea aria-label="Composer" />
        <VoiceDictationControl
          provider={provider}
          value="Keep this"
          setValue={(value) => values.push(value)}
          sessionIdFactory={() => "dictation-1"}
        />
      </div>,
    );

    await act(async () => button().click());
    expect(button().getAttribute("aria-label")).toBe("Cancel voice dictation");
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      provider.emit(0, { type: "session.ready", sequence: 1 });
      provider.emit(0, {
        type: "transcript.partial",
        sequence: 2,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "discard this",
      });
    });
    resolveStart();
    await flush();
    expect(button().getAttribute("aria-label")).toBe("Stop voice dictation");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(provider.cancels).toBe(1);
    expect(values).toEqual([]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Composer");
    expect(mounted.container.textContent).toContain("Dictation cancelled");
  });

  test("renders permission denial as an actionable alert and retries", async () => {
    const provider = new FakeProvider();
    provider.startBehavior = async (index) => {
      if (index === 0) {
        const error = new Error("blocked");
        error.name = "NotAllowedError";
        throw error;
      }
      provider.emit(index, { type: "session.ready", sequence: 1 });
    };
    mounted = await renderComponent(
      <VoiceDictationControl
        provider={provider}
        value=""
        setValue={() => {}}
        sessionIdFactory={() => `dictation-${provider.requests.length + 1}`}
      />,
    );

    await act(async () => button().click());
    await flush();
    expect(button().getAttribute("aria-label")).toBe("Retry voice dictation");
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Microphone permission was denied",
    );

    await act(async () => button().click());
    await flush();
    expect(provider.starts).toBe(2);
    expect(button().getAttribute("aria-label")).toBe("Stop voice dictation");
  });

  test("is a real disabled button when no provider is configured", async () => {
    mounted = await renderComponent(
      <VoiceDictationControl provider={null} value="" setValue={() => {}} />,
    );

    expect(button().tagName).toBe("BUTTON");
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Voice dictation unavailable");
    expect(button().className).toContain("pointer-coarse:size-11");
  });
});
