import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { noneAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions, type BuildAgentOptions } from "../../src/index";
import { MODULAR_PARITY_CASES, PARITY_SETTINGS } from "./modular-parity-cases";

/**
 * `length:sha256` of each case, recorded from the composer before the
 * pay-for-what-is-relevant gates. A session with every gated feature present
 * must keep these bytes; only a reviewed instruction change updates them. The
 * "none-with-features" cases gained documents when the chat-by-default rule
 * began to follow them; their bytes come from the composer just before that.
 * They also have workspace connectors, a setup-card source, since the
 * setup-card sentence began to follow those; that added no other text.
 */
const LOCKED: Record<string, string> = {
  "all/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/docker": "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all/selfhosted": "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all/markdown/none": "32275:702cdefdeadae2e49b128133362663472aea5b212ed12971f9a84d94d1d19e28",
  "all/markdown/docker": "35684:3ecf98eb68df80b539f2c0f63518ebb1e34a3e5593338512a9de15eafb082c90",
  "all/markdown/selfhosted":
    "37211:8daa77891529bf2ea6bd160ea4027c03bc52d497a605dce007fcc0b30a2228d5",
  "all/unattended/none": "33806:d7f132d59e616755bb7ba49f1dce63927f4ba09323c68a9a8b2bc93d9036ec68",
  "all/unattended/docker": "38278:167d48142270cb4a279db7bc91925fb4fe571e488a96cb20b0fd61aae5c4ca53",
  "all/unattended/selfhosted":
    "39952:2059b1e303e3521f798c44ea05c704dd469b0cad25dad231f84efac8b48f7562",
  "all/secret-references/none":
    "34951:8d947f1b66720ce494aaee0dc3db4903b240508c235806d9391a4b0965d3bdd3",
  "all/secret-references/docker":
    "39423:0a5be6fea768597b086ca7238d2f98d0ec35ca5a485080c2db24ca8f343e8ff0",
  "all/secret-references/selfhosted":
    "41097:bd7051c4cd8c097a16af3775b6dce7e9ceacc6715a28e4dc5343eb9863f82640",
  "all/skills-read/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/skills-read/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all/skills-read/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all/identity/none": "33119:c82124fe501819d36c58958d745831617440a93fe5be9332a22119d95595ff94",
  "all/identity/docker": "37591:9c93d4e78a5a9de03d55a85a119d7007177c6ca4680dbd03dcc92df36f707ab6",
  "all/identity/selfhosted":
    "39265:a1026a89a18cd15495c3539689e9a51525c72ea5b335f4ab22d64c4e44d12bf2",
  "all-without-humanInput/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-humanInput/docker":
    "37717:775b2f579075c9c1b13567c0987af6082dd65b6c4a491d257ce7fa708aa1a5be",
  "all-without-humanInput/selfhosted":
    "39391:c962dace0e05b2daee6034612b3c4925a8db0d4e7d37aead21f660239695a9aa",
  "all-without-notifications/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-notifications/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all-without-notifications/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all-without-media/none":
    "32480:cbb59d57850ab8875d4b172b3c0ef5a292b4a45fa2d98ee2e5820f4f2734f47a",
  "all-without-media/docker":
    "36952:bd17f2fe8a56a469877515a7b35c11d742dee6ca65c1a2d6871f6d0fbffc646d",
  "all-without-media/selfhosted":
    "38626:193483bddbea98f3646b286e15028cd28bfdebd692f3af2355353ac4330bc2a3",
  "all-without-subagents/none":
    "27030:96ae28374a38730e353eebe5ccbe8d32ece8ff90f51e31254c65db88d1a8d142",
  "all-without-subagents/docker":
    "31422:8285357be001766ef067317c015bf0c925c29e0fdae2959d2d7844047dca1da7",
  "all-without-subagents/selfhosted":
    "33096:562fbda9566da562c4f836e9c9e60827ff2f981dd525175ff8545eceece5b96a",
  "all-without-schedules/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-schedules/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all-without-schedules/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all-without-browser/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-browser/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all-without-browser/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all-without-secrets/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-secrets/docker":
    "37717:775b2f579075c9c1b13567c0987af6082dd65b6c4a491d257ce7fa708aa1a5be",
  "all-without-secrets/selfhosted":
    "39391:c962dace0e05b2daee6034612b3c4925a8db0d4e7d37aead21f660239695a9aa",
  "all-without-knowledge/none":
    "30986:5f859e8fd446aa4a1ec1b309259b8fd905b872c295c7dac763e96b7938a9437f",
  "all-without-knowledge/docker":
    "35458:4bfaf013cfe28ebb93e5c5b641963f016d010413fe996721fe070749ffa77de3",
  "all-without-knowledge/selfhosted":
    "37132:66fefa46017bdec57b3bc407659e1ac2761e60365526d7df634200136438a03a",
  "all-without-workspaceFiles/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceFiles/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all-without-workspaceFiles/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all-without-workspaceConnectors/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceConnectors/docker":
    "37871:a165b835e352d4f88563d23c070ecdf635796f8ebc9f44e398d447d3e8255834",
  "all-without-workspaceConnectors/selfhosted":
    "39545:5fab0a93b6fa1cbbce919085cff441d562795326236f54d433bd0a2b22542808",
  "all-without-workspaceAdmin/none":
    "32080:dbf76a5409f4b00968c8dae230074a026d42cad9bad573a3bf1a15e5e74f5e30",
  "all-without-workspaceAdmin/docker":
    "36552:94a408ed4346aaf78f6f58f061515b5d414fb486ce2f090fb4a5099e40db0090",
  "all-without-workspaceAdmin/selfhosted":
    "38226:47f4606dceef6d89e631df73da01131b64b1fedd78b272b32eb20e5b3e5ae4f3",
  "none-with-features/docker":
    "29184:c695043c9cb6009bfca4a9538ceab125e654624c7cc7be94dd336f7365fcb393",
  "none-with-features/selfhosted":
    "30858:c26f383f3709f9cb47350b3402241316ba302695a7d9da8b48306342ed861b92",
  "none-with-features-and-workspace/none":
    "24792:928b7aeea9c26b8ae12147059d841844baaedf187fddaf4a03397d950c9bd00b",
  "none-with-features-manage/none":
    "23544:930b980ffffbd967d6ac3d3e94a9a49fe4b8908015852a09d0f76051a8681883",
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
    webSearch: {
      options: without({ webSearch: false }),
      gone: ["Web searches take", "link the source next to each study or figure you cite"],
      pure: true,
    },
    artifacts: {
      options: without({ artifacts: false }),
      gone: ["Answer in chat by default", "documents, Sites, and visuals"],
      pure: false,
    },
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
    build: {
      options: without(
        { artifacts: false, workspaceAdmin: false, workspaceConnectors: false },
        { activeSandboxBackend: "none" },
      ),
      gone: ["Decide the design before building it."],
      pure: false,
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
    // The base case's only setup-card source is workspace connectors.
    setupCards: {
      options: without({ workspaceConnectors: false }),
      gone: ["show its setup card"],
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
        "link the source next to each study or figure you cite",
        "Answer in chat by default",
        "show its setup card",
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

describe("the setup-card sentence follows capabilities that show a card", () => {
  const base = MODULAR_PARITY_CASES["none-with-features/docker"]!;
  const config = base.agentConfig as ResolvedAgentConfig;
  const render = (capabilities: Partial<ResolvedAgentConfig["capabilities"]>) =>
    inspectPersistentAgentInstructions(testSettings(PARITY_SETTINGS), {
      ...base,
      agentConfig: {
        ...config,
        capabilities: { ...config.capabilities, workspaceConnectors: false, ...capabilities },
      },
    }).composed;
  test("a secret question shows one only with the question tool", () => {
    expect(render({ secrets: true, humanInput: true })).toContain("show its setup card");
    expect(render({ secrets: true, humanInput: false })).not.toContain("show its setup card");
    expect(render({ browser: true })).toContain("show its setup card");
    expect(render({})).toContain("offer the fix in the same reply with the exact next step");
  });
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
