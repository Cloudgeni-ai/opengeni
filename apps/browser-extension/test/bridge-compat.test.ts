import { afterEach, describe, expect, test } from "bun:test";
import {
  assertReleasedAgentSupports,
  bridgeCompatProblems,
  currentProtocol,
  latestAgentRelease,
  nativeHostScheme,
  readBridgeCompat,
  type BridgeCompat,
  type BridgeProtocol,
} from "../scripts/bridge-compat";
import { BRIDGE_PROTOCOL_VERSION, nativeHostName } from "../src/protocol";

const extensionId = "dddddddddddddddddddddddddddddddd";
const globals = globalThis as { __EXTENSION_BRANDED__?: boolean };

afterEach(() => {
  delete globals.__EXTENSION_BRANDED__;
});

function hostScheme(branded: boolean) {
  globals.__EXTENSION_BRANDED__ = branded;
  return nativeHostScheme(nativeHostName(extensionId), extensionId);
}

const replacement: BridgeProtocol = {
  id: "new",
  build: "opengeni",
  bridgeProtocolVersion: 2,
  nativeHost: "shared",
  minimumAgent: "0.2.0",
  releasedOn: "2027-01-01",
};
const old: BridgeProtocol = {
  id: "old",
  build: "opengeni",
  bridgeProtocolVersion: 1,
  nativeHost: "shared",
  minimumAgent: "0.1.0",
  releasedOn: "2026-01-01",
};
const record = (...protocols: BridgeProtocol[]): BridgeCompat => ({ protocols });

describe("extension and agent compatibility record", () => {
  test("is valid", () => {
    expect(bridgeCompatProblems(readBridgeCompat())).toEqual([]);
  });

  test("lists the protocol each build of this extension uses", () => {
    const compat = readBridgeCompat();
    for (const branded of [false, true]) {
      const scheme = hostScheme(branded);
      expect(scheme).not.toBeNull();
      const protocol = currentProtocol(
        compat,
        branded ? "branded" : "opengeni",
        BRIDGE_PROTOCOL_VERSION,
        scheme!,
      );
      // A change to how the extension reaches the agent needs a new entry
      // (and an agent that supports it) before it can be released.
      expect(protocol, `${branded ? "branded" : "opengeni"} ${scheme}`).not.toBeNull();
    }
  });

  test("retires a protocol only once its replacement has been out for 60 days", () => {
    expect(
      bridgeCompatProblems(
        record({ ...old, retiredOn: "2027-02-01", retiredBy: "new" }, replacement),
      ),
    ).toEqual([
      "old can be retired from 2027-03-02, 60 days after new was released: until then installed extensions still use it",
    ]);
    expect(
      bridgeCompatProblems(
        record({ ...old, retiredOn: "2027-03-02", retiredBy: "new" }, replacement),
      ),
    ).toEqual([]);
  });

  test("a retirement names its current replacement for the same build", () => {
    for (const protocols of [
      [{ ...old, retiredOn: "2027-06-01" }, replacement],
      [
        { ...old, retiredOn: "2027-06-01", retiredBy: "new" },
        { ...replacement, build: "branded" as const },
      ],
      [{ ...old, retiredOn: "2027-06-01", retiredBy: "missing" }, replacement],
    ]) {
      expect(bridgeCompatProblems(record(...protocols))).toEqual([
        "old must name in retiredBy the current protocol of the same build that replaced it",
      ]);
    }
  });

  test("only the protocol retired before this rule may skip the waiting time", () => {
    expect(
      bridgeCompatProblems(
        record(
          { ...old, retiredOn: "2027-01-02", retiredBy: "new", retiredBeforeThisRule: true },
          replacement,
        ),
      ),
    ).toEqual(["old cannot be retired before this rule; it postdates it"]);
  });

  test("a retired protocol is no longer the current one", () => {
    const compat = record({ ...old, retiredOn: "2027-03-02", retiredBy: "new" }, replacement);
    expect(currentProtocol(compat, "opengeni", 1, "shared")).toBeNull();
    expect(currentProtocol(compat, "opengeni", 2, "shared")?.id).toBe("new");
  });
});

describe("store release gate", () => {
  function releases(pages: { tag_name: string; draft?: boolean; prerelease?: boolean }[][]) {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    };
    return { fetch, urls };
  }

  test("finds the newest published agent release", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ tag_name: `agent-v0.1.${index}` }));
    const { fetch, urls } = releases([
      full,
      [
        { tag_name: "agent-v0.1.200", draft: true },
        { tag_name: "agent-v0.1.199", prerelease: true },
        { tag_name: "agent-v0.1.150" },
        { tag_name: "v9.9.9" },
      ],
    ]);
    expect(await latestAgentRelease({ fetch, repository: "owner/repo" })).toBe("0.1.150");
    expect(urls).toHaveLength(2);
  });

  test("refuses an extension whose protocol no released agent supports", () => {
    expect(() => assertReleasedAgentSupports(replacement, "0.1.171")).toThrow(
      "This extension needs agent 0.2.0 or newer (new), but the newest released agent is 0.1.171.",
    );
    expect(() => assertReleasedAgentSupports(replacement, "0.2.0")).not.toThrow();
    expect(() => assertReleasedAgentSupports(old, "0.10.0")).not.toThrow();
  });
});
