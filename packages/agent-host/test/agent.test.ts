import { describe, expect, test } from "bun:test";

import {
  connectionFor,
  hostedAgentPath,
  lastErrorLine,
  parseAgentVersion,
  parseConnections,
  parsePermissions,
  standaloneMacAgentApp,
} from "../src/agent-cli";
import { HostedAgent, RESTART_EXIT_CODE, type AgentChild } from "../src/hosted-agent";

describe("agent command line", () => {
  test("keeps the agent where the command line expects it", () => {
    expect(hostedAgentPath("darwin", "/Users/user", {})).toBe(
      "/Users/user/.local/bin/opengeni-agent",
    );
    expect(hostedAgentPath("linux", "/home/user", {})).toBe("/home/user/.local/bin/opengeni-agent");
    expect(hostedAgentPath("win32", "C:\\Users\\user", {})).toBe(
      "C:\\Users\\user\\AppData\\Local\\Opengeni\\bin\\opengeni-agent.exe",
    );
    expect(hostedAgentPath("win32", "C:\\Users\\user", { LOCALAPPDATA: "D:\\Local" })).toBe(
      "D:\\Local\\Opengeni\\bin\\opengeni-agent.exe",
    );
    expect(standaloneMacAgentApp("/Users/user")).toBe(
      "/Users/user/Applications/OpenGeni Agent.app",
    );
  });

  test("reads the agent's version", () => {
    expect(parseAgentVersion("opengeni-agent 0.1.65\n")).toBe("0.1.65");
    expect(parseAgentVersion("something else")).toBeNull();
  });

  test("reads the screen-control permissions", () => {
    expect(
      parsePermissions(
        'note\n{"required":true,"screenRecording":true,"accessibility":false,"inputMonitoring":true}\n',
      ),
    ).toEqual({
      required: true,
      granted: { screenRecording: true, accessibility: false, inputMonitoring: true },
    });
    expect(parsePermissions('{"required":false}')).toEqual({ required: false });
    expect(parsePermissions("error: unrecognized subcommand 'permissions'")).toBeNull();
    expect(parsePermissions('{"required":true,"screenRecording":true}')).toBeNull();
  });

  test("parses connections and matches the server and workspace", () => {
    const output = [
      "Configured Opengeni connections (2):",
      "  c1  https://App.Example.com  workspace=w1  agent=a1",
      "  c2  https://old.example (legacy origin unverified; reconnect once to confirm)  workspace=w2  agent=a2",
    ].join("\n");
    const connections = parseConnections(output);
    expect(connections).toEqual([
      { connectionId: "c1", apiUrl: "https://app.example.com", workspaceId: "w1", agentId: "a1" },
      { connectionId: "c2", apiUrl: "https://old.example", workspaceId: "w2", agentId: "a2" },
    ]);
    expect(connectionFor(connections, "https://app.example.com/", "w1")?.connectionId).toBe("c1");
    expect(connectionFor(connections, "https://app.example.com", "w2")).toBeNull();
    expect(
      parseConnections("No Opengeni connections configured. Run `opengeni-agent connect`."),
    ).toEqual([]);
  });

  test("keeps the last meaningful error line", () => {
    expect(lastErrorLine("\u001b[31merror: enroll token expired\u001b[0m\n\n")).toBe(
      "enroll token expired",
    );
    expect(lastErrorLine("   \n")).toBeNull();
    expect(
      lastErrorLine(
        "opengeni-install: installing x (version: latest)\nopengeni-install: ERROR: failed to download https://h/a : timed out\nopengeni-install: cleaning up\n",
      ),
    ).toBe("failed to download https://h/a : timed out");
    expect(lastErrorLine("opengeni-install: downloading binary + checksum + signature\n")).toBe(
      "downloading binary + checksum + signature",
    );
  });
});

describe("the app's agent", () => {
  class FakeChild implements AgentChild {
    private listeners: ((code: number | null) => void)[] = [];
    constructor(readonly pid: number) {}
    onExit(listener: (code: number | null) => void): void {
      this.listeners.push(listener);
    }
    exit(code: number | null): void {
      for (const listener of this.listeners.splice(0)) listener(code);
    }
  }

  function harness() {
    let clock = 0;
    let nextPid = 1;
    const children: FakeChild[] = [];
    const timers: { at: number; run: () => void }[] = [];
    const agent = new HostedAgent({
      spawn: () => {
        const child = new FakeChild(nextPid++);
        children.push(child);
        return child;
      },
      terminate: async (child) => (child as FakeChild).exit(null),
      now: () => clock,
      setTimer: (run, ms) => {
        const timer = { at: clock + ms, run };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        const index = timers.indexOf(handle as (typeof timers)[number]);
        if (index >= 0) timers.splice(index, 1);
      },
      onChange: () => undefined,
    });
    const advance = (ms: number) => {
      clock += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    };
    return { agent, children, timers, advance };
  }

  test("starts again at once after an update asks for it", () => {
    const { agent, children, advance } = harness();
    agent.start("https://app.example.com");
    advance(10_000);
    children[0]!.exit(RESTART_EXIT_CODE);
    expect(children).toHaveLength(2);
    expect(agent.state).toBe("running");
  });

  test("backs off after crashes and resets after a healthy run", () => {
    const { agent, children, timers, advance } = harness();
    agent.start("https://app.example.com");
    advance(6_000);
    children[0]!.exit(1);
    expect(agent.state).toBe("restarting");
    expect(timers[0]!.at).toBe(7_000);
    advance(1_000);
    advance(6_000);
    children[1]!.exit(1);
    expect(timers[0]!.at).toBe(15_000);
    advance(2_000);
    advance(120_000);
    children[2]!.exit(1);
    expect(timers[0]!.at - 135_000).toBe(1_000);
  });

  test("waits politely when another agent already serves this computer", () => {
    const { agent, children, timers, advance } = harness();
    agent.start("https://app.example.com");
    advance(100);
    children[0]!.exit(0);
    expect(agent.state).toBe("elsewhere");
    expect(timers[0]!.at).toBe(30_100);
  });

  test("stays stopped once stopped, and restarts on request", async () => {
    const { agent, children, timers } = harness();
    agent.start("https://app.example.com");
    await agent.restart();
    expect(children).toHaveLength(2);
    await agent.stop();
    expect(agent.state).toBe("stopped");
    expect(timers).toHaveLength(0);
    await agent.restart();
    expect(children).toHaveLength(2);
  });
});
