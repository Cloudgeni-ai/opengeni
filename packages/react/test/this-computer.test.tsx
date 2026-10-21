import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createOpenGeniText } from "../src/messages/runtime";
import {
  ThisComputerCard,
  ThisComputerOffer,
  ThisComputerPanel,
  defaultThisComputerLabels,
  hostErrorText,
  ENGLISH_MAC_SYSTEM_NAMES,
  macSystemNames,
  thisComputerPermissionSteps,
  thisComputerView,
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
    refresh: () => undefined,
    connect: async () => value,
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
  const offered = computer(status({ management: "service" }));
  const card = renderToStaticMarkup(<ThisComputerCard computer={offered} productName="Acme" />);
  expect(card).toContain("installation and permissions stay in place");
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
