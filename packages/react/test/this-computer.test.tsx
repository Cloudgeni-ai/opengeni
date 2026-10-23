import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createOpenGeniText } from "../src/messages/runtime";
import {
  ThisComputerCard,
  ThisComputerOffer,
  ThisComputerPanel,
  computerUseFix,
  computerUsePermissionText,
  computerUseNoticeText,
  computerUseProblemText,
  computerUseState,
  defaultThisComputerLabels,
  hostErrorText,
  ENGLISH_MAC_SYSTEM_NAMES,
  macSystemNames,
  thisComputerPermissionSteps,
  thisComputerView,
  type ComputerUseProblem,
  type ComputerUseState,
  type ThisComputerErrorCode,
  type ThisComputerStatus,
  type UseThisComputerResult,
} from "../src/this-computer";

function status(patch: Partial<ThisComputerStatus>): ThisComputerStatus {
  return { state: "not_connected", busy: false, error: null, machineName: "Kari's Mac", ...patch };
}

function computer(value: ThisComputerStatus | null): UseThisComputerResult {
  const nothing = async () => undefined;
  return {
    status: value,
    acting: false,
    actionError: null,
    canDisconnect: true,
    pending: null,
    asking: null,
    allowPermissions: () => undefined,
    refresh: () => undefined,
    connect: async () => value,
    turnOn: async () => value,
    turnOff: nothing,
    pause: nothing,
    resume: nothing,
    disconnect: nothing,
    requestPermission: nothing,
  };
}

const missing = [
  { id: "screenRecording" as const, granted: true },
  { id: "accessibility" as const, granted: false },
];

test("existing service setup explains preservation and app-independent lifetime", () => {
  const panel = renderToStaticMarkup(
    <ThisComputerPanel
      computer={computer(status({ state: "connected", management: "service" }))}
      platform="macos"
      onSetup={() => undefined}
    />,
  );
  expect(panel).toContain("Quitting this app leaves it running");
  expect(panel).toContain("Pause");
  expect(panel).not.toContain("You can also pause it from");
});

test("each state maps to one view", () => {
  expect(thisComputerView(null)).toBe("hidden");
  expect(thisComputerView(status({ state: "unavailable" }))).toBe("hidden");
  expect(thisComputerView(status({ state: "not_installed" }))).toBe("off");
  expect(thisComputerView(status({ state: "not_connected", busy: true }))).toBe("setting_up");
  expect(thisComputerView(status({ state: "connected", permissions: missing }))).toBe(
    "finish_setup",
  );
  expect(thisComputerView(status({ state: "connected" }))).toBe("ready");
  expect(thisComputerView(status({ state: "connected", reconnecting: true }))).toBe("reconnecting");
  expect(
    thisComputerView(status({ state: "connected", permissions: missing, reconnecting: true })),
  ).toBe("finish_setup");
  expect(thisComputerView(status({ state: "paused" }))).toBe("paused");
  expect(thisComputerView(status({ state: "paused", busy: true }))).toBe("resuming");
});

test("embedded products own downloads and the account handoff without a console or command fallback", () => {
  const html = renderToStaticMarkup(
    <ThisComputerCard
      productName="Acme"
      downloads={[{ label: "Download Acme", url: "https://example.com/app" }]}
      openAppUrl="acme://connect?destination=opaque"
    />,
  );
  expect(html).toContain("Download Acme");
  expect(html).toContain("acme://connect?destination=opaque");
  expect(html).toContain("Open app and connect");
  expect(html).not.toContain("curl");
  expect(html).not.toContain("app.opengeni.ai");
});

test("the offer shows only while there is something to do", () => {
  const render = (value: ThisComputerStatus | null, dismissed = false) =>
    renderToStaticMarkup(
      <ThisComputerOffer
        computer={computer(value)}
        onSetup={() => undefined}
        dismissed={dismissed}
        onDismiss={() => undefined}
      />,
    );
  expect(render(null)).toBe("");
  expect(render(status({ state: "connected" }))).toBe("");
  expect(render(status({}), true)).toBe("");
  expect(render(status({}))).toContain("Kari&#x27;s Mac");
  // Finishing the permissions and resuming stay visible after "Not now".
  expect(render(status({ state: "connected", permissions: missing }), true)).not.toBe("");
  expect(render(status({ state: "paused" }), true)).not.toBe("");
});

test("products can replace every word", () => {
  const labels = defaultThisComputerLabels();
  expect(labels.offer("Kari's Mac")).toBe("Let agents work on Kari's Mac.");
  const html = renderToStaticMarkup(
    <ThisComputerPanel
      computer={computer(status({ state: "paused" }))}
      platform="windows"
      labels={{ ...labels, resume: "Fortsett" }}
      onSetup={() => undefined}
    />,
  );
  expect(html).toContain("Fortsett");
  expect(html).toContain("tray");
});

test("the conversation card offers the desktop app where it can't host the agent", () => {
  const html = renderToStaticMarkup(
    <ThisComputerCard productName="Acme" downloadUrl="https://example.com/desktop" machines={[]} />,
  );
  expect(html).toContain("Get Acme for desktop");
  expect(html).toContain('href="https://example.com/desktop"');
});

test("host errors lose Electron's IPC prefix", () => {
  expect(
    hostErrorText(new Error("Error invoking remote method 'computer:connect': Error: Offline")),
  ).toBe("Offline");
  expect(hostErrorText("nope")).toBeNull();
});

test("input monitoring is its own step only when accessibility didn't already allow it", () => {
  const steps = (screenRecording: boolean, accessibility: boolean, inputMonitoring: boolean) =>
    thisComputerPermissionSteps(
      status({
        state: "connected",
        permissions: [
          { id: "screenRecording", granted: screenRecording },
          { id: "accessibility", granted: accessibility },
          { id: "inputMonitoring", granted: inputMonitoring },
        ],
      }),
    ).map((permission) => permission.id);
  expect(steps(false, false, false)).toEqual(["screenRecording", "accessibility"]);
  expect(steps(true, true, true)).toEqual(["screenRecording", "accessibility"]);
  expect(steps(true, true, false)).toEqual(["screenRecording", "accessibility", "inputMonitoring"]);
});

test("opening the guarded folders is the last step", () => {
  const steps = thisComputerPermissionSteps(
    status({
      state: "connected",
      permissions: [
        { id: "screenRecording", granted: true },
        { id: "accessibility", granted: true },
        { id: "inputMonitoring", granted: true },
        { id: "files", granted: false },
      ],
    }),
  ).map((permission) => permission.id);
  expect(steps).toEqual(["screenRecording", "accessibility", "files"]);
  expect(defaultThisComputerLabels().permission("files", "Acme").title).toBe(
    "Let Acme open your files",
  );
  expect(macSystemNames([]).dontAllow).toBe("Don't Allow");
  expect(macSystemNames([]).folderQuestion).toContain("{app}");
});

test("names what's on screen in the Mac's own language, English where unknown", () => {
  const french = {
    ...ENGLISH_MAC_SYSTEM_NAMES,
    openSettings: "Ouvrir Réglages Système",
    permissionList: { ...ENGLISH_MAC_SYSTEM_NAMES.permissionList, accessibility: "Accessibilité" },
  };
  const canadian = { ...french, later: "Plus tard" };
  const catalog = { fr: french, "fr-ca": canadian };
  expect(macSystemNames(["fr-FR", "en-US"], catalog).openSettings).toBe("Ouvrir Réglages Système");
  expect(macSystemNames(["fr"], catalog).permissionList.accessibility).toBe("Accessibilité");
  expect(macSystemNames(["fr_CA"], catalog).later).toBe("Plus tard");
  expect(macSystemNames(["en-US", "fr-FR"], catalog).openSettings).toBe("Open System Settings");
  expect(macSystemNames(["de-DE"], catalog).later).toBe("Later");
  expect(macSystemNames([]).permissionList.screenRecording).toBe("Screen & System Audio Recording");
});

test("the words come from the host's message catalog, English otherwise", () => {
  const french = createOpenGeniText({
    locale: "fr",
    messages: {
      "thisComputer.title": "Utiliser cet ordinateur",
      "thisComputer.ready": "Les agents peuvent utiliser {machineName}",
    },
  });
  const labels = defaultThisComputerLabels(french);
  expect(labels.title).toBe("Utiliser cet ordinateur");
  expect(labels.ready("Mac de Léa")).toBe("Les agents peuvent utiliser Mac de Léa");
  expect(labels.turnOn).toBe("Turn on");
  expect(defaultThisComputerLabels().done("Ada's Mac", "macos")).toBe(
    "Agents can now use Ada's Mac. Pause any time from the menu bar.",
  );
});

const removed = status({
  errorCode: "removed",
  error: "This computer is no longer in this workspace.",
  management: "service",
});

test("a computer removed on the server is simply off", () => {
  expect(thisComputerView(removed)).toBe("off");
  expect(thisComputerView({ ...removed, busy: true })).toBe("setting_up");
  expect(computerUseState(computer(removed))).toEqual({ kind: "off" });
  const never = computer(status({ management: "service" }));
  const panel = (value: UseThisComputerResult) =>
    renderToStaticMarkup(
      <ThisComputerPanel computer={value} platform="macos" onSetup={() => undefined} />,
    );
  const card = (value: UseThisComputerResult) =>
    renderToStaticMarkup(<ThisComputerCard computer={value} productName="Acme" />);
  // Exactly what a computer that was never set up shows.
  expect(panel(computer(removed))).toBe(panel(never));
  expect(card(computer(removed))).toBe(card(never));
  for (const html of [panel(computer(removed)), card(computer(removed))]) {
    expect(html).not.toContain("removed");
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain("Connecting");
    expect(html).not.toContain('role="alert"');
  }
});

const problem = (
  problemKind: ComputerUseProblem,
  code: ThisComputerErrorCode | null,
  detail: string | null,
): ComputerUseState => ({ kind: "problem", problem: problemKind, code, detail });

test("computer use shows one state at a time", () => {
  const use = (value: ThisComputerStatus | null, extra: Partial<UseThisComputerResult> = {}) =>
    computerUseState({ ...computer(value), ...extra });
  expect(use(null)).toEqual({ kind: "hidden" });
  expect(use(status({ state: "unavailable" }))).toEqual({ kind: "hidden" });
  // Off looks the same however it got there.
  for (const off of [
    status({}),
    status({ state: "not_installed" }),
    status({ state: "paused" }),
    removed,
  ]) {
    expect(use(off)).toEqual({ kind: "off" });
  }
  expect(use(status({}), { pending: "on" })).toEqual({
    kind: "turning_on",
    progress: null,
    asking: null,
  });
  expect(use(status({ busy: true, setupProgress: 0.4 }))).toEqual({
    kind: "turning_on",
    progress: 0.4,
    asking: null,
  });
  expect(use(status({ state: "connected", reconnecting: true }))).toEqual({
    kind: "turning_on",
    progress: null,
    asking: null,
  });
  expect(use(status({ state: "connected" }))).toEqual({ kind: "on" });
  // Turning it off shows off at once; pausing elsewhere doesn't flash "turning on".
  expect(use(status({ state: "connected" }), { pending: "off" })).toEqual({ kind: "off" });
  expect(use(status({ state: "connected", busy: true }))).toEqual({ kind: "on" });
  // Asking the system for a permission is still turning on, one state.
  expect(
    use(status({ state: "connected", permissions: missing }), { asking: "accessibility" }),
  ).toEqual({
    kind: "turning_on",
    progress: null,
    asking: "accessibility",
  });
  // Not given (yet): calm, never a problem; it names the app the grant goes to.
  expect(use(status({ state: "connected", permissions: missing }))).toEqual({
    kind: "needs_permission",
    appName: null,
  });
  expect(
    use(status({ state: "connected", permissions: missing, permissionAppName: "Opengeni Agent" })),
  ).toEqual({ kind: "needs_permission", appName: "Opengeni Agent" });
  // A real failure still wins over a missing permission.
  expect(
    use(status({ state: "connected", permissions: missing, errorCode: "offline", error: "x" })),
  ).toEqual(problem("offline", "offline", "x"));
});

test("each problem keeps its meaning, and only an unreachable server is offline", () => {
  const use = (patch: Partial<ThisComputerStatus>) =>
    computerUseState(computer(status({ state: "connected", reconnecting: true, ...patch })));
  expect(use({ errorCode: "offline", error: "fetch failed" })).toEqual(
    problem("offline", "offline", "fetch failed"),
  );
  expect(use({ errorCode: "signed_out", error: "Sign in again." })).toEqual(
    problem("signed_out", "signed_out", "Sign in again."),
  );
  const server = use({ errorCode: "unknown", error: "API 503: unavailable" });
  expect(server).toEqual(problem("error", "unknown", "API 503: unavailable"));
  const failedConnect = computerUseState(
    computer(status({ errorCode: "connect_failed", error: "Couldn't let agents use it: denied" })),
  );
  expect(failedConnect).toEqual(
    problem("error", "connect_failed", "Couldn't let agents use it: denied"),
  );
  // A failed action without the host's reason is still a problem, not off.
  expect(computerUseState({ ...computer(status({})), actionError: "boom" })).toEqual(
    problem("error", null, "boom"),
  );

  const t = createOpenGeniText();
  const labels = defaultThisComputerLabels();
  const text = (state: ReturnType<typeof computerUseState>) =>
    computerUseProblemText(state as never, "Kari's Mac", t, labels);
  expect(text(server)).toBe("API 503: unavailable");
  expect(text(server)).not.toContain("internet");
  expect(text(use({ errorCode: "offline", error: "x" }))).toContain("Couldn't reach the server");
  expect(text(use({ errorCode: "signed_out", error: "x" }))).toBe(
    "Sign in again to let agents use Kari's Mac.",
  );
  expect(text(problem("error", null, null) as never)).toBe("Computer use couldn't turn on.");
  expect(computerUseNoticeText({ kind: "turning_on", progress: null, asking: null }, t)).toBe(
    "Turning on computer use…",
  );
  expect(computerUseNoticeText({ kind: "needs_permission", appName: null }, t)).toBe(
    "Allow screen access for computer use",
  );
  expect(computerUsePermissionText("Opengeni", t)).toBe(
    "To let agents see and control the screen, allow Opengeni in System Settings.",
  );
  expect(computerUseNoticeText(server as never, t)).toBe("Computer use isn't working");
  // One fix each.
  expect(computerUseFix("permission")).toBe("open_settings");
  expect(computerUseFix("signed_out")).toBe("sign_in");
  expect(computerUseFix("offline")).toBe("try_again");
  expect(computerUseFix("error")).toBe("try_again");
});

test("a connection the app can't verify says why, and only a network failure says offline", () => {
  const labels = defaultThisComputerLabels();
  expect(labels.error("offline", "x")).toContain("Couldn't reach the server");
  expect(labels.error("removed", "x")).toBe("This computer is no longer in this workspace.");
  expect(labels.error("signed_out", "x")).toContain("Sign in again");
  expect(labels.error("unknown", "Couldn't check this computer's connection: API 503")).toBe(
    "Couldn't check this computer's connection: API 503",
  );
  const signedOut = renderToStaticMarkup(
    <ThisComputerPanel
      computer={computer(
        status({
          state: "connected",
          management: "service",
          reconnecting: true,
          errorCode: "signed_out",
          error: "Sign in again to check this computer's connection.",
        }),
      )}
      platform="macos"
      onSetup={() => undefined}
    />,
  );
  expect(signedOut).toContain("Turning on Kari&#x27;s Mac");
  expect(signedOut).toContain("Sign in again");
  expect(signedOut).not.toContain("Couldn&#x27;t reach");
});
