import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComputerCapabilities,
  ComputerSettingsStore,
  ComputerSettingsUnreadable,
  DEFAULT_COMPUTER_SETTINGS,
  MICROPHONE_SETTINGS_URL,
  OUTDATED_AGENT_PROBLEM,
  UNREADABLE_COMPUTER_SETTINGS,
  UNREADABLE_PROBLEM,
  UNSAVED_PROBLEM,
  mergeComputerSettings,
  microphonePermission,
  type ComputerCapabilitiesDeps,
} from "../src/main/computer-capabilities";
import type { DesktopComputerSettings } from "../src/contract";

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "og-computer-capabilities-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function capabilities(
  overrides: Partial<ComputerCapabilitiesDeps> & { saved?: Partial<DesktopComputerSettings> } = {},
) {
  let saved: DesktopComputerSettings = { ...DEFAULT_COMPUTER_SETTINGS, ...overrides.saved };
  const events = { agent: 0, changes: 0, asked: 0, opened: [] as string[] };
  let microphone = "not-determined";
  const deps: ComputerCapabilitiesDeps = {
    platform: "darwin",
    store: {
      read: () => ({ ...saved }),
      write: (settings) => {
        saved = settings;
      },
    },
    microphoneStatus: () => microphone,
    askForMicrophone: async () => {
      events.asked += 1;
      microphone = "granted";
      return true;
    },
    openSystemSettings: (url) => events.opened.push(url),
    agentSwitchesChanged: async () => {
      events.agent += 1;
    },
    unavailable: () => [],
    screenControlConnected: () => true,
    onChange: () => {
      events.changes += 1;
    },
    ...overrides,
  };
  return {
    capabilities: new ComputerCapabilities(deps),
    events,
    saved: () => saved,
    setMicrophone: (value: string) => {
      microphone = value;
    },
  };
}

describe("what Opengeni may do on this computer", () => {
  test("everything starts on, so nothing that worked before stops", () => {
    withDir((dir) => {
      expect(new ComputerSettingsStore(dir).read()).toEqual({
        screenControl: true,
        browserExtension: true,
        microphone: true,
      });
    });
  });

  test("the switches are kept between launches", () => {
    withDir((dir) => {
      const store = new ComputerSettingsStore(dir);
      store.write({ screenControl: false, browserExtension: true, microphone: false });
      expect(new ComputerSettingsStore(dir).read()).toEqual({
        screenControl: false,
        browserExtension: true,
        microphone: false,
      });
      expect(JSON.parse(readFileSync(join(dir, "computer-capabilities.json"), "utf8"))).toEqual({
        screenControl: false,
        browserExtension: true,
        microphone: false,
      });
    });
  });

  test("a damaged file is kept, copied aside and refused until a save replaces it", () => {
    withDir((dir) => {
      const file = join(dir, "computer-capabilities.json");
      writeFileSync(file, "{not json");
      expect(() => new ComputerSettingsStore(dir).read()).toThrow(ComputerSettingsUnreadable);
      expect(readFileSync(`${file}.corrupt`, "utf8")).toBe("{not json");
      // The next launch still refuses it, so it never turns back into everything on.
      expect(existsSync(file)).toBe(true);
      expect(() => new ComputerSettingsStore(dir).read()).toThrow(ComputerSettingsUnreadable);
      new ComputerSettingsStore(dir).write(UNREADABLE_COMPUTER_SETTINGS);
      expect(new ComputerSettingsStore(dir).read()).toEqual(UNREADABLE_COMPUTER_SETTINGS);
    });
  });

  test("a file that can't be read is refused too", () => {
    withDir((dir) => {
      // A folder where the file should be: reading fails with something other than ENOENT.
      mkdirSync(join(dir, "computer-capabilities.json"));
      expect(() => new ComputerSettingsStore(dir).read()).toThrow(ComputerSettingsUnreadable);
    });
  });

  test("unreadable switches count as off, and each row says why", async () => {
    const { capabilities: caps } = capabilities({
      store: {
        read: () => {
          throw new ComputerSettingsUnreadable("damaged");
        },
        write: () => undefined,
      },
    });
    expect(caps.current).toEqual(UNREADABLE_COMPUTER_SETTINGS);
    const status = await caps.status();
    expect(status.problems).toEqual({
      screenControl: UNREADABLE_PROBLEM,
      browserExtension: UNREADABLE_PROBLEM,
      microphone: UNREADABLE_PROBLEM,
    });
    // Turning one on again clears its note only.
    const after = await caps.update({ microphone: true });
    expect(after.problems?.microphone).toBeUndefined();
    expect(after.problems?.screenControl).toBe(UNREADABLE_PROBLEM);
  });

  test("a change keeps the current value for anything that isn't a switch", () => {
    const current = { screenControl: true, browserExtension: true, microphone: true };
    expect(
      mergeComputerSettings(current, { screenControl: false, microphone: "no", other: false }),
    ).toEqual({ screenControl: false, browserExtension: true, microphone: true });
    expect(mergeComputerSettings(current, null)).toEqual(current);
    expect(mergeComputerSettings(current, "off")).toEqual(current);
  });

  test("turning the screen or the bridge off restarts the agent; the microphone doesn't", async () => {
    const { capabilities: caps, events, saved } = capabilities();
    await caps.update({ screenControl: false });
    expect(saved().screenControl).toBe(false);
    expect(caps.current.screenControl).toBe(false);
    expect(events.agent).toBe(1);
    await caps.update({ microphone: false });
    expect(events.agent).toBe(1);
    expect(events.changes).toBe(2);
    // The same value again changes nothing.
    await caps.update({ microphone: false, screenControl: false });
    expect(events).toMatchObject({ agent: 1, changes: 2 });
    await caps.update({ browserExtension: false });
    expect(events.agent).toBe(2);
  });

  test("the answer comes after the agent restarted; a failed restart shows on its row", async () => {
    let finished = false;
    const { capabilities: caps } = capabilities({
      agentSwitchesChanged: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
        throw new Error("The agent didn't stop.");
      },
    });
    const after = await caps.update({ screenControl: false });
    expect(finished).toBe(true);
    expect(after.settings.screenControl).toBe(false);
    expect(after.problems?.screenControl).toBe(
      "Couldn't restart the agent with this change. The agent didn't stop.",
    );
    expect(after.problems?.browserExtension).toBeUndefined();
  });

  test("a change that can't be saved still applies for this run, and says so", async () => {
    const { capabilities: caps } = capabilities({
      store: {
        read: () => ({ ...DEFAULT_COMPUTER_SETTINGS }),
        write: () => {
          throw new Error("read-only");
        },
      },
    });
    const after = await caps.update({ microphone: false });
    expect(after.settings.microphone).toBe(false);
    expect(after.problems).toEqual({ microphone: UNSAVED_PROBLEM });
  });

  test("the status says what the system answered and what the app can't switch", async () => {
    const { capabilities: caps } = capabilities({
      unavailable: () => ["screenControl", "browserExtension"],
      screenControlConnected: () => false,
    });
    expect(await caps.status()).toEqual({
      settings: DEFAULT_COMPUTER_SETTINGS,
      microphone: "notDetermined",
      unavailable: ["screenControl", "browserExtension"],
      screenControlConnected: false,
      problems: {},
    });
  });

  test("an agent too old to honour the screen switch makes it unavailable", async () => {
    const older = capabilities({ screenControlSwitch: async () => false });
    const status = await older.capabilities.status();
    expect(status.unavailable).toEqual(["screenControl"]);
    expect(status.problems?.screenControl).toBe(OUTDATED_AGENT_PROBLEM);

    for (const answer of [true, null]) {
      const current = capabilities({ screenControlSwitch: async () => answer });
      expect((await current.capabilities.status()).unavailable).toEqual([]);
    }
    const failing = capabilities({
      screenControlSwitch: () => Promise.reject(new Error("no agent")),
    });
    expect((await failing.capabilities.status()).unavailable).toEqual([]);
  });

  test("switches that can't be switched say why when the app knows", async () => {
    const { capabilities: caps } = capabilities({
      unavailable: () => ["screenControl", "browserExtension"],
      unavailableReason: () => "Another Opengeni agent is serving this computer.",
    });
    expect((await caps.status()).problems).toEqual({
      screenControl: "Another Opengeni agent is serving this computer.",
      browserExtension: "Another Opengeni agent is serving this computer.",
    });
  });

  test("a change to a switch that doesn't apply now is ignored, and nothing restarts", async () => {
    const elsewhere = capabilities({ unavailable: () => ["screenControl", "browserExtension"] });
    const status = await elsewhere.capabilities.update({
      screenControl: false,
      browserExtension: false,
      microphone: false,
    });
    expect(status.settings).toEqual({
      screenControl: true,
      browserExtension: true,
      microphone: false,
    });
    expect(elsewhere.saved().screenControl).toBe(true);
    expect(elsewhere.events.agent).toBe(0);

    const older = capabilities({ screenControlSwitch: async () => false });
    await older.capabilities.update({ screenControl: false });
    expect(older.saved().screenControl).toBe(true);
    expect(older.events.agent).toBe(0);
  });
});

describe("the microphone", () => {
  test("maps the system's answers, and has none on Linux", () => {
    expect(microphonePermission("darwin", "granted")).toBe("granted");
    expect(microphonePermission("darwin", "denied")).toBe("denied");
    expect(microphonePermission("darwin", "restricted")).toBe("denied");
    expect(microphonePermission("win32", "not-determined")).toBe("notDetermined");
    expect(microphonePermission("darwin", "unexpected")).toBe("unknown");
    expect(microphonePermission("linux", "granted")).toBe("unknown");
  });

  test("turning it on asks macOS while it hasn't answered", async () => {
    const { capabilities: caps, events } = capabilities({ saved: { microphone: false } });
    const after = await caps.requestMicrophone();
    expect(after.settings.microphone).toBe(true);
    expect(after.microphone).toBe("granted");
    expect(events.asked).toBe(1);
    expect(events.opened).toEqual([]);
  });

  test("once refused, its page in System Settings opens instead", async () => {
    const { capabilities: caps, events, setMicrophone } = capabilities();
    setMicrophone("denied");
    await caps.requestMicrophone();
    expect(events.asked).toBe(0);
    expect(events.opened).toEqual([MICROPHONE_SETTINGS_URL.darwin!]);
  });

  test("on Windows a refusal opens its privacy settings; Linux has nothing to open", async () => {
    const windows = capabilities({ platform: "win32" });
    windows.setMicrophone("denied");
    await windows.capabilities.requestMicrophone();
    expect(windows.events.opened).toEqual(["ms-settings:privacy-microphone"]);

    const linux = capabilities({ platform: "linux" });
    await linux.capabilities.requestMicrophone();
    expect(linux.events.opened).toEqual([]);
    expect(linux.events.asked).toBe(0);
  });

  test("a system that can't answer leaves the status unknown", async () => {
    const { capabilities: caps } = capabilities({
      microphoneStatus: () => {
        throw new Error("no media access API");
      },
    });
    expect((await caps.status()).microphone).toBe("unknown");
  });
});
