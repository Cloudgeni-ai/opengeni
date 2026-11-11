import { describe, expect, test } from "bun:test";
import type { DesktopComputerCapabilities, ThisComputerStatus } from "@opengeni/sdk/desktop-bridge";

import {
  foldersAllowed,
  foldersHaveOwnAction,
  missingPermissionNames,
  missingScreenPermissions,
  screenControlInEffect,
  screenControlView,
} from "./this-computer-settings";

const connected: ThisComputerStatus = {
  state: "connected",
  busy: false,
  error: null,
  machineName: "Bendik's MacBook",
  enrollmentId: "enrollment-1",
  permissions: [
    { id: "screenRecording", granted: true },
    { id: "accessibility", granted: false },
    { id: "inputMonitoring", granted: false },
    { id: "files", granted: false },
  ],
};

function capabilities(
  change: Partial<Omit<DesktopComputerCapabilities, "settings">> & {
    settings?: Partial<DesktopComputerCapabilities["settings"]>;
  } = {},
): DesktopComputerCapabilities {
  return {
    microphone: "notDetermined",
    unavailable: [],
    screenControlConnected: true,
    ...change,
    settings: { screenControl: true, browserExtension: true, microphone: true, ...change.settings },
  };
}

describe("the Control the screen row", () => {
  test("applies only while Computer use is on", () => {
    expect(screenControlView(null, capabilities())).toEqual({ kind: "computerUseOff" });
    for (const state of ["not_connected", "paused", "not_installed"] as const) {
      expect(screenControlView({ ...connected, state }, capabilities()).kind).toBe(
        "computerUseOff",
      );
    }
  });

  test("on: the screen permissions in order, without the folders", () => {
    const view = screenControlView(connected, capabilities());
    expect(view).toEqual({
      kind: "on",
      permissions: [
        { id: "screenRecording", granted: true },
        { id: "accessibility", granted: false },
        { id: "inputMonitoring", granted: false },
      ],
    });
  });

  test("off when the person turned it off, or the connection has no screen control", () => {
    expect(
      screenControlView(connected, capabilities({ settings: { screenControl: false } })).kind,
    ).toBe("off");
    expect(screenControlView(connected, capabilities({ screenControlConnected: false })).kind).toBe(
      "off",
    );
  });

  test("a separately installed agent service can't be switched from the app", () => {
    expect(screenControlView({ ...connected, management: "service" }, capabilities()).kind).toBe(
      "managedElsewhere",
    );
    expect(
      screenControlView(connected, capabilities({ unavailable: ["screenControl"] })).kind,
    ).toBe("managedElsewhere");
  });

  test("an older app without switches shows what the connection allows", () => {
    expect(screenControlView({ ...connected, permissions: undefined }, null)).toEqual({
      kind: "on",
      permissions: [],
    });
  });

  test("what's missing follows the steps: Input Monitoring once Accessibility is allowed", () => {
    expect(missingScreenPermissions(connected)).toEqual([{ id: "accessibility", granted: false }]);
    const accessibilityAllowed: ThisComputerStatus = {
      ...connected,
      permissions: connected.permissions!.map((permission) =>
        permission.id === "accessibility" ? { ...permission, granted: true } : permission,
      ),
    };
    expect(missingScreenPermissions(accessibilityAllowed)).toEqual([
      { id: "inputMonitoring", granted: false },
    ]);
    // The folders are their own row.
    expect(
      missingScreenPermissions({
        ...connected,
        permissions: [
          { id: "screenRecording", granted: true },
          { id: "files", granted: false },
        ],
      }),
    ).toEqual([]);
    expect(missingScreenPermissions(null)).toEqual([]);
  });

  test("a switch the app can't change shows what is in effect", () => {
    const managed = { kind: "managedElsewhere" } as const;
    expect(screenControlInEffect(managed, capabilities())).toBe(true);
    expect(screenControlInEffect(managed, capabilities({ screenControlConnected: false }))).toBe(
      false,
    );
    expect(screenControlInEffect({ kind: "off" }, capabilities())).toBe(false);
    expect(screenControlInEffect({ kind: "on", permissions: [] }, null)).toBe(true);
  });

  test("what's missing is named in one line, as System Settings lists it", () => {
    expect(missingPermissionNames(connected.permissions!)).toBe(
      "Accessibility and Input Monitoring",
    );
    expect(
      missingPermissionNames([
        { id: "screenRecording", granted: false },
        { id: "accessibility", granted: false },
        { id: "inputMonitoring", granted: false },
      ]),
    ).toBe("Screen Recording, Accessibility and Input Monitoring");
    expect(missingPermissionNames([{ id: "accessibility", granted: false }])).toBe("Accessibility");
    expect(missingPermissionNames([{ id: "accessibility", granted: true }])).toBe("");
  });
});

describe("the Desktop, Documents and Downloads row", () => {
  test("reads the folders from the screen list, or on their own while screen control is off", () => {
    expect(foldersAllowed(connected)).toBe(false);
    expect(foldersAllowed({ ...connected, permissions: undefined, folders: true })).toBe(true);
    expect(foldersAllowed({ ...connected, permissions: undefined })).toBeNull();
    expect(foldersAllowed({ ...connected, state: "paused" })).toBeNull();
  });
});

describe("the one action for a missing permission", () => {
  test("the folders have their own Allow only while the Computer use row offers no fix", () => {
    // Screen permissions or the folders missing: the Computer use row's one button asks for them.
    expect(foldersHaveOwnAction(connected)).toBe(false);
    expect(
      foldersHaveOwnAction({
        ...connected,
        permissions: connected.permissions!.map((permission) =>
          permission.id === "files" ? permission : { ...permission, granted: true },
        ),
      }),
    ).toBe(false);
    // Screen control off: the folders are reported on their own, with their own Allow.
    expect(foldersHaveOwnAction({ ...connected, permissions: undefined, folders: false })).toBe(
      true,
    );
  });
});
