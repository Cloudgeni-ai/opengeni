import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  agentReleaseAssetUrl,
  agentWorkspaceVersion,
  createPublishedAgentReleases,
  httpAgentReleaseProbe,
  sourceTreeAgentVersion,
  stableAgentVersion,
  type AgentReleaseAvailability,
} from "../src/sandbox/agent-release";
import { promotedAgentVersion } from "../src/sandbox/machines";

describe("the stable agent release", () => {
  test("reads the agent workspace version every agent release is tagged from", () => {
    const manifest = [
      "[workspace]",
      'members = ["crates/*"]',
      "",
      "[workspace.package]",
      'version = "0.2.7"',
      'edition = "2021"',
      "",
      "[workspace.dependencies]",
      'serde = { version = "1.0.1" }',
    ].join("\n");
    expect(agentWorkspaceVersion(manifest)).toBe("0.2.7");
    expect(agentWorkspaceVersion('[package]\nversion = "1.0.0"\n')).toBeNull();
    expect(agentWorkspaceVersion('[workspace.package]\nversion = "1.0.0-rc.1"\n')).toBeNull();
  });

  test("is the operator's pin when set, otherwise this source tree's agent release", async () => {
    const cargo = await readFile(new URL("../../../agent/Cargo.toml", import.meta.url), "utf8");
    const ownRelease = agentWorkspaceVersion(cargo);
    expect(ownRelease).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(sourceTreeAgentVersion()).toBe(ownRelease!);
    expect(stableAgentVersion({ agentStableVersion: undefined })).toBe(ownRelease!);
    expect(stableAgentVersion({ agentStableVersion: "1.4.2" })).toBe("1.4.2");
    // Machines on either channel are promoted to it unless beta is pinned.
    const unpinned = { agentStableVersion: undefined, agentBetaVersion: undefined };
    expect(promotedAgentVersion(unpinned, "stable")).toBe(ownRelease!);
    expect(promotedAgentVersion(unpinned, "beta")).toBe(ownRelease!);
    expect(promotedAgentVersion({ ...unpinned, agentBetaVersion: "9.0.0" }, "beta")).toBe("9.0.0");
  });

  test("is unknown, not an older default, when neither a pin nor the source tree names one", () => {
    const withoutSourceTree = () => null;
    expect(stableAgentVersion({ agentStableVersion: undefined }, withoutSourceTree)).toBeNull();
    expect(stableAgentVersion({ agentStableVersion: "1.4.2" }, withoutSourceTree)).toBe("1.4.2");
  });
});

const RELEASES = "https://github.com/Cloudgeni-ai/opengeni/releases";
const unpinned = {
  agentStableVersion: undefined,
  agentBetaVersion: undefined,
  agentReleasesBaseUrl: RELEASES,
};

function probeOf(published: Record<string, AgentReleaseAvailability>) {
  const asked: string[] = [];
  return {
    asked,
    probe: async (version: string): Promise<AgentReleaseAvailability> => {
      asked.push(version);
      return published[version] ?? "missing";
    },
  };
}

describe("the agent release an update targets", () => {
  test("the source tree's release before it is published: the newest published one below it", async () => {
    // Main raises the agent version when a change lands; the release
    // workflow publishes it later. An update must never name it before then.
    const { asked, probe } = probeOf({ "0.1.150": "published", "0.1.149": "published" });
    const releases = createPublishedAgentReleases(unpinned, {
      probe,
      sourceTree: () => "0.1.152",
    });
    expect(await releases.resolve("stable")).toBe("0.1.150");
    expect(await releases.resolve("beta")).toBe("0.1.150");
    expect(asked).toEqual(["0.1.152", "0.1.151", "0.1.150"]);
  });

  test("the source tree's release once its manifest exists", async () => {
    const { probe } = probeOf({ "0.1.152": "published" });
    const releases = createPublishedAgentReleases(unpinned, {
      probe,
      sourceTree: () => "0.1.152",
    });
    expect(await releases.resolve("stable")).toBe("0.1.152");
  });

  test("an operator's pin is the promoted release and is not looked up", async () => {
    const { asked, probe } = probeOf({});
    const pinned = createPublishedAgentReleases(
      { ...unpinned, agentStableVersion: "0.1.140", agentBetaVersion: "0.1.151" },
      { probe, sourceTree: () => "0.1.152" },
    );
    expect(await pinned.resolve("stable")).toBe("0.1.140");
    expect(await pinned.resolve(null)).toBe("0.1.140");
    expect(await pinned.resolve("beta")).toBe("0.1.151");
    expect(asked).toEqual([]);
  });

  test("nothing when the release host cannot answer, or nothing recent is published", async () => {
    const unknown = createPublishedAgentReleases(unpinned, {
      probe: probeOf({ "0.1.152": "unknown", "0.1.150": "published" }).probe,
      sourceTree: () => "0.1.152",
    });
    expect(await unknown.resolve("stable")).toBeNull();
    const { asked, probe } = probeOf({});
    const none = createPublishedAgentReleases(unpinned, { probe, sourceTree: () => "0.1.40" });
    expect(await none.resolve("stable")).toBeNull();
    // A bounded search: the release and the sixteen patch releases below it.
    expect(asked).toHaveLength(17);
    expect(asked.at(-1)).toBe("0.1.24");
    const noSource = createPublishedAgentReleases(unpinned, { probe, sourceTree: () => null });
    expect(await noSource.resolve("stable")).toBeNull();
  });

  test("a published release is remembered; a missing one is checked again later", async () => {
    let clock = 0;
    const published: Record<string, AgentReleaseAvailability> = { "0.1.150": "published" };
    const { asked, probe } = probeOf(published);
    const releases = createPublishedAgentReleases(unpinned, {
      probe,
      sourceTree: () => "0.1.151",
      now: () => clock,
    });
    expect(await releases.resolve("stable")).toBe("0.1.150");
    expect(await releases.resolve("stable")).toBe("0.1.150");
    expect(asked).toEqual(["0.1.151", "0.1.150"]);
    published["0.1.151"] = "published";
    clock += 4 * 60_000;
    expect(await releases.resolve("stable")).toBe("0.1.150");
    clock += 60_000;
    expect(await releases.resolve("stable")).toBe("0.1.151");
    expect(asked).toEqual(["0.1.151", "0.1.150", "0.1.151"]);
    // Concurrent resolutions share one check.
    const shared = probeOf({ "0.1.151": "published" });
    const concurrent = createPublishedAgentReleases(unpinned, {
      probe: shared.probe,
      sourceTree: () => "0.1.151",
    });
    await Promise.all([concurrent.resolve("stable"), concurrent.resolve("stable")]);
    expect(shared.asked).toEqual(["0.1.151"]);
  });

  test("asks the release host for the manifest the agent downloads", async () => {
    expect(
      agentReleaseAssetUrl({ agentReleasesBaseUrl: `${RELEASES}/` }, "0.1.152", "manifest.json"),
    ).toBe(`${RELEASES}/download/agent-v0.1.152/manifest.json`);
    const requests: Array<{
      url: string;
      method: string | undefined;
      redirect: string | undefined;
    }> = [];
    const answering = (status: number | Error) =>
      httpAgentReleaseProbe({ agentReleasesBaseUrl: RELEASES }, (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests.push({ url: String(url), method: init?.method, redirect: init?.redirect });
        if (status instanceof Error) throw status;
        return new Response(null, { status });
      }) as typeof fetch);
    expect(await answering(200)("0.1.152")).toBe("published");
    expect(await answering(404)("0.1.152")).toBe("missing");
    expect(await answering(410)("0.1.152")).toBe("missing");
    expect(await answering(503)("0.1.152")).toBe("unknown");
    expect(await answering(new TypeError("network down"))("0.1.152")).toBe("unknown");
    expect(requests[0]).toEqual({
      url: `${RELEASES}/download/agent-v0.1.152/manifest.json`,
      method: "HEAD",
      redirect: "follow",
    });
  });
});
