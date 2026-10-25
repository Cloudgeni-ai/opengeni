import type { FeedbackContext, FeedbackScreenshotUpload } from "@opengeni/sdk";
import { desktopBridge, desktopCapability } from "./desktop";
import { recentErrors } from "./recent-errors";

/* ----------------------------------------------------------------------------
   Screenshots and context for a feedback report from web or the desktop app.
   The desktop app takes a still of its own page without asking; a browser
   uses tab capture, which always asks first. Phones have no tab capture, so
   they add or paste an image instead.
   -------------------------------------------------------------------------- */

/** Screenshots one report may carry, and the largest one the server accepts. */
export const FEEDBACK_SCREENSHOT_MAX_COUNT = 3;
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;
/** The longest side kept: plenty to read text, small enough to send quickly. */
const MAX_EDGE = 2400;

export type FeedbackImage = {
  id: string;
  name: string;
  upload: FeedbackScreenshotUpload;
  /** An object URL for the thumbnail; revoke it when the image is dropped. */
  previewUrl: string;
};

export type ScreenCapture =
  | { kind: "ok"; blob: Blob }
  /** The person declined the browser's share prompt. */
  | { kind: "cancelled" }
  | { kind: "failed" };

/** How this app can take a screenshot: its own window, the browser tab, or not at all. */
export function screenCaptureKind(): "window" | "tab" | null {
  if (desktopCapability("captureWindow")?.captureWindow) return "window";
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    !/Android|iPhone|iPad|iPod/u.test(navigator.userAgent)
  )
    return "tab";
  return null;
}

/** Resolves after the browser has painted twice, so a closed dialog is really gone. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Resolves once nothing matches `selector` (an exit animation finished and the
 * element unmounted) and that is painted, or after `timeoutMs`.
 */
export function untilGone(selector: string, timeoutMs = 1000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (document.querySelector(selector) && performance.now() < deadline) {
        requestAnimationFrame(check);
        return;
      }
      void afterPaint().then(resolve);
    };
    check();
  });
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: contentType });
}

/** Chrome hints: offer this tab first and leave whole screens and audio out. */
const DISPLAY_MEDIA_OPTIONS = {
  video: { displaySurface: "browser" },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: "include",
  surfaceSwitching: "exclude",
  monitorTypeSurfaces: "exclude",
} as DisplayMediaStreamOptions;

async function captureTab(): Promise<ScreenCapture> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
  } catch (error) {
    return error instanceof DOMException && error.name === "NotAllowedError"
      ? { kind: "cancelled" }
      : { kind: "failed" };
  }
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Tab capture sends a frame only when the page changes; give the share
    // prompt's own repaint a moment to settle, but never wait on a still page.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return { kind: "failed" };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? { kind: "ok", blob } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

/**
 * A still of what the person sees. Call it from a click (browsers allow tab
 * capture only right after one), with your own dialog already out of the way.
 */
export async function captureScreen(): Promise<ScreenCapture> {
  const kind = screenCaptureKind();
  if (kind === "window") {
    try {
      const shot = await desktopBridge?.captureWindow?.();
      return shot
        ? { kind: "ok", blob: base64ToBlob(shot.base64, shot.contentType) }
        : { kind: "failed" };
    } catch {
      return { kind: "failed" };
    }
  }
  if (kind === "tab") return await captureTab();
  return { kind: "failed" };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * An image ready to send: scaled to at most 2400px on its longest side and
 * encoded as JPEG under the server's size limit. Null when it can't be read.
 */
export async function prepareFeedbackImage(
  blob: Blob,
  name: string,
): Promise<FeedbackImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      // JPEG has no transparency: paint it on white rather than black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encoded = await encode(canvas, attempt < 2 ? 0.86 : 0.75);
      if (encoded && encoded.size <= FEEDBACK_SCREENSHOT_MAX_BYTES) {
        return {
          id: crypto.randomUUID(),
          name,
          upload: { contentType: "image/jpeg", base64: await blobToBase64(encoded) },
          previewUrl: URL.createObjectURL(encoded),
        };
      }
      scale *= 0.75;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

function browserPlatform(): string | undefined {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad|iPod/u.test(agent)) return "ios";
  if (/Android/u.test(agent)) return "android";
  if (/Mac OS X|Macintosh/u.test(agent)) return "macos";
  if (/Windows/u.test(agent)) return "windows";
  if (/Linux|CrOS/u.test(agent)) return "linux";
  return undefined;
}

/** Browsers by user agent token, most specific first (Edge and Electron also say Chrome). */
const BROWSERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Edge", /Edg\/(\d+)/u],
  ["Firefox", /Firefox\/(\d+)/u],
  ["Electron", /Electron\/(\d+)/u],
  ["Chrome", /Chrome\/(\d+)/u],
  ["Safari", /Version\/(\d+)[.\d]* .*Safari\//u],
];

/** "Chrome 141", "Safari 26", "Firefox 145" or "Edge 141" from the user agent. */
export function browserName(agent: string): string | undefined {
  for (const [name, pattern] of BROWSERS) {
    const version = pattern.exec(agent)?.[1];
    if (version) return `${name} ${version}`;
  }
  return undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Facts about where a report was sent from: web or the desktop app, versions,
 * the page in view, browser, language, time zone, connection and recent errors.
 */
export function webFeedbackContext(server: {
  serverVersion?: string | undefined;
  deploymentRevision?: string | undefined;
}): FeedbackContext {
  const desktop = desktopBridge;
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const errors = recentErrors();
  const context: FeedbackContext = {
    source: desktop ? "desktop" : "web",
    trigger: "menu",
  };
  const platform = desktop?.platform ?? browserPlatform();
  const appVersion = desktop ? desktop.appVersion : server.serverVersion;
  const buildNumber = desktop
    ? (server.serverVersion ?? server.deploymentRevision)
    : server.deploymentRevision;
  const fields: Partial<FeedbackContext> = {
    platform: clip(platform, 32),
    appVersion: clip(appVersion, 64),
    buildNumber: clip(buildNumber, 64),
    deviceModel: clip(browserName(agent), 120),
    screen: typeof window === "undefined" ? undefined : clip(window.location.pathname, 500),
    locale: typeof navigator === "undefined" ? undefined : clip(navigator.language, 35),
    timeZone: clip(timeZone, 64),
    online: typeof navigator === "undefined" ? undefined : navigator.onLine,
    recentErrors: errors.length > 0 ? errors : undefined,
  };
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) (context as Record<string, unknown>)[key] = value;
  return context;
}
