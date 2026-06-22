/* ----------------------------------------------------------------------------
   A fake noVNC RFB for the harness/demo.

   The real DesktopViewer attaches an @novnc/novnc RFB to a wss:// tunnel; in the
   demo there is no box, so we hand it a fake factory that paints a believable
   "agent's desktop" onto a <canvas> inside the mount and fires `connect`. This
   lets reviewers (and the headless screenshot harness) see the actual
   watch ⇄ take-control experience instead of a dead black void.
   -------------------------------------------------------------------------- */

import type { DesktopRfbFactory, DesktopRfbLike } from "@opengeni/sdk";

type Listener = (e?: unknown) => void;

/** Draw a small fake Linux desktop: wallpaper, a terminal window, a cursor. */
function paintDesktop(canvas: HTMLCanvasElement, dpr = 1) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Work in CSS pixels; the bitmap is dpr-scaled so text stays crisp.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;

  // Wallpaper — a soft vertical gradient.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#1b2230");
  grad.addColorStop(1, "#0e131c");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Top bar.
  ctx.fillStyle = "#11151d";
  ctx.fillRect(0, 0, W, 28);
  ctx.fillStyle = "#9aa4b2";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("Activities", 16, 19);
  // Centre the session clock in the top bar so it never collides with the real
  // DesktopViewer toolbar (the "Take control" pill lives top-right).
  ctx.textAlign = "center";
  ctx.fillText("agent@sandbox · 14:02", W / 2, 19);
  ctx.textAlign = "left";

  // A terminal window, centered-ish. Clamp to a sensible minimum so a narrow
  // dock doesn't squash the window title into the traffic-light dots.
  const ww = Math.round(Math.max(Math.min(W - 48, 320), W * 0.66));
  const wh = Math.round(Math.max(Math.min(H - 64, 240), H * 0.6));
  const wx = Math.round((W - ww) / 2);
  const wy = Math.round(H * 0.16);
  // window shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(wx + 6, wy + 8, ww, wh);
  // title bar
  ctx.fillStyle = "#22262e";
  ctx.fillRect(wx, wy, ww, 30);
  for (const [i, c] of [["#ff5f56"], ["#ffbd2e"], ["#27c93f"]].entries()) {
    ctx.fillStyle = c[0]!;
    ctx.beginPath();
    ctx.arc(wx + 18 + i * 20, wy + 15, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#9aa4b2";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("agent@sandbox: ~/api", wx + ww / 2, wy + 19);
  ctx.textAlign = "left";
  // terminal body
  ctx.fillStyle = "#0c0f14";
  ctx.fillRect(wx, wy + 30, ww, wh - 30);
  ctx.font = "13px ui-monospace, monospace";
  const lines: Array<[string, string]> = [
    ["#7fd1b9", "agent@sandbox:~/api$ npm test"],
    ["#cbd3df", ""],
    ["#cbd3df", "  PASS  src/server.test.ts"],
    ["#cbd3df", "  PASS  src/config.test.ts"],
    ["#7fd1b9", "  Tests: 24 passed, 24 total"],
    ["#cbd3df", ""],
    ["#7fd1b9", "agent@sandbox:~/api$ git diff --stat"],
    ["#cbd3df", " src/server.ts | 4 +++-"],
    ["#cbd3df", " infra/main.tf | 2 ++"],
    ["#7fd1b9", "agent@sandbox:~/api$ █"],
  ];
  let ty = wy + 54;
  for (const [color, text] of lines) {
    ctx.fillStyle = color;
    ctx.fillText(text, wx + 16, ty);
    ty += 20;
  }

  // A mouse cursor (the agent's pointer).
  const cx = Math.round(W * 0.62);
  const cy = Math.round(H * 0.55);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy + 16);
  ctx.lineTo(cx + 4, cy + 12);
  ctx.lineTo(cx + 7, cy + 18);
  ctx.lineTo(cx + 9, cy + 17);
  ctx.lineTo(cx + 6, cy + 11);
  ctx.lineTo(cx + 11, cy + 11);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

class FakeRfb implements DesktopRfbLike {
  viewOnly = true;
  scaleViewport = true;
  private listeners = new Map<string, Set<Listener>>();
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private ro: ResizeObserver | null = null;

  constructor(target: HTMLElement) {
    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    target.appendChild(canvas);
    this.canvas = canvas;

    // A real noVNC session with `resizeSession` fills the viewport: the remote
    // framebuffer is resized to the client. Mimic that — paint the fake desktop
    // at the mount's actual pixel size so it fills edge-to-edge at every dock
    // width instead of letterboxing a fixed 4:3 bitmap into black side bars.
    const render = () => {
      const w = Math.max(1, Math.round(target.clientWidth));
      const h = Math.max(1, Math.round(target.clientHeight));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      paintDesktop(canvas, dpr);
    };
    render();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => render());
      this.ro.observe(target);
    }
    // Fire `connect` on the next frame so the hook's listener is already wired.
    this.raf = requestAnimationFrame(() => this.emit("connect"));
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }
  private emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  disconnect(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.ro = null;
    this.canvas.remove();
  }
}

export const fakeRfbFactory: DesktopRfbFactory = (target) => new FakeRfb(target);
