import type { ComputerTarget } from "@opengeni/sdk/interaction";
import type {
  ComputerFrameWebSocket,
  ComputerFrameWebSocketFactory,
} from "@opengeni/react/interaction";

type ResolveDemoTarget = (computerSessionId: string, targetId: string) => ComputerTarget | null;

/** Deterministic frame transport for the public ComputerSession demo. It speaks
 * the exact authenticated/digested SDK frame envelope; only transport is fake. */
export function createDemoComputerWebSocketFactory(
  resolveTarget: ResolveDemoTarget,
): ComputerFrameWebSocketFactory {
  return (url, protocols) =>
    new DemoComputerWebSocket(url, protocols, resolveTarget) as unknown as ComputerFrameWebSocket;
}

class DemoComputerWebSocket extends EventTarget {
  binaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  private closed = false;
  private sequence = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly computerSessionId: string;
  private readonly targetId: string;

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly resolveTarget: ResolveDemoTarget,
  ) {
    super();
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    this.computerSessionId = decodeURIComponent(parts.at(-2) ?? "");
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
    const target = this.resolveTarget(this.computerSessionId, this.targetId);
    if (!target) return;
    try {
      const image = await renderDemoComputer(target);
      const digest = await crypto.subtle.digest("SHA-256", image.slice().buffer);
      if (this.closed) return;
      this.sequence += 1;
      const metadata = new TextEncoder().encode(
        JSON.stringify({
          frameId: `demo-computer-frame-${target.targetGeneration}`,
          computerSessionId: this.computerSessionId,
          controllerGeneration: target.controllerGeneration,
          targetId: this.targetId,
          targetGeneration: target.targetGeneration,
          sequence: this.sequence,
          mediaType: "image/png",
          width: 1_280,
          height: 720,
          capturedAt: new Date().toISOString(),
          sha256: hex(new Uint8Array(digest)),
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

async function renderDemoComputer(target: ComputerTarget): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 1_280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Demo computer canvas is unavailable.");

  const gradient = context.createLinearGradient(0, 0, 1_280, 720);
  gradient.addColorStop(0, "#09111f");
  gradient.addColorStop(1, "#172238");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1_280, 720);

  context.fillStyle = "#0d1524";
  context.fillRect(0, 0, 1_280, 38);
  context.fillStyle = "#8b9ab0";
  context.font = "14px Inter, system-ui, sans-serif";
  context.fillText(target.kind === "screen" ? "Agent desktop" : target.title, 18, 24);
  context.fillText(new Date().toLocaleTimeString(), 1_188, 24);

  context.fillStyle = "#151d2b";
  roundRect(context, 108, 78, 1_064, 572, 18);
  context.fill();
  context.strokeStyle = "#31415c";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#202b3e";
  roundRect(context, 108, 78, 1_064, 48, 18);
  context.fill();
  context.fillStyle = "#f1f5fb";
  context.font = "600 17px Inter, system-ui, sans-serif";
  context.fillText(target.title || "OpenGeni computer", 164, 108, 760);
  for (const [index, color] of ["#ff6b6b", "#ffd166", "#51cf66"].entries()) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(130 + index * 20, 102, 6, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "#f1f5fb";
  context.font = "650 38px Inter, system-ui, sans-serif";
  context.fillText("ComputerSession", 172, 234);
  context.fillStyle = "#aab6c8";
  context.font = "19px Inter, system-ui, sans-serif";
  context.fillText("This is the same native window the agent controls.", 172, 278);
  context.fillText("Semantic actions and pixels share one generation-fenced stream.", 172, 310);

  context.fillStyle = "#6ea8fe";
  roundRect(context, 172, 374, 174, 50, 11);
  context.fill();
  context.fillStyle = "#07101f";
  context.font = "600 17px Inter, system-ui, sans-serif";
  context.fillText("Run checks", 213, 405);

  context.fillStyle = "#101827";
  roundRect(context, 172, 464, 830, 104, 12);
  context.fill();
  context.fillStyle = "#8ea0b8";
  context.font = "14px ui-monospace, SFMono-Regular, monospace";
  context.fillText(`Target: ${target.kind} · ${target.id}`, 194, 501, 780);
  context.fillText(`Generation: ${target.targetGeneration}`, 194, 531, 780);

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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
