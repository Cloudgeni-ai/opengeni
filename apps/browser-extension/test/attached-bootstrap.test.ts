import { expect, test } from "bun:test";
import { AttachedChromeCdpConnection } from "../../../packages/browserd/src/attached-cdp";
import { attachedTab } from "../src/protocol";

test("blank CDP bootstrap stays discoverable through the installed extension policy", async () => {
  const tab = (id: number, url: string) =>
    attachedTab({ id, windowId: 1, index: id, url, active: false } as chrome.tabs.Tab)!;
  const existing = [
    tab(1, "https://example.com/user-work"),
    tab(2, "about:blank"),
    tab(3, "chrome://settings/"),
  ];
  const inventory = [...existing];
  const attached: string[] = [];
  const connection = new AttachedChromeCdpConnection(
    {
      async request<T>(command: Readonly<Record<string, unknown>>): Promise<T> {
        if (command.type === "tabs.create") {
          const created = tab(4, String(command.url));
          inventory.push(created);
          return { tab: created } as T;
        }
        if (command.type === "tabs.list") return { tabs: inventory } as T;
        if (command.type === "debugger.attach") {
          const selected = inventory.find((candidate) => candidate.id === command.tabId);
          if (!selected?.controllable) throw new Error("extension rejects this target");
          attached.push(selected.id);
          return { attached: true } as T;
        }
        if (command.type === "debugger.poll")
          return { events: [], cursor: 0, truncated: false } as T;
        if (command.type === "debugger.detach") return { detached: true } as T;
        throw new Error(`unexpected command: ${command.type}`);
      },
      close() {},
    },
    { browserName: "Chrome", browserVersion: "151" },
  );
  try {
    const created = await connection.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const listed = await connection.send<{ targetInfos: Array<{ targetId: string; url: string }> }>(
      "Target.getTargets",
    );
    expect(listed.targetInfos.some((target) => target.targetId === created.targetId)).toBe(true);
    await connection.send("Target.attachToTarget", { targetId: created.targetId });
    expect(attached).toEqual(["4"]);
    expect(inventory.slice(0, 3)).toEqual(existing);
    expect(listed.targetInfos.map((target) => target.targetId)).toEqual(["1", "4"]);
  } finally {
    await connection.shutdown();
  }
});
