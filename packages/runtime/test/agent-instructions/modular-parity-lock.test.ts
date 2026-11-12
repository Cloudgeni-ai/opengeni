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
 * goal-free verification rule (compose.test.ts). Every case then gained the
 * one `agent_suggest` sentence (275 bytes,
 * prompt-changelog/2026-11-11-agent-suggest.md), which these cases render
 * because they leave tool availability unknown.
 */
const LOCKED: Record<string, string> = {
  "all/none": "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all/docker": "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all/selfhosted": "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all/markdown/none": "30301:ef1a122a589054cea1e5ad32550c62d1190ce8beea62d66e8820602cdb23fcaf",
  "all/markdown/docker": "34365:864771f956e82250581216164760025ff6064c9b0e38f5ff1b63e46c1141856c",
  "all/markdown/selfhosted":
    "35892:fcd471eb0388f197240e91346cbf1a0ce6abb0be368063da2442ea8409468378",
  "all/unattended/none": "31682:5829713234c007da04a60d290e5a65f98d1106f60b321dfc5b5dd57824cc4064",
  "all/unattended/docker": "36959:55f681076e2291e505bf4aa4f19ae7d23f28242a8cf45535c89ab514dcc5cbd6",
  "all/unattended/selfhosted":
    "38633:32b1959c5d456eb4aae41b9e716fd4a0203dc1d75cf156d0f7d26063565458a4",
  "all/secret-references/none":
    "32831:1f01f982d18bd1b70000db49e565584c426ab132e0fbbe2386404116b5194f5e",
  "all/secret-references/docker":
    "38108:c8649fcd414c3f64fb48e4734686a1d6df91899caf588ecf5b01cbb767429621",
  "all/secret-references/selfhosted":
    "39782:adecc16048c59d37e1dcb6bdb9c17690b007afdbd116a6854ffbf089bbe875fa",
  "all/skills-read/none": "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all/skills-read/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all/skills-read/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all/identity/none": "30995:1512564578a84ff446a9d7773762d8aaa2e599b99f6231bb6f1ba91c03efb42a",
  "all/identity/docker": "36272:d09fa04e37ad2eed9eb32437cb16336c003223aa784746d310fd274cf6bfe984",
  "all/identity/selfhosted":
    "37946:5aba127601a18f8e9df3c82b8e6e1e6ee93d00164150973b83ecc2b3569df9b9",
  "all-without-humanInput/none":
    "31121:b781d0b3b69c85aa0b511a5cbf29261394fe2453a46170ef0b5869e3d739e70e",
  "all-without-humanInput/docker":
    "36398:df63ac5fafd1796346d137ee68e5a6d84137b77d8dc3e620ee938fb9c1c18961",
  "all-without-humanInput/selfhosted":
    "38072:d3a033de76deaf2652930c550bf20b9a0ba028ceaf7aa55eb916cf4930d99ef4",
  "all-without-notifications/none":
    "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all-without-notifications/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all-without-notifications/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all-without-media/none":
    "30378:99cc397bcafd47f8942ea59b40d8bcc995a01530431e103a5629774054023596",
  "all-without-media/docker":
    "35633:18caa1319711c2676d675dd24b814c816ae2ad4fc3954a8c839daed730fda074",
  "all-without-media/selfhosted":
    "37307:1e4c7fd6e020d560424aaad3b092a350c5f9d0959e149c21b16b19b5f82fa499",
  "all-without-subagents/none":
    "24969:b29d052169ae58466673c87675511728001167adb53d740e7a2b43596d9f94b3",
  "all-without-subagents/docker":
    "30103:cdb67ecf788821a2a0f68dbcd372d13de78cc440781f29c9b4291963fa1471c1",
  "all-without-subagents/selfhosted":
    "31777:28ab3f3d1d156e8ae59c8c0488ad07904182527e56f7033a9209f9993125d3ed",
  "all-without-schedules/none":
    "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all-without-schedules/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all-without-schedules/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all-without-browser/none":
    "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all-without-browser/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all-without-browser/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all-without-secrets/none":
    "31121:b781d0b3b69c85aa0b511a5cbf29261394fe2453a46170ef0b5869e3d739e70e",
  "all-without-secrets/docker":
    "36398:df63ac5fafd1796346d137ee68e5a6d84137b77d8dc3e620ee938fb9c1c18961",
  "all-without-secrets/selfhosted":
    "38072:d3a033de76deaf2652930c550bf20b9a0ba028ceaf7aa55eb916cf4930d99ef4",
  "all-without-knowledge/none":
    "28862:a90d63462af6df328c19b67fb04c932f1042eba9b7e8891dc351b336e1579007",
  "all-without-knowledge/docker":
    "34139:f85e03833819085d5240a8fb441cef2eb896d17fe0dc36e5806d487f6dd6c492",
  "all-without-knowledge/selfhosted":
    "35813:057dfc561d23202bc20871a1b4bb737c39d4536ab7cb037b50928a0c81d090f7",
  "all-without-workspaceFiles/none":
    "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all-without-workspaceFiles/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all-without-workspaceFiles/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all-without-workspaceConnectors/none":
    "31275:2cbec651ff7c537370d5640d5a5a1b34352394423664d546b4bf838826c887c1",
  "all-without-workspaceConnectors/docker":
    "36552:a5a4ee9030be81ac4182e7f855426a13c458da7eb4a90545a5df56e906c77cc7",
  "all-without-workspaceConnectors/selfhosted":
    "38226:9f518eab5289bfc4212642a61fe5ac88f047d334b040760ed5eb36cdd7403eaa",
  "all-without-workspaceAdmin/none":
    "29956:f654fda731a148751a145d6784d0ae26bc3b44fe28d36f3b1a1075a10240b294",
  "all-without-workspaceAdmin/docker":
    "35233:e4884088d1295b1c1bbb5cf749a7ab83a67aaf492d39c61fd623b63d1d98a769",
  "all-without-workspaceAdmin/selfhosted":
    "36907:d0feb84f1f2c2c1c637bd4ed8b7da082a1853d84f6df2a3a4beabc1823fd70ae",
  "none-with-features/docker":
    "27706:9c0ff332e9ecca408703a1ff66b91e09ea8849d19ee01e603390ba9d1f6729f7",
  "none-with-features/selfhosted":
    "29380:c295a3a86fcbd4f7644d18a0b599ebd1f94083f859332cb9d16ad95e08989ee6",
  "none-with-features-and-workspace/none":
    "22594:243a1445b1a2d27a58d50c2c59b20cdf0caea322602a5136adf1404cc0b7c1fd",
  "none-with-features-manage/none":
    "21346:8340de0bed2f270f9d9a5de05262590928d01734f46787c3f275ce0cf3a9fa72",
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
      gone: ["Answer in chat by default", "documents, Sites, and visuals"],
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
