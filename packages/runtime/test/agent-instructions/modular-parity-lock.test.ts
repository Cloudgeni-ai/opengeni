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
 * states once (PROMPT_CHANGELOG.md); nothing else changed. Every case then
 * gained the one `agent_suggest` sentence (275 bytes, PROMPT_CHANGELOG.md),
 * which these cases render because they leave tool availability unknown.
 */
const LOCKED: Record<string, string> = {
  "all/none": "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all/docker": "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all/selfhosted": "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all/markdown/none": "30950:c7e537fc376fd130396fc10430ba6203d2d9bee20bfd2deb7854d20056798bee",
  "all/markdown/docker": "34359:9f7d9cf7f697fc99f3b4da1892cc148d12589a30445632515a91370d5bcaa5d8",
  "all/markdown/selfhosted":
    "35886:74101391a03477cfa0edd29fe3856913ff588239cba51df5caef55712c957bb5",
  "all/unattended/none": "32481:41da42f4140345a5a0ef659c127782250dffcb123aa095f0bdd56f1ad5ba91bf",
  "all/unattended/docker": "36953:8da818674cb803384ecf8d4d585f73c9f97e37dd88046275ff392bdb7a075c75",
  "all/unattended/selfhosted":
    "38627:d790669dfd83f1730d7332eed9f14b4de39c40f07428c34fa0f0957491fa278d",
  "all/secret-references/none":
    "33630:4ab63fb5a0bfc221cce454f18fb2ed291765b8f204cc74cf0b4b5d3de0147435",
  "all/secret-references/docker":
    "38102:d862de04df1b1723b3e97b781468866e4fad1cf4d8dd4e7d557dbfe22476a821",
  "all/secret-references/selfhosted":
    "39776:d96021492efab8ae09f53573782c9a2d3be4c790e367c021a52d2cf08b659973",
  "all/skills-read/none": "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all/skills-read/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all/skills-read/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all/identity/none": "31794:3b80a69cee7d883b509a77394eb121c944426f566f7479eb0a51dc19c83e0cf6",
  "all/identity/docker": "36266:a2f75fae91ba89227a78f1ca3e37c799bd263d0adff92fb13efaa8c849b2a1a9",
  "all/identity/selfhosted":
    "37940:83d26ed82a2d0f31ee593ea9b1a57dedb248c70d6e1e84735497296a344901c3",
  "all-without-humanInput/none":
    "31920:a97e2d47fa112f7b2ed9ab7dd46f6e65d92400a4751e9a4d02e03eb1e4f9c7d2",
  "all-without-humanInput/docker":
    "36392:175b35f5724332600ebd1d4d6bba781deeae7b0a80ade30f0d77c2edf040fb15",
  "all-without-humanInput/selfhosted":
    "38066:2414d2ca2a077a4740966ca236f92bb6950f03eb9268d49c1f380dd51b49657d",
  "all-without-notifications/none":
    "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all-without-notifications/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all-without-notifications/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all-without-media/none":
    "31155:6a56bc020e6407f7c443f4aa549484319bc0b7e981727dda1e35e4ced3a55864",
  "all-without-media/docker":
    "35627:735632344d00048fd780408a591664d7bc87cb012896944c75e19789eb039793",
  "all-without-media/selfhosted":
    "37301:aa8f3c87bfc9c852e20d8c99c9efa5b6a94d9d147090bac835a881af4e81d3a3",
  "all-without-subagents/none":
    "25705:0be24a4dad605cc795f7ec19df2e5bd087241f6ef2639f8f4ff82cd8934797b7",
  "all-without-subagents/docker":
    "30097:4a1c9b456de1810dfaa1e0f85acf8cb6da442d89b21830f57cd70a39b649afdd",
  "all-without-subagents/selfhosted":
    "31771:1c38071f91b1391c5b7ba5fa5df9dc223ce87ad950cc88105fbafccc9b5ca73d",
  "all-without-schedules/none":
    "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all-without-schedules/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all-without-schedules/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all-without-browser/none":
    "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all-without-browser/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all-without-browser/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all-without-secrets/none":
    "31920:a97e2d47fa112f7b2ed9ab7dd46f6e65d92400a4751e9a4d02e03eb1e4f9c7d2",
  "all-without-secrets/docker":
    "36392:175b35f5724332600ebd1d4d6bba781deeae7b0a80ade30f0d77c2edf040fb15",
  "all-without-secrets/selfhosted":
    "38066:2414d2ca2a077a4740966ca236f92bb6950f03eb9268d49c1f380dd51b49657d",
  "all-without-knowledge/none":
    "29661:635a1a55da08e7ca2ff9808537e4063f4303dfc097f883bb31f2df0ed9a2dccf",
  "all-without-knowledge/docker":
    "34133:03d680e43d2198647a740386c49adb819787d7eefb19e075fb5aabab62b494b9",
  "all-without-knowledge/selfhosted":
    "35807:ae9a1b99a6ac2d358381c3bca1ac19246a1825b23ff4b27f242ee3128f7a6968",
  "all-without-workspaceFiles/none":
    "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all-without-workspaceFiles/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all-without-workspaceFiles/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all-without-workspaceConnectors/none":
    "32074:d84f17642d757b29a1f023f24c61ea6218eddfd383cb4e8d2828bc68a9716424",
  "all-without-workspaceConnectors/docker":
    "36546:fce8a0959a956586530f9e0c9de9960f46408d890e88836d5676268ada64a8de",
  "all-without-workspaceConnectors/selfhosted":
    "38220:b1762a9f53ca507edef0f7fb7a04622b4cbb5b1869205140974b24fa5c8a3220",
  "all-without-workspaceAdmin/none":
    "30755:22fae55f950e398424e23d0c93428b29dc0c4dd71c97c9df715bacc457ca530a",
  "all-without-workspaceAdmin/docker":
    "35227:bb8577c57288f31f58b6da38c1f849148706046614db70703578ec659723c449",
  "all-without-workspaceAdmin/selfhosted":
    "36901:b61b633744060d5d7cd69cb6a0ea7c9982fe2aa99606fbadbf36eec78ceef385",
  "none-with-features/docker":
    "27700:c136e10bef158fbf5b3dc531cff44445f602879b36a62d7ccf363b2e9d8c9d7d",
  "none-with-features/selfhosted":
    "29374:857545b1a546fb0add13139cb9668491d28d6b840eb8040691056b2da78ebfd8",
  "none-with-features-and-workspace/none":
    "23308:d6aeaa0b24410bb69f57b2796811df7bc101bdf655a8eb4d29b9ba242b3381c2",
  "none-with-features-manage/none":
    "22060:ee6a3ebda9305d015f6df95bc7bef5ba6e477aec47d474a16b45cca133077065",
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
