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
 * Every case lost the wait rules that the `wait_for_input` description now
 * states once (the prompt changelog); nothing else changed.
 * The cases without compute (`/none`) later lost the sandbox-only text of the
 * documents, files and session-coordination guidance (the prompt changelog).
 * Every locked case has goals on, so every case with a sandbox or Connected
 * Machine kept its bytes; a session with compute but without goals gets the
 * goal-free verification rule (compose.test.ts).
 * Cases with workspace connectors but without workspace admin later gained
 * the short "# Integration setup" section for the Connect card tool, which
 * now comes with workspace connectors too (the prompt changelog); nothing
 * else changed.
 * Every case with documents later called Sites apps (the prompt changelog);
 * nothing else changed.
 */
const LOCKED: Record<string, string> = {
  "all/none": "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all/docker": "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all/selfhosted": "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all/markdown/none": "29767:8dc4e5a7a9174dbe85782475639a9c716b7fee8ec60486333431aefdeb1a90d7",
  "all/markdown/docker": "33953:f4d76feb8356569eb5e21854a0f810dc10c69f86f7238b641edc99c5e4ce910f",
  "all/markdown/selfhosted":
    "35480:34d0ff611479941930464268416eac05b418292d6663548b6d6d22e8e3892c99",
  "all/unattended/none": "31148:d4774ffd88ac4013f1401ea4f57de5889246c016847d6e3883e7607c246c4d4a",
  "all/unattended/docker": "36547:0530698b09e46c5f50676fbcb8ba5c870f31970536ce3f9c4c2eabd43bb3a109",
  "all/unattended/selfhosted":
    "38221:58c0a3f07851fc894d9a452cca908c5af2319991d50e8f6e3af10dc664956695",
  "all/secret-references/none":
    "32362:62e038ba264bb0b3440480e5769038a23a439e42f8432e92b947d6ef086ad332",
  "all/secret-references/docker":
    "37761:305a478d7548309cc7f725cd3f773d720cf2a82a21c1c9358bea456b53a60a27",
  "all/secret-references/selfhosted":
    "39435:f3f925336ea977457f8abf137fb811ac61a9942115d8369c4f03d13183780019",
  "all/skills-read/none": "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all/skills-read/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all/skills-read/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all/identity/none": "30461:f04c2eaea52648dfde1c6c0b783c3d7bdbe45f62ff460fec96dd8bd4cd035baa",
  "all/identity/docker": "35860:ee78b4d4e76b670181265f773a4af0990e1fd756f2db7d1f7def956fd36568bb",
  "all/identity/selfhosted":
    "37534:4a3001c0294d591296f66c22b7aee96663f38ea8923053f59557d5fb4e800077",
  "all-without-humanInput/none":
    "30587:10ac2307cdc043cc5bbdd5a79a5cadc1d64a6e21ab96e6ba367203719d0aba72",
  "all-without-humanInput/docker":
    "35986:92c8b5dbb841068396687c65147237b1df75bd14d4a76eff5a48630dc9f740a1",
  "all-without-humanInput/selfhosted":
    "37660:76c2d681a415419cff592354f827ddc61837118eb790d8b1f05377560b520994",
  "all-without-notifications/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-notifications/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all-without-notifications/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all-without-media/none":
    "29844:12ab00f3514e75e6e865731757f56e2357d6609e793fc52d3a81e39214907645",
  "all-without-media/docker":
    "35221:19df7c8af0eb3e609cd55db76c28a8798ef0139f8f28a22251b13a857cb7c915",
  "all-without-media/selfhosted":
    "36895:28baff4ba65e0e9ac0a02330072d94e7075258f7289c9fa31ecdb6e9e6bd2262",
  "all-without-subagents/none":
    "24421:f33f9d6b4bd2dcc0a5fdbdfe311730de13375db25baf8765dacb302ed79cd95e",
  "all-without-subagents/docker":
    "29677:4c6cd182a75b335cf09f32a66d04e62603ac6ea5c0b64ee7d1ee4e0c72e24d41",
  "all-without-subagents/selfhosted":
    "31351:ea4adaa8e21b23faea608214538781f3c6baef6fe37cce0e9b10ac7ae57e4b30",
  "all-without-schedules/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-schedules/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all-without-schedules/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all-without-browser/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-browser/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all-without-browser/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all-without-secrets/none":
    "30587:10ac2307cdc043cc5bbdd5a79a5cadc1d64a6e21ab96e6ba367203719d0aba72",
  "all-without-secrets/docker":
    "35986:92c8b5dbb841068396687c65147237b1df75bd14d4a76eff5a48630dc9f740a1",
  "all-without-secrets/selfhosted":
    "37660:76c2d681a415419cff592354f827ddc61837118eb790d8b1f05377560b520994",
  "all-without-knowledge/none":
    "28328:e5c24c3998a87f6e0e6a6784c0a6f39f5b19b2df6e5f03605f4da8ea8a2d0684",
  "all-without-knowledge/docker":
    "33727:c3dce05f3dbea963ade16d9c839e19de6c1412a7a7b97fb5eb4749041412c8d7",
  "all-without-knowledge/selfhosted":
    "35401:85f02df19e880555568eb6d4609ec7a536dd269f2913638d9a8edaba33dbc5ed",
  "all-without-workspaceFiles/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-workspaceFiles/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all-without-workspaceFiles/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all-without-workspaceConnectors/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-workspaceConnectors/docker":
    "36140:f35a887141fd10434f6c81b759903a397a4844aec82d55057304e6e6aafc036c",
  "all-without-workspaceConnectors/selfhosted":
    "37814:fbba94b20c1351d252335ecd04395c290a15ed2aa0175595c06390eeafabb37e",
  "all-without-workspaceAdmin/none":
    "29899:31d6d3add77f08ba8b909694e65e55b4f28eed001498a8a244ed37f21abe1c4e",
  "all-without-workspaceAdmin/docker":
    "35298:ecba9294a58fcb30aa1c3bb6aa247cb572d66d7d8f2109b0ecc32254802ca2fd",
  "all-without-workspaceAdmin/selfhosted":
    "36972:b46d00af39b459a3e5931ebd9a5bcadca362b6931307b3cd552e0d73d85aff34",
  "none-with-features/docker":
    "27757:9a74258ccf1c164172fef8254a89f14fb26d17d19ddf8df99be64f6ca76bb526",
  "none-with-features/selfhosted":
    "29431:55242f60b82379d14459dadc1cef1258e54be6b3469ec16ad78d74172cef022c",
  "none-with-features-and-workspace/none":
    "22523:24b669fa6ed785fe242cb4c3e707c90c6fbbf51a5d707b77c0e576f9b1f042c1",
  "none-with-features-manage/none":
    "20798:8286f694b31180e03d6dae88ec988ad34da5b5e26fcc2a4c223668d8c6074009",
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
    agentConfig: {
      ...config,
      capabilities: { ...config.capabilities, ...capabilities },
    },
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
      gone: ["Answer in chat by default", "documents, apps, and visuals"],
      pure: false,
    },
    learning: {
      options: without({ knowledge: false }),
      gone: ["learning"],
      pure: true,
    },
    privacyFacts: {
      options: without({ privacyFacts: false }),
      gone: ["only from `privacy_facts`"],
      pure: true,
    },
    toolSearch: {
      options: without(
        {},
        {
          agentPromptToolAvailability: {
            unavailable: [],
            toolSearchAbsent: true,
          },
        },
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
      gone: ["show its setup card", "# Integration setup", "capability_authorization_request"],
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
        agentPromptToolAvailability: {
          unavailable: ["wait_for_input"],
          toolSearchAbsent: true,
        },
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
  const renderWith = (capabilities: Partial<ResolvedAgentConfig["capabilities"]>) =>
    inspectPersistentAgentInstructions(testSettings(PARITY_SETTINGS), {
      ...base,
      agentConfig: {
        ...config,
        capabilities: {
          ...config.capabilities,
          workspaceConnectors: false,
          ...capabilities,
        },
      },
    }).composed;
  test("a secret question shows one only with the question tool", () => {
    expect(renderWith({ secrets: true, humanInput: true })).toContain("show its setup card");
    expect(renderWith({ secrets: true, humanInput: false })).not.toContain("show its setup card");
    expect(renderWith({ browser: true })).toContain("show its setup card");
    expect(renderWith({})).toContain("offer the fix in the same reply with the exact next step");
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
