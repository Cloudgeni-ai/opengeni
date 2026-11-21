import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { browserDevice } from "../src/components/this-computer/browser-device";
import {
  ThisComputerCard,
  defaultThisComputerLabels,
  type ThisComputerCardProps,
} from "../src/this-computer";

const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function onDevice(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, maxTouchPoints },
    configurable: true,
    writable: true,
  });
}
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
});

const macMini = {
  sandboxId: "mini",
  enrollmentId: "enr-mini",
  name: "Mac mini",
  scope: "user",
  state: "online",
  os: "macos",
};
const windowsPc = {
  ...macMini,
  sandboxId: "pc",
  enrollmentId: "enr-pc",
  name: "Desk PC",
  os: "windows",
};

function card(props: Partial<ThisComputerCardProps> = {}) {
  return renderToStaticMarkup(
    <ThisComputerCard
      productName="Acme"
      machines={[macMini] as never}
      rationale="Work in your browser on this computer."
      {...props}
    />,
  );
}

test("the browser tells a phone, a desktop system, or nothing for sure", () => {
  expect(browserDevice(WINDOWS_CHROME)).toEqual({ kind: "desktop", os: "windows" });
  expect(browserDevice(MAC_SAFARI)).toEqual({ kind: "desktop", os: "macos" });
  // An iPad asks for desktop pages as a Mac; its touch screen gives it away.
  expect(browserDevice(MAC_SAFARI, 5)).toEqual({ kind: "handheld" });
  expect(browserDevice(IPHONE)).toEqual({ kind: "handheld" });
  expect(browserDevice("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
    kind: "desktop",
    os: "linux",
  });
  expect(browserDevice("Mozilla/5.0 (Linux; Android 16; Pixel 10)")).toEqual({ kind: "handheld" });
  expect(browserDevice("Mozilla/5.0 (X11; CrOS x86_64 16000.0.0)")).toBeNull();
  expect(browserDevice(undefined)).toBeNull();
});

test("a ready computer on another system is named as another computer, and the request stays open", () => {
  onDevice(WINDOWS_CHROME);
  // The host can't connect this Windows device: its own text stays.
  const bare = card();
  expect(bare).toContain("Agents can use Mac mini");
  expect(bare).toContain("Mac mini is another computer, not this one.");
  expect(bare).toContain("Install the Acme app on your computer");
  expect(bare).not.toContain("og-tc-card-check");
  expect(bare).not.toContain('data-state="complete"');
  expect(bare).not.toContain("data-complete");
  expect(bare).toContain("Work in your browser on this computer.");

  // With a connect path, connecting this device is the main action, not a
  // quiet extra beside a done card.
  const connect = card({ onConnect: async () => {} });
  expect(connect).toContain("Mac mini is another computer, not this one.");
  expect(connect).toContain("Use this computer");
  expect(connect).not.toContain("Connect another computer");
  expect(connect).not.toContain('data-state="complete"');

  const links = card({
    downloads: [{ label: "Download for Windows", url: "https://example.com/win" }],
  });
  expect(links).toContain("Download for Windows");
  expect(links).not.toContain('data-state="complete"');
});

test("a ready computer on this system completes the card when the host can connect this device", () => {
  onDevice(WINDOWS_CHROME);
  const html = card({
    machines: [macMini, windowsPc] as never,
    downloads: [{ label: "Download for Windows", url: "https://example.com/win" }],
  });
  expect(html).toContain("Agents can use Desk PC");
  expect(html).not.toContain("another computer, not this one");
  expect(html).toContain('data-state="complete"');
  expect(html).toContain("Connect another computer");
});

test("when the host can't connect this device, a ready computer doesn't look done", () => {
  onDevice(MAC_SAFARI);
  const html = card();
  // It may be this very Mac, so the card doesn't call it another one.
  expect(html).toContain("Agents can use Mac mini");
  expect(html).not.toContain("another computer, not this one");
  expect(html).toContain("Install the Acme app on your computer");
  expect(html).not.toContain('data-state="complete"');
});

test("on a phone, a ready computer is the one the person means", () => {
  onDevice(IPHONE);
  const html = card();
  expect(html).toContain("Agents can use Mac mini");
  expect(html).toContain('data-state="complete"');
  expect(html).not.toContain("another computer, not this one");
});

test("the host's own text for a device it can't connect stays beside the ready line", () => {
  onDevice(WINDOWS_CHROME);
  const labels = defaultThisComputerLabels();
  const html = card({
    labels: {
      ...labels,
      card: { ...labels.card, getApp: () => "Acme for desktop isn't available for Windows yet." },
    },
  });
  expect(html).toContain("Agents can use Mac mini");
  expect(html).toContain("Acme for desktop isn&#x27;t available for Windows yet.");
});
