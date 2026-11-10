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
 * states once (PROMPT_CHANGELOG.md); nothing else changed.
 * The cases without compute (`/none`) later lost the sandbox-only text of the
 * documents, files and session-coordination guidance (PROMPT_CHANGELOG.md).
 * Every locked case has goals on, so every case with a sandbox or Connected
 * Machine kept its bytes; a session with compute but without goals gets the
 * goal-free verification rule (compose.test.ts).
 */
const LOCKED: Record<string, string> = {
  "all/none": "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all/docker": "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all/selfhosted": "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all/markdown/none": "30020:95d7df05f2b6350cfb8abd390a06c4672bab77ae43f79be91891cf8d8e040313",
  "all/markdown/docker": "34084:4e20e4c1a5bb4dd47dbfe897c0b4c977720c4ac013cce72991c0888781a4abb7",
  "all/markdown/selfhosted":
    "35611:b951a2253e4872b3099644a57acdb48ed568db9cb3c22a297f865153ab11671c",
  "all/unattended/none": "31401:2feaa822c7405bfe578bd15857d40de3270de8d7e8b6ef306eb761a790ffe4c4",
  "all/unattended/docker": "36678:6ebc5e4af6901c8ff99f3f84df2c5eb4211210c5adb06aa2370e9ec611d21451",
  "all/unattended/selfhosted":
    "38352:0c0f9d6f131fce42368b7b21cde654a132e7f57291aff3ce2eeeb017234f4245",
  "all/secret-references/none":
    "32550:1c3dcc7ae26bd0417a61decb910a5379ddc6961e513e379c742789df3e024854",
  "all/secret-references/docker":
    "37827:27340c948476ef40e29ae9a11b0dd312744f99687fad4dcfc469c06a4518f548",
  "all/secret-references/selfhosted":
    "39501:286b07c652664887b03259e9427d02b20469d23812aa578e4204346b41e2db24",
  "all/skills-read/none": "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all/skills-read/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all/skills-read/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all/identity/none": "30714:cdbf41757b658fa633d02a500e76ebdc5369bbaa5111560e9f834df909df4f2b",
  "all/identity/docker": "35991:a212526909af988cf2db62e61745c58d87aa86234d6d73f8f8babf7f8aaaac8b",
  "all/identity/selfhosted":
    "37665:fb3a0190240a10085ecf15918d2a03cb6e1a772e1be930c30648ccb8e199bb4f",
  "all-without-humanInput/none":
    "30840:2a17e68148b6445451262e241df2045bc7f158b4c5d39c3d9209bd9d52a94db8",
  "all-without-humanInput/docker":
    "36117:a469dc4b006059ee3c651b59b1d76de2570cdecf47077ca8482ce1a0b2257d43",
  "all-without-humanInput/selfhosted":
    "37791:686609d116b2c104ec5660785087bf17dde6b4594c37a4cd10eb8363a385fcd9",
  "all-without-notifications/none":
    "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all-without-notifications/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all-without-notifications/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all-without-media/none":
    "30097:66514f5028e12fd83d26673dbe2ba125736a775d2e8df8534d73e22315870dad",
  "all-without-media/docker":
    "35352:8da992d430661ceccc53126476270705bbecf771ce695d3f08c83538d97b0d3a",
  "all-without-media/selfhosted":
    "37026:2d703cf75e074e726a4be5c234596fcc07cf304971293f417d78ac9291ddbd25",
  "all-without-subagents/none":
    "24688:4ef5272dcecd0241470e3d170c046765cbd25cc955bec1fad5d792d14109e8da",
  "all-without-subagents/docker":
    "29822:5835e874df01b192a0edc079ae753a7fd9c829b62f55d17de68abb6bdb4ec707",
  "all-without-subagents/selfhosted":
    "31496:06c72421984648c148009fd2492a478d75aaa25a963dff446cc94e8451d08aa2",
  "all-without-schedules/none":
    "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all-without-schedules/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all-without-schedules/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all-without-browser/none":
    "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all-without-browser/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all-without-browser/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all-without-secrets/none":
    "30840:2a17e68148b6445451262e241df2045bc7f158b4c5d39c3d9209bd9d52a94db8",
  "all-without-secrets/docker":
    "36117:a469dc4b006059ee3c651b59b1d76de2570cdecf47077ca8482ce1a0b2257d43",
  "all-without-secrets/selfhosted":
    "37791:686609d116b2c104ec5660785087bf17dde6b4594c37a4cd10eb8363a385fcd9",
  "all-without-knowledge/none":
    "28581:29d3e8caf8a71bcad47c742a0489db038ce4c43702e5219c9818dff9aaa7ef43",
  "all-without-knowledge/docker":
    "33858:15989a7cb0ee2761601dd7e7bb872f0d61738bf6b648b503c6946407cb491880",
  "all-without-knowledge/selfhosted":
    "35532:d3ecf65450e36363ed52dd8e9167fab67020c7e196d8e4e7b3063111dffe4df5",
  "all-without-workspaceFiles/none":
    "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all-without-workspaceFiles/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all-without-workspaceFiles/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all-without-workspaceConnectors/none":
    "30994:285f6ed4fc988e5ef60c49fc92bdba4e3a22a19eda04847a8934f7e1591d062c",
  "all-without-workspaceConnectors/docker":
    "36271:5d7b5911729d2346be82d928ca07075c146752377ca1e17dfc3e59519003767c",
  "all-without-workspaceConnectors/selfhosted":
    "37945:160aa966ada3ee82f84b948fbc3f4eb9818215bbee774326e99ff12ee68a1bae",
  "all-without-workspaceAdmin/none":
    "29675:5bec10c2f6f3ed963641755f73adddfa2cc73a66010b48411d7fb6dc9b3db120",
  "all-without-workspaceAdmin/docker":
    "34952:aa7be5041fba61ecb94a7e881832552fd630e711d7b7447f7c6ceb6b9beddf23",
  "all-without-workspaceAdmin/selfhosted":
    "36626:07a449cfb2c0a4bd1285e05fd04dfc247d4f819f0cb0595f3753af2b373f1034",
  "none-with-features/docker":
    "27425:9dd43016a46737558ffd91326e6b1f2d4f26b29ad4afcda9a3b952a62213a925",
  "none-with-features/selfhosted":
    "29099:0e6394e12f006d66586f3877bc1204425762e0eddfce59f043228a77b29382b9",
  "none-with-features-and-workspace/none":
    "22313:2ec774697f43e9e708db442bec933ecc1e44083c02b20aff213026d42ee5a8ec",
  "none-with-features-manage/none":
    "21065:62627fb8b964fee1c4710ce824dc7841b60624fb89fdd4e9a0ea3190c3094ce2",
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
  const renderWith = (capabilities: Partial<ResolvedAgentConfig["capabilities"]>) =>
    inspectPersistentAgentInstructions(testSettings(PARITY_SETTINGS), {
      ...base,
      agentConfig: {
        ...config,
        capabilities: { ...config.capabilities, workspaceConnectors: false, ...capabilities },
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
