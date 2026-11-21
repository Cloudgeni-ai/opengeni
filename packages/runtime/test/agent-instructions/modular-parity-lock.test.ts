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
  "all/docker": "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all/selfhosted": "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all/markdown/none": "29767:8dc4e5a7a9174dbe85782475639a9c716b7fee8ec60486333431aefdeb1a90d7",
  "all/markdown/docker": "33831:f5f89c38f693fb12227e6faf8caa1e595926dd9e99828c46399efcc6a212e5ca",
  "all/markdown/selfhosted":
    "35358:d33c8a31576374a9a233ef8bd114ed5dfe078a9712042004376ab100e8e6e100",
  "all/unattended/none": "31148:d4774ffd88ac4013f1401ea4f57de5889246c016847d6e3883e7607c246c4d4a",
  "all/unattended/docker": "36425:b5a8297b084ce06bf37aaea3e8a3558308c08c62cdeebedf9704ea0291614e45",
  "all/unattended/selfhosted":
    "38099:d31ce8204892d4dfbd3771208ccb95bb3ed922e94309d68de639280bb71d306b",
  "all/secret-references/none":
    "32362:62e038ba264bb0b3440480e5769038a23a439e42f8432e92b947d6ef086ad332",
  "all/secret-references/docker":
    "37639:44ee5e79a8a48a5f9d1995f5cceeaa91ff5ae903413f0d53959aeeccf376aca3",
  "all/secret-references/selfhosted":
    "39313:29e2d235643773da172d14902a9ac0f25f68aeecf277b2ab76c9e7f7ce5f5b08",
  "all/skills-read/none": "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all/skills-read/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all/skills-read/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all/identity/none": "30461:f04c2eaea52648dfde1c6c0b783c3d7bdbe45f62ff460fec96dd8bd4cd035baa",
  "all/identity/docker": "35738:041ef91282ff564b23915345b5077ea4c45b49216c5f5be482bbed5717f5caf6",
  "all/identity/selfhosted":
    "37412:403c9b744607cafa4fc1ae91add0c423a6ace4c85474e0821c3e333d5707e189",
  "all-without-humanInput/none":
    "30587:10ac2307cdc043cc5bbdd5a79a5cadc1d64a6e21ab96e6ba367203719d0aba72",
  "all-without-humanInput/docker":
    "35864:a07fc62f3c85f8b810910683861c90596153a6ff0e0ca321077bfe5ac3320115",
  "all-without-humanInput/selfhosted":
    "37538:510b835c9cc6f2bcbd21bbcd50929ebadebc452035f051dad4e7488ca967e294",
  "all-without-notifications/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-notifications/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all-without-notifications/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all-without-media/none":
    "29844:12ab00f3514e75e6e865731757f56e2357d6609e793fc52d3a81e39214907645",
  "all-without-media/docker":
    "35099:20903a0673d9d3e07957ad3fa83fa6b2d5db7236b2009774f4cc9520ab8359b2",
  "all-without-media/selfhosted":
    "36773:48cc9a2e778b9c3034b2f6a1abcbe0ffe47f55dd2317250f87a2bf1a3994a697",
  "all-without-subagents/none":
    "24421:f33f9d6b4bd2dcc0a5fdbdfe311730de13375db25baf8765dacb302ed79cd95e",
  "all-without-subagents/docker":
    "29555:fa64aeb96e8b34f9e704560fa913b6c4be53d195eb09bfa717a4df39d89e7d2d",
  "all-without-subagents/selfhosted":
    "31229:e3388844347b7391594b9bc16a378be56b217fe74a6b3a632e8178979249df4e",
  "all-without-schedules/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-schedules/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all-without-schedules/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all-without-browser/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-browser/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all-without-browser/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all-without-secrets/none":
    "30587:10ac2307cdc043cc5bbdd5a79a5cadc1d64a6e21ab96e6ba367203719d0aba72",
  "all-without-secrets/docker":
    "35864:a07fc62f3c85f8b810910683861c90596153a6ff0e0ca321077bfe5ac3320115",
  "all-without-secrets/selfhosted":
    "37538:510b835c9cc6f2bcbd21bbcd50929ebadebc452035f051dad4e7488ca967e294",
  "all-without-knowledge/none":
    "28328:e5c24c3998a87f6e0e6a6784c0a6f39f5b19b2df6e5f03605f4da8ea8a2d0684",
  "all-without-knowledge/docker":
    "33605:068af0f973eba0f0bdf706c7a1e78bf0e61434a67c3e6270219274a2ffae480e",
  "all-without-knowledge/selfhosted":
    "35279:ede41a9a5d5af63f1a1c95997951b16c6a676e4f2cb9a2d50dccbdc0bc9e334d",
  "all-without-workspaceFiles/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-workspaceFiles/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all-without-workspaceFiles/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all-without-workspaceConnectors/none":
    "30741:440a549eddb62c8873cc5b52648f1bf2c67e0ce7d9d8d00ce12b555cf4d28224",
  "all-without-workspaceConnectors/docker":
    "36018:f421517359f3c9443d6501773c4595afa76feb6d96838f323c60c2a480df4308",
  "all-without-workspaceConnectors/selfhosted":
    "37692:182732dc1f49878914c9ac945b79e634d58600bb0ebda22719ee00ed94b0c2fb",
  "all-without-workspaceAdmin/none":
    "29899:31d6d3add77f08ba8b909694e65e55b4f28eed001498a8a244ed37f21abe1c4e",
  "all-without-workspaceAdmin/docker":
    "35176:ba980fe942fc63cece3e316b1677908ac4043f305cfa62f85c6e386d724b3345",
  "all-without-workspaceAdmin/selfhosted":
    "36850:ff519e41cf5c8fcaf7067e1de49133cb3d9d458d3d6e2811d931136d4687254a",
  "none-with-features/docker":
    "27635:5671bdf2153c776ed19a72f7d4f6006a7507baef28f9a884a4ddf11b7ded0048",
  "none-with-features/selfhosted":
    "29309:37fc31ba95376e5e7f3a6fce849f72325a294e0065b7ad50e46cdc404749f705",
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
