import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { noneAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions, type BuildAgentOptions } from "../../src/index";
import { MODULAR_PARITY_CASES, PARITY_SETTINGS } from "./modular-parity-cases";

/**
 * `length:sha256` of each case, recorded from the composer before the
 * pay-for-what-is-relevant gates. A session with every gated feature present
 * must keep these bytes; only a reviewed instruction change updates them.
 */
const LOCKED: Record<string, string> = {
  "all/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/docker": "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all/selfhosted": "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all/markdown/none": "32275:702cdefdeadae2e49b128133362663472aea5b212ed12971f9a84d94d1d19e28",
  "all/markdown/docker": "35500:bd0db010437549b28e959b4c7a431e20cfc42a7fa042d45f48d3951b9067aa38",
  "all/markdown/selfhosted":
    "37027:68c0d7d52c95af8f00091d5aa6c9ae328b13c03ce56caf6e6cb8799a143c4873",
  "all/unattended/none": "33806:d7f132d59e616755bb7ba49f1dce63927f4ba09323c68a9a8b2bc93d9036ec68",
  "all/unattended/docker": "38094:8eba9ccee3edd55c25b69e6d65b792bf54c18b8aab6efe59b5112c564c24959a",
  "all/unattended/selfhosted":
    "39768:1763d77f82d74da7b08f4b56e27d98e7f865ec0e95d7dedc9b524246956956ed",
  "all/secret-references/none":
    "34951:8d947f1b66720ce494aaee0dc3db4903b240508c235806d9391a4b0965d3bdd3",
  "all/secret-references/docker":
    "39239:62110a8d7807b05874e49675bfaf3c16ea71687c94410a15dc4b341d407f3119",
  "all/secret-references/selfhosted":
    "40913:1e8bb532e0afb3d7804e616601484e2f22add148688daef41c6f30db719cea0a",
  "all/skills-read/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/skills-read/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all/skills-read/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all/identity/none": "33119:c82124fe501819d36c58958d745831617440a93fe5be9332a22119d95595ff94",
  "all/identity/docker": "37407:91472eace05011bccd5c934bb36f1fb3451861a694c4e87b1af61e064c3c1fe3",
  "all/identity/selfhosted":
    "39081:72c908af08819ce4c562701e73f3d002f1f704185e86f93d60a6b819abdacb06",
  "all-without-humanInput/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-humanInput/docker":
    "37533:70032b9dcb2ca75debfb5c689250272cfc4719b0b09d477b08d488625505acfd",
  "all-without-humanInput/selfhosted":
    "39207:12a1b67f4c3f8001963a67d329fc5bab60a133278111f2913dbbe33de48b1b85",
  "all-without-notifications/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-notifications/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all-without-notifications/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all-without-media/none":
    "32480:cbb59d57850ab8875d4b172b3c0ef5a292b4a45fa2d98ee2e5820f4f2734f47a",
  "all-without-media/docker":
    "36768:80d2f9fd5a615bdd6d6541758ce91b180f3bb4b998c40a270abecb77c9bf6d0c",
  "all-without-media/selfhosted":
    "38442:d6f6768b1e72ede353407bce16077a7dabaac88ea82683283d56a3d460958a7b",
  "all-without-subagents/none":
    "27030:96ae28374a38730e353eebe5ccbe8d32ece8ff90f51e31254c65db88d1a8d142",
  "all-without-subagents/docker":
    "31238:cfa2c4760cd5f97969e956cc34e382b40f9ed5b1791564389eb1e9dd990bf4c8",
  "all-without-subagents/selfhosted":
    "32912:b217693e31e85fd548b89809946bc406e3cd3ed3fb6e744e7baf7a00fa50c9b4",
  "all-without-schedules/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-schedules/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all-without-schedules/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all-without-browser/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-browser/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all-without-browser/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all-without-artifacts/none":
    "29941:054c9782053b330510aba3b3142c9ded783bc190bfa2379fa2ee7180a7049dca",
  "all-without-artifacts/docker":
    "34229:2366f9609c8195b864e6c78c1dc771ba62510832dc5235fcda9499076aea05bf",
  "all-without-artifacts/selfhosted":
    "35903:2f5386ae9530530d99ba6dd5fc49a77a4be264eaafdff3317b4b6c334a6c9eec",
  "all-without-secrets/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-secrets/docker":
    "37533:70032b9dcb2ca75debfb5c689250272cfc4719b0b09d477b08d488625505acfd",
  "all-without-secrets/selfhosted":
    "39207:12a1b67f4c3f8001963a67d329fc5bab60a133278111f2913dbbe33de48b1b85",
  "all-without-knowledge/none":
    "30986:5f859e8fd446aa4a1ec1b309259b8fd905b872c295c7dac763e96b7938a9437f",
  "all-without-knowledge/docker":
    "35274:f74882d902a23939872d6f41d3342e7e41c031f35a246ed2fcaa583f3d59f2cb",
  "all-without-knowledge/selfhosted":
    "36948:bf2a28d01540a4f5bd5d7b92dd729053c77eaced0bf4ca69f0e85c429450f88e",
  "all-without-workspaceFiles/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceFiles/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all-without-workspaceFiles/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all-without-workspaceConnectors/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceConnectors/docker":
    "37687:40228ae2a4408e18cc98fb5ec2858ff3fa2e4eb2e093bfee0658f542022c0bbc",
  "all-without-workspaceConnectors/selfhosted":
    "39361:26b61bf3e024fd76b9ddf9414ec6f34d54da2157dae2f9218647474d2121448e",
  "all-without-workspaceAdmin/none":
    "32080:dbf76a5409f4b00968c8dae230074a026d42cad9bad573a3bf1a15e5e74f5e30",
  "all-without-workspaceAdmin/docker":
    "36368:baeda20f0f277ef25fb1b9b78a2fd95777cbee0d2b96c569b98cda8dda2feded",
  "all-without-workspaceAdmin/selfhosted":
    "38042:9f71180aa11e78e3c9365e1d2f216debb7cf225e2b703e46f35d25be9ff4cbef",
  "none-with-features/docker":
    "25542:ac2b464e5d372d5e0020cbd9f32ee96af97e7ea05906aa63552a8bb546eb3c28",
  "none-with-features/selfhosted":
    "27216:a586abd084290d41bc8b623bbc7b92a19848d87a364bbfa235e237cda6346f6a",
  "none-with-features-and-workspace/none":
    "24792:928b7aeea9c26b8ae12147059d841844baaedf187fddaf4a03397d950c9bd00b",
  "none-with-features-manage/none":
    "20086:9185dc67c51c07d48671cd98ebd2c388a1a6b5e6cde0299841c2a670f31b85e7",
};

function digest(options: BuildAgentOptions): string {
  const composed = inspectPersistentAgentInstructions(
    testSettings(PARITY_SETTINGS),
    options,
  ).composed;
  return `${composed.length}:${createHash("sha256").update(composed).digest("hex")}`;
}

function render(options: BuildAgentOptions): string {
  return inspectPersistentAgentInstructions(testSettings(PARITY_SETTINGS), options).composed;
}

/** Every word of `smaller` appears in `larger`, in order: text was only removed. */
function isWordSubsequence(smaller: string, larger: string): boolean {
  const big = larger.split(/\s+/);
  let index = 0;
  for (const line of smaller.split(/\s+/)) {
    while (index < big.length && big[index] !== line) index += 1;
    if (index === big.length) return false;
    index += 1;
  }
  return true;
}

describe("configured sessions with every gated feature keep their bytes", () => {
  test("the case matrix is the locked one", () => {
    expect(Object.keys(MODULAR_PARITY_CASES).sort()).toEqual(Object.keys(LOCKED).sort());
  });
  for (const [name, options] of Object.entries(MODULAR_PARITY_CASES)) {
    test(name, () => {
      expect(digest(options)).toBe(LOCKED[name]!);
    });
  }
});

describe("an absent feature only omits its own text", () => {
  const base = MODULAR_PARITY_CASES["none-with-features/docker"]!;
  const config = base.agentConfig as ResolvedAgentConfig;
  const without = (
    capabilities: Partial<ResolvedAgentConfig["capabilities"]>,
    extra: BuildAgentOptions = {},
  ): BuildAgentOptions => ({
    ...base,
    agentConfig: { ...config, capabilities: { ...config.capabilities, ...capabilities } },
    ...extra,
  });
  // Each variant drops one feature; `gone` is text that must leave with it.
  // Goals and waiting already had their own alternate wording before these
  // gates, so for them the check is the gated text alone.
  const variants: Record<string, { options: BuildAgentOptions; gone: string[]; pure: boolean }> = {
    webSearch: { options: without({ webSearch: false }), gone: ["Web searches take"], pure: true },
    learning: { options: without({ knowledge: false }), gone: ["learning"], pure: true },
    privacyFacts: {
      options: without({ privacyFacts: false }),
      gone: ["only from `privacy_facts`"],
      pure: true,
    },
    toolSearch: {
      options: without(
        {},
        { agentPromptToolAvailability: { unavailable: [], toolSearchAbsent: true } },
      ),
      gone: ["## Tool discovery"],
      pure: true,
    },
    sandbox: {
      options: without({}, { activeSandboxBackend: "none" }),
      gone: ["Decide the design before building it."],
      pure: true,
    },
    skillIndex: {
      options: without({}, { skillCatalog: [] }),
      gone: ["# Using skills"],
      pure: true,
    },
    goals: {
      options: without({ goals: false }),
      gone: ["Always retain the full completion audit"],
      pure: false,
    },
    waitForInput: {
      options: without({}, { agentPromptToolAvailability: { unavailable: ["wait_for_input"] } }),
      gone: ["## Waiting", "Monitor or wait:"],
      pure: false,
    },
    everything: {
      options: {
        agentConfig: { ...config, capabilities: noneAgentCapabilities() },
        activeSandboxBackend: "none",
        skillCatalog: [],
        agentPromptToolAvailability: { unavailable: ["wait_for_input"], toolSearchAbsent: true },
      },
      gone: [
        "## Tool discovery",
        "## Waiting",
        "# Using skills",
        "only from `privacy_facts`",
        "Web searches take",
        "Decide the design before building it.",
        "share one workspace",
      ],
      pure: false,
    },
  };
  const full = render(base);
  // Kept for every agent, whatever it can do.
  const universal = ["# Destructive Actions", "## Final answer", "## Match effort to the request"];
  for (const [name, variant] of Object.entries(variants)) {
    test(name, () => {
      const smaller = render(variant.options);
      expect(smaller.length).toBeLessThan(full.length);
      for (const text of variant.gone) {
        expect(full).toContain(text);
        expect(smaller).not.toContain(text);
      }
      for (const text of universal) expect(smaller).toContain(text);
      // The identity slot may switch to the neutral default; the rest only shrinks.
      const body = (text: string) => text.slice(text.indexOf("\n# "));
      if (variant.pure) expect(isWordSubsequence(body(smaller), body(full))).toBe(true);
    });
  }
});

describe("tool discovery follows the router", () => {
  const options = MODULAR_PARITY_CASES["all/none"]!;
  test("no router without a transport or with tool search off", () => {
    expect(render(options)).toContain("## Tool discovery");
    const off = inspectPersistentAgentInstructions(
      testSettings({ lazyToolSearchEnabled: false }),
      options,
    );
    expect(off.composed).not.toContain("## Tool discovery");
    const { lazyToolTransport: _transport, ...withoutTransport } = options;
    expect(render(withoutTransport)).not.toContain("## Tool discovery");
  });
  test("a router already in history keeps its guidance", () => {
    const { lazyToolTransport: _transport, ...withoutTransport } = options;
    const kept = inspectPersistentAgentInstructions(
      testSettings({ lazyToolSearchEnabled: false }),
      {
        ...withoutTransport,
        toolRouterInHistory: true,
      },
    );
    expect(kept.composed).toContain("## Tool discovery");
  });
});
