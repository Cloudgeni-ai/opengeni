import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  OpenGeniClient,
  OpenGeniApiError,
  browserFrameSocketUrl,
  computerFrameSocketUrl,
  decodeBrowserFrameMessage,
  decodeComputerFrameMessage,
  type BrowserActionRequest,
  type BrowserFrame,
  type BrowserSessionAttachment,
  type ComputerFrame,
  type ComputerSessionAttachment,
  type InteractionPlacement,
  type InteractionSemanticNode,
} from "@opengeni/sdk";
import {
  decodeStreamFrame,
  decodeStreamOpenAck,
  encodeStreamClose,
  encodeStreamOpen,
  STREAM_CLOSE_REASON_NORMAL,
  STREAM_KIND_BROWSER,
  STREAM_KIND_COMPUTER,
  STREAM_ROLE_CLIENT,
} from "../packages/react/src/lib/relay-wire";
import {
  interactionLatencyBudgetsForTransport,
  type InteractionLatencyBudget,
  type InteractionLatencyMetric,
} from "./interaction-acceptance-contract";
import { RfbAcceptanceProbe, type RfbUpdate } from "./rfb-acceptance-probe";

const RELAY_TAG_OPEN = 1;
const RELAY_TAG_OPEN_ACK = 2;
const RELAY_TAG_FRAME = 3;
const RELAY_TAG_CLOSE = 4;
const DEFAULT_TIMEOUT_MS = 20_000;

type Args = {
  apiUrl: string;
  workspaceId: string | null;
  sessionId: string;
  iterations: number;
  output: string;
  includeComputer: boolean;
};

type Measurement = {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
};

type Receipt = {
  schemaVersion: "opengeni/interaction-live-acceptance/v1";
  generatedAt: string;
  apiUrl: string;
  workspaceId: string;
  sessionId: string;
  browserSessionId: string;
  computerSessionId: string | null;
  placement: InteractionPlacement;
  transport: {
    browser: BrowserSessionAttachment["stream"]["kind"];
    computer: ComputerSessionAttachment["stream"]["kind"] | null;
  };
  measurements: Partial<Record<InteractionLatencyMetric, Measurement>>;
  checks: string[];
  budgets: Readonly<Record<InteractionLatencyMetric, InteractionLatencyBudget>>;
};

type FrameValue = BrowserFrame | ComputerFrame;
type ComputerVisualFrame = ComputerFrame | RfbUpdate;
type ComputerVisualProbe = {
  first(timeoutMs?: number, label?: string): Promise<ComputerVisualFrame>;
  nextChangedAfter(
    previous: ComputerVisualFrame,
    timeoutMs?: number,
    label?: string,
  ): Promise<ComputerVisualFrame>;
  typeAscii?(value: string): void;
  close(): void;
};

class FrameProbe<TFrame extends FrameValue> {
  private readonly queue: TFrame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: TFrame) => boolean;
    resolve: (frame: TFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private processing = Promise.resolve();
  private closed = false;
  private failure: Error | null = null;
  private messagesReceived = 0;
  private framesDecoded = 0;

  private constructor(
    private readonly socket: WebSocket,
    private readonly relayChannelId: string | null,
    private readonly streamLabel: "browser" | "computer",
    private readonly decode: (bytes: Uint8Array) => TFrame | Promise<TFrame>,
  ) {
    socket.addEventListener("error", () => {
      if (!this.closed) this.fail(new Error("frame WebSocket failed"));
    });
    socket.addEventListener("close", (event) => {
      if (!this.closed) {
        this.fail(
          new Error(
            `frame WebSocket closed unexpectedly (code ${event.code}, reason ${JSON.stringify(event.reason)})`,
          ),
        );
      }
    });
  }

  static async browser(
    attachment: BrowserSessionAttachment,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<FrameProbe<BrowserFrame>> {
    const stream = attachment.stream;
    const socket = new WebSocket(
      stream.kind === "direct_websocket" ? browserFrameSocketUrl(attachment) : stream.url,
      stream.kind === "direct_websocket" ? [...stream.protocols] : [],
    );
    socket.binaryType = "arraybuffer";
    const probe = new FrameProbe(
      socket,
      stream.kind === "relay" ? stream.channel.channelId : null,
      "browser",
      decodeBrowserFrameMessage,
    );
    await probe.open(
      stream.kind === "relay"
        ? {
            channel: { ...stream.channel, kind: STREAM_KIND_BROWSER },
            token: stream.token,
          }
        : null,
      timeoutMs,
    );
    return probe;
  }

  static async computer(
    attachment: ComputerSessionAttachment,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<FrameProbe<ComputerFrame>> {
    const stream = attachment.stream;
    if (stream.kind === "direct_rfb") {
      throw new Error("Computer acceptance requires the encoded frame stream, not direct RFB");
    }
    const socket = new WebSocket(
      stream.kind === "direct_websocket" ? computerFrameSocketUrl(attachment) : stream.url,
      stream.kind === "direct_websocket" ? [...stream.protocols] : [],
    );
    socket.binaryType = "arraybuffer";
    const probe = new FrameProbe(
      socket,
      stream.kind === "relay" ? stream.channel.channelId : null,
      "computer",
      decodeComputerFrameMessage,
    );
    await probe.open(
      stream.kind === "relay"
        ? {
            channel: { ...stream.channel, kind: STREAM_KIND_COMPUTER },
            token: stream.token,
          }
        : null,
      timeoutMs,
    );
    return probe;
  }

  async nextChangedAfter(
    previous: TFrame,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = "frame change",
  ): Promise<TFrame> {
    return await this.waitFor(
      (frame) => frame.sequence > previous.sequence && !sameFrameImage(frame, previous),
      timeoutMs,
      label,
    );
  }

  async first(timeoutMs = DEFAULT_TIMEOUT_MS, label = "first frame"): Promise<TFrame> {
    return await this.waitFor(() => true, timeoutMs, label);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.relayChannelId && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        relayDatagram(
          RELAY_TAG_CLOSE,
          encodeStreamClose({
            channelId: this.relayChannelId,
            reason: STREAM_CLOSE_REASON_NORMAL,
            message: "acceptance probe complete",
          }),
        ),
      );
    }
    this.socket.close(1000, "acceptance probe complete");
    const error = new Error("frame probe closed");
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async open(
    relay: {
      channel: {
        channelId: string;
        workspaceId: string;
        agentId: string;
        kind: number;
        port: number;
      };
      token: string;
    } | null,
    timeoutMs: number,
  ): Promise<void> {
    await withTimeout(
      new Promise<void>((accept, reject) => {
        let relayAccepted = relay === null;
        const onError = () => reject(new Error("frame WebSocket failed to connect"));
        const onClose = () => {
          if (!this.closed) reject(new Error("frame WebSocket closed during connection"));
        };
        this.socket.addEventListener("error", onError, { once: true });
        this.socket.addEventListener("close", onClose, { once: true });
        this.socket.addEventListener("open", () => {
          if (!relay) {
            accept();
            return;
          }
          this.socket.send(
            relayDatagram(
              RELAY_TAG_OPEN,
              encodeStreamOpen({
                channel: relay.channel,
                token: relay.token,
                role: STREAM_ROLE_CLIENT,
                resumeFromSeq: "0",
              }),
            ),
          );
        });
        this.socket.addEventListener("message", (event) => {
          this.messagesReceived += 1;
          this.processing = this.processing
            .then(async () => {
              const bytes = await messageBytes(event.data);
              let frameBytes = bytes;
              if (relay) {
                const tag = bytes[0];
                const body = bytes.subarray(1);
                if (tag === RELAY_TAG_OPEN_ACK) {
                  const ack = decodeStreamOpenAck(body);
                  if (!ack.accepted) {
                    throw new Error(ack.error?.message ?? "relay rejected frame stream");
                  }
                  relayAccepted = true;
                  accept();
                  return;
                }
                if (tag === RELAY_TAG_CLOSE) {
                  throw new Error(
                    `${this.streamLabel} relay frame source closed (${this.relayChannelId ?? "direct"})`,
                  );
                }
                if (tag !== RELAY_TAG_FRAME || !relayAccepted) return;
                frameBytes = decodeStreamFrame(body).data;
              }
              this.push(await this.decode(frameBytes));
              this.framesDecoded += 1;
            })
            .catch((cause) => {
              const error = cause instanceof Error ? cause : new Error(String(cause));
              reject(error);
              this.fail(error);
            });
        });
      }),
      timeoutMs,
      "frame stream connection",
    );
  }

  private async waitFor(
    predicate: (frame: TFrame) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<TFrame> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) return this.queue.splice(queuedIndex, 1)[0]!;
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("frame probe is closed");
    return await new Promise<TFrame>((accept, reject) => {
      const waiter = {
        predicate,
        resolve: accept,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `${label} did not converge within ${timeoutMs}ms: ` +
                JSON.stringify({
                  readyState: this.socket.readyState,
                  relayChannelId: this.relayChannelId,
                  messagesReceived: this.messagesReceived,
                  framesDecoded: this.framesDecoded,
                  queuedFrames: this.queue.length,
                }),
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private push(frame: TFrame): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      this.queue.push(frame);
      if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
      return;
    }
    const waiter = this.waiters.splice(index, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deploymentAccessKey = process.env.OPENGENI_INTERACTION_ACCEPTANCE_ACCESS_KEY?.trim();
  const client = new OpenGeniClient({
    baseUrl: args.apiUrl,
    ...(deploymentAccessKey ? { headers: { "x-opengeni-access-key": deploymentAccessKey } } : {}),
  });
  const workspaceId = args.workspaceId ?? (await defaultWorkspace(args.apiUrl));
  const checks: string[] = [];
  const raw = new Map<InteractionLatencyMetric, number[]>();
  const record = (metric: InteractionLatencyMetric, value: number) => {
    const samples = raw.get(metric) ?? [];
    samples.push(value);
    raw.set(metric, samples);
  };

  const computerCreateOperationId = crypto.randomUUID();
  const browserCreateOperationId = crypto.randomUUID();
  const computerEndOperationId = crypto.randomUUID();
  const browserEndOperationId = crypto.randomUUID();
  let computer = args.includeComputer
    ? await timedResource("computerCreate", raw, () =>
        replayStableMutation(() =>
          client.interaction.computers.open(workspaceId, {
            operationId: computerCreateOperationId,
            sessionId: args.sessionId,
            name: "Interaction acceptance computer",
          }),
        ),
      )
    : null;
  let browser: Awaited<ReturnType<typeof client.interaction.browsers.open>> | null = null;
  let browserProbe: FrameProbe<BrowserFrame> | null = null;
  let secondaryBrowserProbe: FrameProbe<BrowserFrame> | null = null;
  let computerProbe: ComputerVisualProbe | null = null;
  let browserTransport: BrowserSessionAttachment["stream"]["kind"] | null = null;
  let computerTransport: ComputerSessionAttachment["stream"]["kind"] | null = null;
  let browserSessionId = "";
  let computerSessionId: string | null = computer?.id ?? null;
  try {
    const computerSession = computer ? await computer.get() : null;
    browser = await timedResource("browserCreate", raw, () =>
      replayStableMutation(() =>
        client.interaction.browsers.open(workspaceId, {
          operationId: browserCreateOperationId,
          sessionId: args.sessionId,
          name: "Interaction acceptance browser",
          initialUrl: fixtureUrl(),
          headless: !computer,
          ...(computerSession
            ? {
                linkedComputerSessionId: computerSession.id,
                placement: computerSession.placement,
              }
            : {}),
        }),
      ),
    );
    const browserSession = await browser.get();
    browserSessionId = browser.id;
    if (browserSession.lifecycle !== "active" || !browserSession.controller) {
      throw new Error("browser did not become active");
    }
    checks.push("browser.active");

    let started = performance.now();
    const targetList = await browser.tabs.list();
    const target =
      targetList.targets.find((candidate) => candidate.selected) ?? targetList.targets[0];
    if (!target) throw new Error("browser opened without a target");
    let observation = await browser.observe(target.id);
    record("browserObserve", performance.now() - started);
    if (observation.target.title !== "OpenGeni Interaction Acceptance") {
      throw new Error(`browser fixture title is ${JSON.stringify(observation.target.title)}`);
    }
    for (let index = 1; index < args.iterations; index += 1) {
      started = performance.now();
      observation = await browser.observe(target.id);
      record("browserObserve", performance.now() - started);
    }
    checks.push("browser.semantic-observation");

    started = performance.now();
    const browserAttachment = await browser.attach({
      targetId: target.id,
      expiresInSeconds: 120,
      stream: { format: "jpeg", quality: 72, maxWidth: 1_280, maxHeight: 720 },
    });
    browserTransport = browserAttachment.stream.kind;
    browserProbe = await FrameProbe.browser(browserAttachment);
    let browserFrame = await browserProbe.first(DEFAULT_TIMEOUT_MS, "browser first frame");
    record("browserFirstFrame", performance.now() - started);
    checks.push("browser.first-frame");

    const secondaryBrowserAttachment = await browser.attach({
      targetId: target.id,
      expiresInSeconds: 120,
      stream: {
        format: "png",
        maxWidth: 640,
        maxHeight: 360,
        everyNthFrame: 2,
      },
    });
    secondaryBrowserProbe = await FrameProbe.browser(secondaryBrowserAttachment);
    let secondaryBrowserFrame = await secondaryBrowserProbe.first(
      DEFAULT_TIMEOUT_MS,
      "secondary browser first frame",
    );
    if (
      secondaryBrowserFrame.browserSessionId !== browser.id ||
      secondaryBrowserFrame.targetId !== target.id ||
      secondaryBrowserFrame.mediaType !== "image/png" ||
      secondaryBrowserFrame.width > 640 ||
      secondaryBrowserFrame.height > 360
    ) {
      throw new Error(
        `secondary browser stream ignored its profile: ${JSON.stringify({
          browserSessionId: secondaryBrowserFrame.browserSessionId,
          targetId: secondaryBrowserFrame.targetId,
          mediaType: secondaryBrowserFrame.mediaType,
          width: secondaryBrowserFrame.width,
          height: secondaryBrowserFrame.height,
        })}`,
      );
    }
    checks.push("browser.concurrent-stream-profiles");

    for (let index = 0; index < args.iterations; index += 1) {
      const value = `OPENGENI_VISIBLE_${index}_${crypto.randomUUID().slice(0, 8)}`;
      const request: BrowserActionRequest = {
        operationId: crypto.randomUUID(),
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId,
        action: {
          type: "fill",
          locator: { kind: "css", selector: "#acceptance-input" },
          value,
        },
      };
      started = performance.now();
      const receipt = await browser.act(request);
      const acknowledged = performance.now();
      if (receipt.state !== "completed" || !receipt.observation) {
        throw new Error(`browser action settled as ${receipt.state}`);
      }
      const nextFrame = await browserProbe.nextChangedAfter(
        browserFrame,
        DEFAULT_TIMEOUT_MS,
        `browser fill ${index} visible frame`,
      );
      if (index === 0) {
        secondaryBrowserFrame = await secondaryBrowserProbe.nextChangedAfter(
          secondaryBrowserFrame,
          DEFAULT_TIMEOUT_MS,
          "secondary browser fill visible frame",
        );
        checks.push("browser.concurrent-stream-profiles-visible");
      }
      record("browserActionAcknowledged", acknowledged - started);
      record("browserActionVisible", performance.now() - started);
      browserFrame = nextFrame;
      observation = receipt.observation;
      if (index === 0) {
        const replay = await browser.act(request);
        if (
          replay.operationId !== receipt.operationId ||
          replay.dispatchedAt !== receipt.dispatchedAt ||
          replay.settledAt !== receipt.settledAt
        ) {
          throw new Error("same operation id did not replay the durable browser receipt");
        }
        checks.push("browser.exactly-once-replay");
      }
    }

    const browserClipboardMarker = `BROWSER_PASTE_${crypto.randomUUID().slice(0, 8)}`;
    let browserClipboardReceipt = await browser.act({
      operationId: crypto.randomUUID(),
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId,
      action: {
        type: "clipboard",
        operation: "write",
        text: browserClipboardMarker,
      },
    });
    if (browserClipboardReceipt.state !== "completed" || !browserClipboardReceipt.observation) {
      throw new Error(`browser clipboard write settled as ${browserClipboardReceipt.state}`);
    }
    observation = browserClipboardReceipt.observation;
    const browserClipboard = await browser.clipboard.read();
    if (browserClipboard.text !== browserClipboardMarker) {
      throw new Error("browser clipboard read did not match the exact written value");
    }
    started = performance.now();
    browserClipboardReceipt = await browser.act({
      operationId: crypto.randomUUID(),
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId,
      action: {
        type: "clipboard",
        operation: "paste",
        locator: { kind: "css", selector: "#acceptance-input" },
      },
    });
    const browserClipboardAcknowledged = performance.now();
    if (browserClipboardReceipt.state !== "completed" || !browserClipboardReceipt.observation) {
      throw new Error(`browser clipboard paste settled as ${browserClipboardReceipt.state}`);
    }
    browserFrame = await browserProbe.nextChangedAfter(
      browserFrame,
      DEFAULT_TIMEOUT_MS,
      "browser clipboard paste visible frame",
    );
    record("browserActionAcknowledged", browserClipboardAcknowledged - started);
    record("browserActionVisible", performance.now() - started);
    observation = browserClipboardReceipt.observation;
    checks.push("browser.clipboard-roundtrip-visible");

    started = performance.now();
    browserProbe.close();
    browserProbe = await FrameProbe.browser(
      await browser.attach({
        targetId: observation.target.id,
        expiresInSeconds: 120,
        stream: {
          format: "jpeg",
          quality: 72,
          maxWidth: 1_280,
          maxHeight: 720,
        },
      }),
    );
    browserFrame = await browserProbe.first(DEFAULT_TIMEOUT_MS, "browser reconnect first frame");
    record("browserReconnect", performance.now() - started);
    if (browserFrame.browserSessionId !== browser.id)
      throw new Error("browser reconnect crossed sessions");
    checks.push("browser.reconnect");

    const postReconnectMarker = `OPENGENI_RECONNECT_${crypto.randomUUID().slice(0, 8)}`;
    started = performance.now();
    const postReconnectReceipt = await browser.act({
      operationId: crypto.randomUUID(),
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId,
      action: {
        type: "fill",
        locator: { kind: "css", selector: "#acceptance-input" },
        value: postReconnectMarker,
      },
    });
    const postReconnectAcknowledged = performance.now();
    if (postReconnectReceipt.state !== "completed" || !postReconnectReceipt.observation) {
      throw new Error(`post-reconnect browser action settled as ${postReconnectReceipt.state}`);
    }
    [browserFrame, secondaryBrowserFrame] = await Promise.all([
      browserProbe.nextChangedAfter(
        browserFrame,
        DEFAULT_TIMEOUT_MS,
        "reconnected browser visible frame",
      ),
      secondaryBrowserProbe.nextChangedAfter(
        secondaryBrowserFrame,
        DEFAULT_TIMEOUT_MS,
        "secondary browser remained live across peer reconnect",
      ),
    ]);
    record("browserActionAcknowledged", postReconnectAcknowledged - started);
    record("browserActionVisible", performance.now() - started);
    observation = postReconnectReceipt.observation;
    checks.push("browser.concurrent-stream-profile-reconnect-isolation");

    if (computer) {
      const targets = await computer.targets.list();
      const computerTarget =
        targets.targets.find(
          (candidate) =>
            candidate.kind === "window" &&
            candidate.title.startsWith("OpenGeni Interaction Acceptance"),
        ) ??
        targets.targets.find((candidate) => candidate.kind === "window" && candidate.focused) ??
        targets.targets.find((candidate) => candidate.kind === "app" && candidate.focused) ??
        targets.targets[0];
      const isMacBrowserWindow = computerTarget?.applicationId === "com.google.Chrome";
      const frameTarget =
        (isMacBrowserWindow ? computerTarget : undefined) ??
        targets.targets.find((candidate) => candidate.kind === "screen") ??
        computerTarget;
      if (!computerTarget || !frameTarget) throw new Error("computer opened without a target");
      started = performance.now();
      let computerObservation = await computer.observe(computerTarget.id);
      record("computerObserve", performance.now() - started);
      for (let index = 1; index < args.iterations; index += 1) {
        started = performance.now();
        computerObservation = await computer.observe(computerTarget.id);
        record("computerObserve", performance.now() - started);
      }
      // Chromium's Linux AT-SPI bridge exposes editable HTML inputs through
      // Component + Text, so semantic focus followed by the native keyboard
      // path is the truthful portable contract. macOS AX exposes set_value and
      // additionally proves background mutation without foreground focus.
      let inputNode: InteractionSemanticNode;
      try {
        inputNode = findSemanticNode(computerObservation.semantic, (node) => {
          return (
            (node.role === "entry" || node.role === "text_field") &&
            (node.name === "Acceptance input" || node.description === "Acceptance input") &&
            node.actions.includes("focus") &&
            (!isMacBrowserWindow || node.actions.includes("set_value"))
          );
        });
      } catch {
        throw new Error(
          `computer target ${JSON.stringify(computerTarget)} did not expose the acceptance input; targets=${JSON.stringify(targets.targets)} semantic=${JSON.stringify(semanticEntrySummary(computerObservation.semantic))}`,
        );
      }
      if (isMacBrowserWindow) {
        if (computerTarget.focused) {
          throw new Error("managed macOS browser stole foreground focus before explicit control");
        }
        const backgroundMarker = `background${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const backgroundReceipt = await acceptanceStep(
          "computer background semantic value",
          async () =>
            computer.act({
              operationId: crypto.randomUUID(),
              targetId: computerObservation.target.id,
              expectedTargetGeneration: computerObservation.target.targetGeneration,
              expectedObservationId: computerObservation.observationId,
              expectedFrameId: computerObservation.frameId,
              action: {
                type: "semantic",
                locator: { kind: "ref", ref: inputNode.ref },
                action: "set_value",
                value: backgroundMarker,
              },
            }),
        );
        if (backgroundReceipt.state !== "completed" || !backgroundReceipt.observation) {
          throw new Error(
            `macOS background semantic action settled as ${backgroundReceipt.state}: ${JSON.stringify(backgroundReceipt.error)}`,
          );
        }
        const browserAfterBackground = await waitForSemanticValue(
          () => browser!.observe(observation.target.id),
          backgroundMarker,
          2_000,
        );
        if (!semanticContainsValue(browserAfterBackground.semantic, backgroundMarker)) {
          throw new Error("macOS background semantic action did not reach browser state");
        }
        const afterBackgroundTargets = await computer.targets.list();
        const afterBackgroundTarget = afterBackgroundTargets.targets.find(
          (candidate) => candidate.id === computerTarget.id,
        );
        if (!afterBackgroundTarget || afterBackgroundTarget.focused) {
          throw new Error("macOS background semantic action stole foreground focus");
        }
        computerObservation = backgroundReceipt.observation;
        inputNode = findSemanticNode(computerObservation.semantic, (node) => {
          return (
            (node.role === "entry" || node.role === "text_field") &&
            (node.name === "Acceptance input" || node.description === "Acceptance input") &&
            node.actions.includes("focus") &&
            (!isMacBrowserWindow || node.actions.includes("set_value"))
          );
        });
        checks.push("computer.background-semantic-exact", "computer.background-no-focus-steal");
      }
      if (isMacBrowserWindow) {
        const targetFocusReceipt = await acceptanceStep("computer target focus", async () =>
          computer.act({
            operationId: crypto.randomUUID(),
            targetId: computerObservation.target.id,
            expectedTargetGeneration: computerObservation.target.targetGeneration,
            expectedObservationId: computerObservation.observationId,
            expectedFrameId: computerObservation.frameId,
            action: { type: "focus", targetId: computerObservation.target.id },
          }),
        );
        if (targetFocusReceipt.state !== "completed" || !targetFocusReceipt.observation) {
          throw new Error(
            `computer target focus settled as ${targetFocusReceipt.state}: ${JSON.stringify(targetFocusReceipt.error)}`,
          );
        }
        computerObservation = targetFocusReceipt.observation;
        inputNode = findSemanticNode(computerObservation.semantic, (node) => {
          return (
            (node.role === "entry" || node.role === "text_field") &&
            (node.name === "Acceptance input" || node.description === "Acceptance input") &&
            node.actions.includes("focus") &&
            (!isMacBrowserWindow || node.actions.includes("set_value"))
          );
        });
        checks.push("computer.explicit-target-focus");
      }
      let focusReceipt;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        computerObservation = await computer.observe(computerObservation.target.id);
        inputNode = findSemanticNode(computerObservation.semantic, (node) => {
          return (
            (node.role === "entry" || node.role === "text_field") &&
            (node.name === "Acceptance input" || node.description === "Acceptance input") &&
            node.actions.includes("focus") &&
            (!isMacBrowserWindow || node.actions.includes("set_value"))
          );
        });
        focusReceipt = await acceptanceStep("computer semantic focus", async () =>
          computer.act({
            operationId: crypto.randomUUID(),
            targetId: computerObservation.target.id,
            expectedTargetGeneration: computerObservation.target.targetGeneration,
            expectedObservationId: computerObservation.observationId,
            expectedFrameId: computerObservation.frameId,
            action: {
              type: "semantic",
              locator: { kind: "ref", ref: inputNode.ref },
              action: "focus",
            },
          }),
        );
        if (focusReceipt.state === "completed") break;
        if (
          !["observation_stale", "selector_stale", "target_stale"].includes(
            focusReceipt.error?.code ?? "",
          ) ||
          attempt === 4
        ) {
          break;
        }
        await Bun.sleep(25 * (attempt + 1));
      }
      if (focusReceipt.state !== "completed") {
        throw new Error(
          `computer semantic focus settled as ${focusReceipt.state}: ${JSON.stringify(focusReceipt.error)}`,
        );
      }
      let controlObservation = await computer.observe(frameTarget.id);
      checks.push("computer.semantic-observation", "computer.semantic-focus");

      started = performance.now();
      const computerAttachment = await computer.attach({
        targetId: frameTarget.id,
        expiresInSeconds: 120,
        stream: {
          format: "jpeg",
          quality: 72,
          maxWidth: 1_280,
          maxHeight: 720,
        },
      });
      computerTransport = computerAttachment.stream.kind;
      computerProbe = await openComputerVisualProbe(computerAttachment);
      let computerFrame = await computerProbe.first(DEFAULT_TIMEOUT_MS, "computer first frame");
      record("computerFirstFrame", performance.now() - started);
      checks.push("computer.first-frame");
      controlObservation = await computer.observe(frameTarget.id);

      // The native X11 adapter types keysyms directly; lowercase alphanumeric
      // input proves exact text without conflating the assertion with Shift or
      // keyboard-layout translation.
      const marker = `native${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      let computerReceipt;
      let keyboardStarted = performance.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        controlObservation = await computer.observe(frameTarget.id);
        const attemptStarted = performance.now();
        computerReceipt = await acceptanceStep("computer keyboard type", async () =>
          computer.act({
            operationId: crypto.randomUUID(),
            targetId: controlObservation.target.id,
            expectedTargetGeneration: controlObservation.target.targetGeneration,
            expectedObservationId: controlObservation.observationId,
            expectedFrameId: null,
            action: { type: "keyboard", action: "type", value: marker },
          }),
        );
        logComputerAttempt(
          "keyboard",
          attempt,
          performance.now() - attemptStarted,
          computerReceipt,
        );
        if (computerReceipt.state === "completed") {
          keyboardStarted = attemptStarted;
          break;
        }
        if (!computerReceipt.error?.retryable || attempt === 4) break;
        await Bun.sleep(25 * (attempt + 1));
      }
      const computerAcknowledged = performance.now();
      if (!computerReceipt || computerReceipt.state !== "completed") {
        const currentTargets = await computer.targets.list().catch(() => null);
        throw new Error(
          `computer keyboard action settled as ${computerReceipt.state}: ${JSON.stringify(computerReceipt.error)}; lastObservation=${JSON.stringify(computerObservation.target)}; currentTarget=${JSON.stringify(currentTargets?.targets.find((candidate) => candidate.id === computerObservation.target.id) ?? null)}; focusedTargets=${JSON.stringify(currentTargets?.targets.filter((candidate) => candidate.focused) ?? [])}`,
        );
      }
      let keyboardVisibleAt: number | null = null;
      const [keyboardFrameResult, keyboardStateResult] = await Promise.allSettled([
        computerProbe
          .nextChangedAfter(
            computerFrame,
            DEFAULT_TIMEOUT_MS,
            "computer keyboard visible frame",
          )
          .then((frame) => {
            keyboardVisibleAt = performance.now();
            return frame;
          }),
        waitForSemanticValue(() => browser!.observe(observation.target.id), marker, 2_000),
      ]);
      if (keyboardStateResult.status === "rejected") throw keyboardStateResult.reason;
      if (keyboardFrameResult.status === "rejected") {
        throw new Error(
          "computer keyboard reached exact DOM state but not the live window stream",
          {
            cause: keyboardFrameResult.reason,
          },
        );
      }
      computerFrame = keyboardFrameResult.value;
      record("computerActionAcknowledged", computerAcknowledged - keyboardStarted);
      record(
        "computerActionVisible",
        (keyboardVisibleAt ?? performance.now()) - keyboardStarted,
      );
      if ("computerSessionId" in computerFrame && computerFrame.computerSessionId !== computer.id) {
        throw new Error("computer frame crossed sessions");
      }
      observation = keyboardStateResult.value;
      const copiedKeyboardValue = await browser.act({
        operationId: crypto.randomUUID(),
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId,
        action: {
          type: "clipboard",
          operation: "copy",
          locator: { kind: "css", selector: "#acceptance-input" },
          content: "value",
        },
      });
      if (copiedKeyboardValue.state !== "completed" || !copiedKeyboardValue.observation) {
        throw new Error(`browser value copy settled as ${copiedKeyboardValue.state}`);
      }
      observation = copiedKeyboardValue.observation;
      const exactKeyboardValue = await browser.clipboard.read();
      if (!exactKeyboardValue.text.includes(marker)) {
        throw new Error(
          `computer keyboard receipt and pixels completed without exact DOM state: ${JSON.stringify(exactKeyboardValue.text)}`,
        );
      }
      checks.push("computer.keyboard-visible", "computer.keyboard-exact-state");

      const clipboardMarker = `NATIVE_PASTE_${crypto.randomUUID().slice(0, 8)}_Ω`;
      let currentObservation = computerReceipt.observation ?? controlObservation;
      const clipboardWriteReceipt = await acceptanceStep("computer clipboard write", async () =>
        computer.act({
          operationId: crypto.randomUUID(),
          targetId: currentObservation.target.id,
          expectedTargetGeneration: currentObservation.target.targetGeneration,
          expectedObservationId: currentObservation.observationId,
          expectedFrameId: null,
          action: {
            type: "clipboard",
            operation: "write",
            text: clipboardMarker,
          },
        }),
      );
      if (clipboardWriteReceipt.state !== "completed") {
        throw new Error(
          `computer clipboard write settled as ${clipboardWriteReceipt.state}: ${JSON.stringify(clipboardWriteReceipt.error)}`,
        );
      }
      currentObservation = clipboardWriteReceipt.observation ?? currentObservation;
      const nativeClipboard = await computer.clipboard.read();
      if (nativeClipboard.text !== clipboardMarker || nativeClipboard.truncated) {
        throw new Error("computer clipboard read did not match the exact written value");
      }
      let selectReceipt;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const attemptStarted = performance.now();
        selectReceipt = await acceptanceStep("computer select all", async () =>
          computer.act({
            operationId: crypto.randomUUID(),
            targetId: currentObservation.target.id,
            expectedTargetGeneration: currentObservation.target.targetGeneration,
            expectedObservationId: currentObservation.observationId,
            expectedFrameId: null,
            action: {
              type: "keyboard",
              action: "press",
              value: isMacBrowserWindow ? "Meta+a" : "Control+a",
            },
          }),
        );
        logComputerAttempt(
          "select-all",
          attempt,
          performance.now() - attemptStarted,
          selectReceipt,
        );
        if (selectReceipt.state === "completed") break;
        if (!selectReceipt.error?.retryable || attempt === 4) break;
        currentObservation = await computer.observe(currentObservation.target.id);
        await Bun.sleep(25 * (attempt + 1));
      }
      if (selectReceipt.state !== "completed") {
        throw new Error(
          `computer select-all settled as ${selectReceipt.state}: ${JSON.stringify(selectReceipt.error)}`,
        );
      }
      currentObservation = selectReceipt.observation ?? currentObservation;
      let pasteReceipt;
      let pasteStarted = performance.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const attemptStarted = performance.now();
        pasteReceipt = await acceptanceStep("computer clipboard paste", async () =>
          computer.act({
            operationId: crypto.randomUUID(),
            targetId: currentObservation.target.id,
            expectedTargetGeneration: currentObservation.target.targetGeneration,
            expectedObservationId: currentObservation.observationId,
            expectedFrameId: null,
            action: { type: "clipboard", operation: "paste" },
          }),
        );
        logComputerAttempt("paste", attempt, performance.now() - attemptStarted, pasteReceipt);
        if (pasteReceipt.state === "completed") {
          pasteStarted = attemptStarted;
          break;
        }
        if (!pasteReceipt.error?.retryable || attempt === 4) break;
        currentObservation = await computer.observe(currentObservation.target.id);
        await Bun.sleep(25 * (attempt + 1));
      }
      const pasteAcknowledged = performance.now();
      if (pasteReceipt.state !== "completed") {
        throw new Error(
          `computer clipboard paste settled as ${pasteReceipt.state}: ${JSON.stringify(pasteReceipt.error)}`,
        );
      }
      let pasteVisibleAt: number | null = null;
      const [nextComputerFrame, clipboardObservation] = await Promise.all([
        computerProbe
          .nextChangedAfter(
            computerFrame,
            DEFAULT_TIMEOUT_MS,
            "computer clipboard paste visible frame",
          )
          .then((frame) => {
            pasteVisibleAt = performance.now();
            return frame;
          }),
        waitForSemanticValue(
          // The native screen action and the BrowserSession control the same
          // linked Chromium. Browser DOM semantics give an exact content proof
          // even when the large AT-SPI tree intentionally omits expensive text
          // values from its compact observation.
          () => browser!.observe(observation.target.id),
          clipboardMarker,
          2_000,
        ),
      ]);
      computerFrame = nextComputerFrame;
      record("computerActionAcknowledged", pasteAcknowledged - pasteStarted);
      record("computerActionVisible", (pasteVisibleAt ?? performance.now()) - pasteStarted);
      if (!semanticContainsValue(clipboardObservation.semantic, clipboardMarker)) {
        throw new Error(
          `computer semantic state did not converge to the pasted clipboard value: ${JSON.stringify(semanticEntrySummary(clipboardObservation.semantic))}`,
        );
      }
      checks.push("computer.clipboard-roundtrip-visible");

      // Prove the exact human-viewer input plane as well as controller-side
      // native actions. Direct RFB input must reach the linked Chromium DOM;
      // otherwise a visually connected noVNC surface could still be inert.
      if (computerProbe.typeAscii) {
        const viewerMarker = `viewer${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
        computerProbe.typeAscii(viewerMarker);
        computerFrame = await computerProbe.nextChangedAfter(
          computerFrame,
          DEFAULT_TIMEOUT_MS,
          "computer RFB keyboard visible frame",
        );
        const viewerObservation = await waitForSemanticValue(
          () => browser!.observe(observation.target.id),
          viewerMarker,
          2_000,
        );
        if (!semanticContainsValue(viewerObservation.semantic, viewerMarker)) {
          throw new Error("RFB keyboard input produced pixels without exact DOM state");
        }
        checks.push("computer.rfb-keyboard-exact-state");
      }

      started = performance.now();
      computerProbe.close();
      computerProbe = await openComputerVisualProbe(
        await computer.attach({
          targetId: frameTarget.id,
          expiresInSeconds: 120,
          stream: {
            format: "jpeg",
            quality: 72,
            maxWidth: 1_280,
            maxHeight: 720,
          },
        }),
      );
      await computerProbe.first(DEFAULT_TIMEOUT_MS, "computer reconnect first frame");
      record("computerReconnect", performance.now() - started);
      checks.push("computer.reconnect");
    }

    browserProbe.close();
    browserProbe = null;
    secondaryBrowserProbe.close();
    secondaryBrowserProbe = null;
    computerProbe?.close();
    computerProbe = null;
    started = performance.now();
    await replayStableMutation(() => browser!.end({ operationId: browserEndOperationId }));
    record("resourceEnd", performance.now() - started);
    browser = null;
    if (computer) {
      started = performance.now();
      await replayStableMutation(() => computer!.end({ operationId: computerEndOperationId }));
      record("resourceEnd", performance.now() - started);
      computer = null;
    }

    process.stderr.write(
      `${JSON.stringify({ measurements: Object.fromEntries([...raw].map(([metric, samples]) => [metric, measurement(samples)])) })}\n`,
    );
    const budgets = interactionLatencyBudgetsForTransport(computerTransport);
    const budgetFailures = [...raw].flatMap(([metric, samples]) => {
      const failure = budgetFailure(metric, samples, budgets);
      return failure ? [failure] : [];
    });
    if (budgetFailures.length > 0) {
      throw new Error(`latency budgets exceeded: ${budgetFailures.join("; ")}`);
    }
    checks.push("latency.budgets");

    const receipt: Receipt = {
      schemaVersion: "opengeni/interaction-live-acceptance/v1",
      generatedAt: new Date().toISOString(),
      apiUrl: args.apiUrl,
      workspaceId,
      sessionId: args.sessionId,
      browserSessionId,
      computerSessionId,
      placement: browserSession.placement,
      transport: { browser: browserTransport!, computer: computerTransport },
      measurements: Object.fromEntries(
        [...raw].map(([metric, samples]) => [metric, measurement(samples)]),
      ),
      checks,
      budgets,
    };
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", output: args.output, receipt })}\n`);
  } finally {
    browserProbe?.close();
    secondaryBrowserProbe?.close();
    computerProbe?.close();
    if (browser) {
      const started = performance.now();
      await replayStableMutation(() => browser!.end({ operationId: browserEndOperationId })).catch(
        () => undefined,
      );
      record("resourceEnd", performance.now() - started);
    }
    if (computer) {
      const started = performance.now();
      await replayStableMutation(() =>
        computer!.end({ operationId: computerEndOperationId }),
      ).catch(() => undefined);
      record("resourceEnd", performance.now() - started);
    }
  }
}

async function openComputerVisualProbe(
  attachment: ComputerSessionAttachment,
): Promise<ComputerVisualProbe> {
  if (attachment.stream.kind === "direct_rfb") {
    const rfb = await RfbAcceptanceProbe.open(attachment);
    return {
      first: (timeoutMs, label) => rfb.first(timeoutMs, label),
      nextChangedAfter: (previous, timeoutMs, label) =>
        rfb.nextChangedAfter(previous as RfbUpdate, timeoutMs, label),
      typeAscii: (value) => rfb.typeAscii(value),
      close: () => rfb.close(),
    };
  }
  const encoded = await FrameProbe.computer(attachment);
  return {
    first: (timeoutMs, label) => encoded.first(timeoutMs, label),
    nextChangedAfter: (previous, timeoutMs, label) =>
      encoded.nextChangedAfter(previous as ComputerFrame, timeoutMs, label),
    close: () => encoded.close(),
  };
}

async function replayStableMutation<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof OpenGeniApiError) || !error.retryable || attempt === 2) throw error;
      await Bun.sleep(100 * 2 ** attempt);
    }
  }
  throw lastError;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    if (values.has(flag)) throw new Error(`${flag} may be supplied only once`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set([
    "--api-url",
    "--workspace-id",
    "--session-id",
    "--iterations",
    "--output",
    "--include-computer",
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag ${flag}`);
  const apiUrl = values.get("--api-url") ?? "http://127.0.0.1:8200";
  const sessionId = values.get("--session-id");
  if (!sessionId) throw new Error("--session-id is required");
  const iterations = Number(values.get("--iterations") ?? "12");
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000) {
    throw new Error("--iterations must be an integer from 1 to 1000");
  }
  const includeComputer = values.get("--include-computer") ?? "true";
  if (includeComputer !== "true" && includeComputer !== "false") {
    throw new Error("--include-computer must be true or false");
  }
  return {
    apiUrl: new URL(apiUrl).origin,
    workspaceId: values.get("--workspace-id") ?? null,
    sessionId,
    iterations,
    output: resolve(
      values.get("--output") ?? `.agent/evidence/interaction-live-${Date.now()}.json`,
    ),
    includeComputer: includeComputer === "true",
  };
}

async function defaultWorkspace(apiUrl: string): Promise<string> {
  const response = await fetch(new URL("/v1/access/me", apiUrl));
  if (!response.ok) throw new Error(`access discovery returned ${response.status}`);
  const value = (await response.json()) as { defaultWorkspaceId?: unknown };
  if (typeof value.defaultWorkspaceId !== "string" || !value.defaultWorkspaceId) {
    throw new Error("access discovery did not return a default workspace");
  }
  return value.defaultWorkspaceId;
}

async function timedResource<T>(
  metric: "browserCreate" | "computerCreate",
  raw: Map<InteractionLatencyMetric, number[]>,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const result = await operation();
  const samples = raw.get(metric) ?? [];
  samples.push(performance.now() - started);
  raw.set(metric, samples);
  return result;
}

function measurement(samples: number[]): Measurement {
  if (samples.length === 0) throw new Error("cannot summarize zero latency samples");
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    worst: sorted.at(-1)!,
  };
}

function logComputerAttempt(
  action: string,
  attempt: number,
  elapsedMs: number,
  receipt: { state: string; error?: { code?: string; retryable?: boolean } | null },
): void {
  process.stderr.write(
    `${JSON.stringify({ event: "acceptance.computer-action", action, attempt, elapsedMs, state: receipt.state, errorCode: receipt.error?.code ?? null, retryable: receipt.error?.retryable ?? null })}\n`,
  );
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

async function acceptanceStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${message}`, { cause: error });
  }
}

function budgetFailure(
  metric: InteractionLatencyMetric,
  samples: number[],
  budgets: Readonly<Record<InteractionLatencyMetric, InteractionLatencyBudget>>,
): string | null {
  const budget = budgets[metric];
  const observed = measurement(samples)[budget.statistic];
  if (observed > budget.limitMs) {
    return `${metric} ${budget.statistic} ${observed.toFixed(1)}ms exceeds ${budget.limitMs}ms`;
  }
  return null;
}

function fixtureUrl(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>OpenGeni Interaction Acceptance</title><style>body{font:24px system-ui;background:#10151d;color:#fff;padding:48px}input{font:24px;padding:16px;width:720px}#state{margin-top:24px}</style><h1>Interaction acceptance</h1><input id="acceptance-input" aria-label="Acceptance input" autofocus><div id="state">ready</div><script>const input=document.querySelector("#acceptance-input");const state=document.querySelector("#state");input.addEventListener("input",()=>{state.textContent=input.value;let hash=0;for(const char of input.value)hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;document.body.style.background="hsl("+(hash%360)+" 58% 24%)"});</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function findSemanticNode(
  semantic: { kind: string; roots?: InteractionSemanticNode[] } | null,
  predicate: (node: InteractionSemanticNode) => boolean,
): InteractionSemanticNode {
  const pending = semantic?.kind === "snapshot" ? [...(semantic.roots ?? [])] : [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (predicate(node)) return node;
    pending.unshift(...(node.children ?? []));
  }
  throw new Error("computer semantic observation did not expose the acceptance input");
}

function semanticContainsValue(
  semantic: {
    kind: string;
    roots?: InteractionSemanticNode[];
    changed?: InteractionSemanticNode[];
  } | null,
  value: string,
): boolean {
  const pending =
    semantic?.kind === "snapshot"
      ? [...(semantic.roots ?? [])]
      : semantic?.kind === "diff"
        ? [...(semantic.changed ?? [])]
        : [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (
      (typeof node.value === "string" && node.value.includes(value)) ||
      node.name?.includes(value) ||
      node.description?.includes(value)
    ) {
      return true;
    }
    pending.unshift(...(node.children ?? []));
  }
  return false;
}

function semanticEntrySummary(
  semantic: {
    kind: string;
    roots?: InteractionSemanticNode[];
    changed?: InteractionSemanticNode[];
  } | null,
): Array<{ role: string; name: string | null; value: string | null }> {
  const pending =
    semantic?.kind === "snapshot"
      ? [...(semantic.roots ?? [])]
      : semantic?.kind === "diff"
        ? [...(semantic.changed ?? [])]
        : [];
  const entries: Array<{
    role: string;
    name: string | null;
    value: string | null;
  }> = [];
  while (pending.length > 0 && entries.length < 12) {
    const node = pending.shift()!;
    if (node.role === "textbox" || node.role === "entry") {
      entries.push({
        role: node.role,
        name: node.name?.slice(0, 160) ?? null,
        value: typeof node.value === "string" ? node.value.slice(0, 160) : null,
      });
    }
    pending.unshift(...(node.children ?? []));
  }
  return entries;
}

async function waitForSemanticValue<
  T extends { semantic: Parameters<typeof semanticContainsValue>[0] },
>(observe: () => Promise<T>, value: string, timeoutMs: number): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let latest = await observe();
  while (!semanticContainsValue(latest.semantic, value)) {
    if (performance.now() >= deadline) return latest;
    await Bun.sleep(25);
    latest = await observe();
  }
  return latest;
}

function relayDatagram(tag: number, body: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(body.length + 1);
  message[0] = tag;
  message.set(body, 1);
  return message.buffer as ArrayBuffer;
}

function sameFrameImage(left: FrameValue, right: FrameValue): boolean {
  if (left.data.byteLength !== right.data.byteLength) return false;
  for (let index = 0; index < left.data.byteLength; index += 1) {
    if (left.data[index] !== right.data[index]) return false;
  }
  return true;
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("frame stream returned a non-binary message");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (import.meta.main) {
  await main();
}
