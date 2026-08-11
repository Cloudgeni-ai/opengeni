import type { BrowserTarget } from "@opengeni/sdk/interaction";
import type {
  BrowserFrameWebSocket,
  BrowserFrameWebSocketFactory,
} from "@opengeni/react/interaction";

type ResolveDemoTarget = (browserSessionId: string, targetId: string) => BrowserTarget | null;

/** Deterministic frame transport for the public React demo. It speaks the exact
 * BrowserSession binary envelope while the normal SDK mock owns REST state. */
export function createDemoBrowserWebSocketFactory(
  resolveTarget: ResolveDemoTarget,
): BrowserFrameWebSocketFactory {
  return (url, protocols) =>
    new DemoBrowserWebSocket(url, protocols, resolveTarget) as unknown as BrowserFrameWebSocket;
}

class DemoBrowserWebSocket extends EventTarget {
  binaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  private closed = false;
  private sequence = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly browserSessionId: string;
  private readonly targetId: string;

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly resolveTarget: ResolveDemoTarget,
  ) {
    super();
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    this.browserSessionId = decodeURIComponent(parts.at(-2) ?? "");
    this.targetId = decodeURIComponent(parts.at(-1) ?? "");
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      void this.emitFrame();
      this.frameTimer = setInterval(() => void this.emitFrame(), 1_000);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
  }

  private async emitFrame(): Promise<void> {
    if (this.closed) return;
    const target = this.resolveTarget(this.browserSessionId, this.targetId);
    if (!target || !target.documentGeneration) return;
    try {
      const image = await renderDemoPage(target);
      if (this.closed) return;
      this.sequence += 1;
      const metadata = new TextEncoder().encode(
        JSON.stringify({
          frameId: `demo-frame-${target.documentGeneration}`,
          browserSessionId: this.browserSessionId,
          controllerGeneration: target.controllerGeneration,
          targetId: this.targetId,
          targetGeneration: target.targetGeneration,
          documentGeneration: target.documentGeneration,
          sequence: this.sequence,
          mediaType: "image/png",
          width: 1_280,
          height: 720,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
          capturedAt: new Date().toISOString(),
        }),
      );
      const message = new Uint8Array(4 + metadata.byteLength + image.byteLength);
      new DataView(message.buffer).setUint32(0, metadata.byteLength, false);
      message.set(metadata, 4);
      message.set(image, 4 + metadata.byteLength);
      this.dispatchEvent(new MessageEvent("message", { data: message.buffer }));
    } catch {
      if (!this.closed) this.dispatchEvent(new Event("error"));
    }
  }
}

async function renderDemoPage(target: BrowserTarget): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 1_280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Demo browser canvas is unavailable.");

  const gradient = context.createLinearGradient(0, 0, 1_280, 720);
  gradient.addColorStop(0, "#0b1220");
  gradient.addColorStop(1, "#121b30");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1_280, 720);

  context.fillStyle = "#151d2b";
  roundRect(context, 166, 86, 948, 548, 22);
  context.fill();
  context.strokeStyle = "#2a3850";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#7aa2f7";
  context.beginPath();
  context.arc(232, 148, 18, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#f2f5fb";
  context.font = "600 24px Inter, system-ui, sans-serif";
  context.fillText("OpenGeni browser", 270, 157);

  context.fillStyle = "#0f1624";
  roundRect(context, 214, 194, 852, 52, 12);
  context.fill();
  context.strokeStyle = "#2a3850";
  context.stroke();
  context.fillStyle = "#9aa8bd";
  context.font = "16px ui-monospace, SFMono-Regular, monospace";
  context.fillText(target.url, 236, 226, 800);

  context.fillStyle = "#f2f5fb";
  context.font = "650 42px Inter, system-ui, sans-serif";
  context.fillText(target.title || "Agent browser", 214, 334, 820);
  context.fillStyle = "#aab6c8";
  context.font = "20px Inter, system-ui, sans-serif";
  context.fillText("This page is controlled through the public BrowserSession SDK.", 214, 378);
  context.fillText("Human and agent actions share one causal, generation-fenced stream.", 214, 410);

  context.fillStyle = "#6ea8fe";
  roundRect(context, 214, 466, 208, 54, 12);
  context.fill();
  context.fillStyle = "#07101f";
  context.font = "600 18px Inter, system-ui, sans-serif";
  context.fillText("Explore OpenGeni", 241, 500);

  context.fillStyle = "#6f7d92";
  context.font = "14px ui-monospace, SFMono-Regular, monospace";
  context.fillText(`Live frame ${new Date().toLocaleTimeString()}`, 214, 582);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Demo frame encoding failed."))),
      "image/png",
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
