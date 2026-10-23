import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThisComputerStatus } from "@opengeni/sdk/this-computer";
import { ComputerUseNotice, ComputerUseRow } from "../src/app/components/desktop/computer-use";
import type { DesktopThisComputer } from "../src/app/components/desktop/this-computer";
import { defaultThisComputerLabels } from "../src/this-computer";

function desktop(
  patch: Partial<ThisComputerStatus> | null,
  extra: Partial<DesktopThisComputer["computer"]> = {},
  signIn: (() => void) | null = null,
): DesktopThisComputer {
  const nothing = async () => undefined;
  const status: ThisComputerStatus | null = patch && {
    state: "not_connected",
    busy: false,
    error: null,
    machineName: "Kari's Mac",
    ...patch,
  };
  return {
    workspaceId: "workspace",
    platform: "macos",
    productName: "Opengeni",
    labels: defaultThisComputerLabels(),
    openSetup: () => undefined,
    signIn,
    computer: {
      status,
      acting: false,
      actionError: null,
      canDisconnect: true,
      pending: null,
      refresh: () => undefined,
      connect: async () => status,
      turnOn: async () => status,
      turnOff: nothing,
      pause: nothing,
      resume: nothing,
      disconnect: nothing,
      requestPermission: nothing,
      ...extra,
    },
  };
}

const row = (value: DesktopThisComputer) =>
  renderToStaticMarkup(<ComputerUseRow desktop={value} />).replaceAll("&#x27;", "'");
const notice = (value: DesktopThisComputer) =>
  renderToStaticMarkup(<ComputerUseNotice desktop={value} />).replaceAll("&#x27;", "'");
const checked = (html: string) => /role="switch"[^>]*aria-checked="true"/u.test(html);

test("off looks the same however it got there, with the switch off and nothing else", () => {
  const never = row(desktop({}));
  expect(never).toContain("Computer use");
  expect(never).toContain("Let agents use Kari's Mac.");
  expect(checked(never)).toBe(false);
  for (const off of [
    { state: "paused" as const },
    { state: "not_installed" as const },
    { errorCode: "removed" as const, error: "This computer is no longer in this workspace." },
  ]) {
    expect(row(desktop(off))).toBe(never);
  }
  for (const word of ["onnect", "Pause", "Turn off", "Resume", "removed"]) {
    expect(never).not.toContain(word);
  }
});

test("turning on, on, and each problem with its one fix", () => {
  const turning = row(desktop({}, { pending: "on" }));
  expect(turning).toContain("Turning on…");
  expect(checked(turning)).toBe(true);
  expect(turning).not.toContain("<a");

  const on = row(desktop({ state: "connected" }));
  expect(on).toContain("Agents can use Kari's Mac");
  expect(checked(on)).toBe(true);
  expect(on.match(/<button/gu)).toHaveLength(1);

  const fixes: [Partial<ThisComputerStatus>, string, string][] = [
    [
      { state: "connected", permissions: [{ id: "accessibility", granted: false }] },
      "Agents need your permission",
      "Allow in System Settings",
    ],
    [
      { state: "connected", reconnecting: true, errorCode: "offline", error: "fetch failed" },
      "Couldn't reach the server",
      "Try again",
    ],
    [
      { state: "connected", reconnecting: true, errorCode: "unknown", error: "API 503: down" },
      "API 503: down",
      "Try again",
    ],
  ];
  for (const [patch, line, fix] of fixes) {
    const html = row(desktop(patch));
    expect(checked(html)).toBe(true);
    expect(html).toContain(line);
    expect(html).toContain(`${fix}<svg`);
    // The switch and one fix: no other buttons.
    expect(html.match(/<button/gu)).toHaveLength(2);
  }
  const signedOut = { state: "connected" as const, errorCode: "signed_out" as const, error: "x" };
  expect(row(desktop(signedOut, {}, () => undefined))).toContain("Sign in<svg");
  // Where the app can't sign in, trying again is the one way on.
  expect(row(desktop(signedOut))).toContain("Try again<svg");
});

test("the sidebar shows only while turning on or with a problem, with the same fix", () => {
  expect(notice(desktop({}))).toBe("");
  expect(notice(desktop({ state: "paused" }))).toBe("");
  expect(notice(desktop({ state: "connected" }))).toBe("");
  expect(notice(desktop(null))).toBe("");
  expect(notice(desktop({}, { pending: "on" }))).toContain("Turning on computer use…");
  const problem = notice(
    desktop({ state: "connected", reconnecting: true, errorCode: "offline", error: "x" }),
  );
  expect(problem).toContain("Computer use can't reach the server");
  expect(problem).toContain("Try again<svg");
  const permissions = notice(
    desktop({ state: "connected", permissions: [{ id: "screenRecording", granted: false }] }),
  );
  expect(permissions).toContain("Computer use needs permission");
  expect(permissions).toContain("Allow in System Settings<svg");
});
