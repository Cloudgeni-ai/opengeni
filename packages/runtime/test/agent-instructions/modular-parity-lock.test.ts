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
 */
const LOCKED: Record<string, string> = {
  "all/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/docker": "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all/selfhosted": "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all/markdown/none": "32275:702cdefdeadae2e49b128133362663472aea5b212ed12971f9a84d94d1d19e28",
  "all/markdown/docker": "35699:6c8bfbb2eab30fc495e216c3eb0b453fc551047670cacfbbec55ac4fccc1e197",
  "all/markdown/selfhosted":
    "37226:5b1405cf89bf78d28d9500797016f8c29fb0e8933eac2071dcd87cb121423d20",
  "all/unattended/none": "33806:d7f132d59e616755bb7ba49f1dce63927f4ba09323c68a9a8b2bc93d9036ec68",
  "all/unattended/docker": "38293:761e0725607bb2f1e5456f216031975d8f3ef6abb67cd5bb9f687a62844d19c8",
  "all/unattended/selfhosted":
    "39967:4dd0eb34c5af0ce48085d3723071c04db15d180dff6a650d8a7c00f251fdedc7",
  "all/secret-references/none":
    "34951:8d947f1b66720ce494aaee0dc3db4903b240508c235806d9391a4b0965d3bdd3",
  "all/secret-references/docker":
    "39438:55a95d906a3d2519cdf68b64efc4640c5427345e502fba32df6e3782f514d909",
  "all/secret-references/selfhosted":
    "41112:7348eff63ff4de19d7682ee00fe33c63ca46323ea9ee6b8ebe2fbfbb9e40320d",
  "all/skills-read/none": "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all/skills-read/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all/skills-read/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all/identity/none": "33119:c82124fe501819d36c58958d745831617440a93fe5be9332a22119d95595ff94",
  "all/identity/docker": "37606:d0f1ba7a4cc6a8046687da56a1c7ec8e53ba86a00c4890738ca417ed5fdada45",
  "all/identity/selfhosted":
    "39280:3ccf91dad0793297958d3e346c2991cbadec53232e580e474918806ab35194eb",
  "all-without-humanInput/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-humanInput/docker":
    "37732:d02fb981c35fd213941ccc745782aaf883a7659e57ee6b88c0e7b784f1d057fb",
  "all-without-humanInput/selfhosted":
    "39406:78664e5c57a1df88186a78bfb70167bf2d7cd354543cb82874c6464801d5cab4",
  "all-without-notifications/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-notifications/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all-without-notifications/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all-without-media/none":
    "32480:cbb59d57850ab8875d4b172b3c0ef5a292b4a45fa2d98ee2e5820f4f2734f47a",
  "all-without-media/docker":
    "36967:25892cf234e0b9a8d4d99fdf7971a62cdc3f7a691d77a654e5395223ba3d1416",
  "all-without-media/selfhosted":
    "38641:4e09fb7ad79707c393f033dbd4673b37dd541bbeee1c6a0ed5653d639752b524",
  "all-without-subagents/none":
    "27030:96ae28374a38730e353eebe5ccbe8d32ece8ff90f51e31254c65db88d1a8d142",
  "all-without-subagents/docker":
    "31437:ec86591ecbb6b5bfe3188c432d499a035b106035032c877a71e6bbd3762e2662",
  "all-without-subagents/selfhosted":
    "33111:2db334d175df26309c9522111bbefe7b6d2f1540132cb2909e398b79349797ce",
  "all-without-schedules/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-schedules/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all-without-schedules/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all-without-browser/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-browser/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all-without-browser/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all-without-secrets/none":
    "33245:895b43f847ebb64b9543b2f3b51891c6d98d32b822fbc6c0c99dfc66850229db",
  "all-without-secrets/docker":
    "37732:d02fb981c35fd213941ccc745782aaf883a7659e57ee6b88c0e7b784f1d057fb",
  "all-without-secrets/selfhosted":
    "39406:78664e5c57a1df88186a78bfb70167bf2d7cd354543cb82874c6464801d5cab4",
  "all-without-knowledge/none":
    "30986:5f859e8fd446aa4a1ec1b309259b8fd905b872c295c7dac763e96b7938a9437f",
  "all-without-knowledge/docker":
    "35473:79bb9aa89321ebfdf812942135d310c7a4bf5580f1c2b6b4d669478c0bee2752",
  "all-without-knowledge/selfhosted":
    "37147:d799c76bcd8a5f5e1159975c0686da40e307ac483466ad7744b15c129e97bf40",
  "all-without-workspaceFiles/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceFiles/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all-without-workspaceFiles/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all-without-workspaceConnectors/none":
    "33399:df282f2185182985f997d4ca829b4c6ce88ce1dd91061cd6fe1e184a63cded56",
  "all-without-workspaceConnectors/docker":
    "37886:6670ee335dd4150bbcc6ff375ed05c1ffb179ad05cc01a259fb4f9faf559af6f",
  "all-without-workspaceConnectors/selfhosted":
    "39560:6eb4e45f8da0ae8491791654261177418778e934d0ba3df46af963821ddb338a",
  "all-without-workspaceAdmin/none":
    "32080:dbf76a5409f4b00968c8dae230074a026d42cad9bad573a3bf1a15e5e74f5e30",
  "all-without-workspaceAdmin/docker":
    "36567:e96a9cc49629467e8a066ae4f9a9a94a34a861f90fae6f52bb9c09135ac456d3",
  "all-without-workspaceAdmin/selfhosted":
    "38241:26150155301e92c6561bcceb4b489355057d3b27108eaa4f271d478f58c78547",
  "none-with-features/docker":
    "29199:cfe6ea4930a20c9a32c0eca4863ec539fd934d3faef4a98dd06f42b4ff1560a4",
  "none-with-features/selfhosted":
    "30873:e737983dbac4a91fbc847dd354262913313177b64bc73b990bb8567e506cdc89",
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
        { artifacts: false, workspaceAdmin: false },
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
