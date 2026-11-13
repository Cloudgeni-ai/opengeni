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
 */
const LOCKED: Record<string, string> = {
  "all/none": "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all/docker": "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all/selfhosted": "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all/markdown/none": "29756:a931848770809ba9f0bc99fcda0936104c97e3db576c021072c39d12c7ad4bef",
  "all/markdown/docker": "33820:21f91cbf3624006d6595701999e4ee4ceb4a15cb1173533f847b1a3315d487cc",
  "all/markdown/selfhosted":
    "35347:808040b6691155de1a4ecd9099ae3a4a29b64aea9639ffe8c8a38be2234d1889",
  "all/unattended/none": "31137:d52a30a0e7f4955845dc8d26c1f3864e6efb52e51beef3ee4c2fee94a5e74e4e",
  "all/unattended/docker": "36414:32fae680d4a72f9bf66366ec7cebef4f58443c90a556cbd35e2f9a8966ad10b0",
  "all/unattended/selfhosted":
    "38088:864bf5be49da87f2052282a68e65c9acacfd37675abc3b56a6f7832d50f77e97",
  "all/secret-references/none":
    "32286:694681202f8fac58872032e486a19b458801ff821e5760fb9d7b4a1f85a58d48",
  "all/secret-references/docker":
    "37563:1a348de146f14e728e0e42706225bcdd71491d8bb54f142ca924b035b712fc0f",
  "all/secret-references/selfhosted":
    "39237:f1f31a2c570b0d7383ca1ec21d12570583b4d2fb07ca390d48d8fb872dee5462",
  "all/skills-read/none": "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all/skills-read/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all/skills-read/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all/identity/none": "30450:1cf0f54e96edbcd3cd94673469e296a302160408ba8b5b839c499d7656d407ce",
  "all/identity/docker": "35727:714ce68333c93acbd0e169f92f521f0356e3948c184dbd2d1e5e906d40ffd12c",
  "all/identity/selfhosted":
    "37401:8773e8d97208ef4b8ab5dc69357c307e5b1f158bdcc28a93b6efe1e02521b3df",
  "all-without-humanInput/none":
    "30576:55c031ecf21482f5c40af0a11916cd7584a1fc6715c7d776cdb749afd0860cd8",
  "all-without-humanInput/docker":
    "35853:c9bead3611d3690847d03a781291d4d6399cc3bff7dffc134a15b63848c475e4",
  "all-without-humanInput/selfhosted":
    "37527:61e6c356bc0284a88169b71fa2ab319e22b061ede39354af8e0a172c23ec5c92",
  "all-without-notifications/none":
    "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all-without-notifications/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all-without-notifications/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all-without-media/none":
    "29833:7211ea08ea6ca679917b7962f729542edaa650e2cb7ec74d0dc67dcc49ee102d",
  "all-without-media/docker":
    "35088:161fdf255ffd077c7b7c6689701e3c9311acf287c85fedbc709299d5c8abc9e9",
  "all-without-media/selfhosted":
    "36762:19dea5f733f7df59e86985c1d24f02a3fcc1f938a58f1150884c847cffe93d5b",
  "all-without-subagents/none":
    "24424:51425cc6403e273b9fd1f89ec12a33ae3d282bdff5e07ef9360dc21d78dfec26",
  "all-without-subagents/docker":
    "29558:7e4f9c29945950a544d7ba6436e1befbc54f2955573d8d06b2a696e4fd7cd693",
  "all-without-subagents/selfhosted":
    "31232:27e52c6c0882aac2c24e557df0fc2013594d98f09ec07d963eacfc43c3eb46da",
  "all-without-schedules/none":
    "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all-without-schedules/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all-without-schedules/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all-without-browser/none":
    "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all-without-browser/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all-without-browser/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all-without-secrets/none":
    "30576:55c031ecf21482f5c40af0a11916cd7584a1fc6715c7d776cdb749afd0860cd8",
  "all-without-secrets/docker":
    "35853:c9bead3611d3690847d03a781291d4d6399cc3bff7dffc134a15b63848c475e4",
  "all-without-secrets/selfhosted":
    "37527:61e6c356bc0284a88169b71fa2ab319e22b061ede39354af8e0a172c23ec5c92",
  "all-without-knowledge/none":
    "28317:f58d5d82b5f7160653052dee1e41027dcc38a0ac48f0babea5479ef0e64f5429",
  "all-without-knowledge/docker":
    "33594:cba453f402b658676f4c0c58bc28a78a6b6ee20d5504e0be049005b30ece866f",
  "all-without-knowledge/selfhosted":
    "35268:204ee57efc33471c3fa9b8c41589250305166fef7c45acde3624a8381add9e2b",
  "all-without-workspaceFiles/none":
    "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all-without-workspaceFiles/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all-without-workspaceFiles/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all-without-workspaceConnectors/none":
    "30730:3d4bae19c202d860b6ecbd604bf3d0fc28395cbf9c98a97da14f6e415d8ef0f8",
  "all-without-workspaceConnectors/docker":
    "36007:b118fa7f7668cd69371300dd69fbe6acda2925db62f53d0b277ef093f44aaaed",
  "all-without-workspaceConnectors/selfhosted":
    "37681:32f91aba61e3d0f31466b1ef1cd7a033adef772df4adfd6c58f5d80bd8769358",
  "all-without-workspaceAdmin/none":
    "29411:37520d84c6fde1c5bd5b3a8c20bc61768e36a2ddb521aba7a6e8b92902e940fe",
  "all-without-workspaceAdmin/docker":
    "34688:5cf529d3364ab2db1fc2493a49fbc77ff2e49f0dca85b680e919993b80c9c8a2",
  "all-without-workspaceAdmin/selfhosted":
    "36362:794b415c00eb1c6c1cf319bcc84fb620e0dca142269be341559157a82c9eba45",
  "none-with-features/docker":
    "27161:b4f5f26780dcfdebe1d25c51bdc753b83e3cc8fb8cf7c909556ae44207cccb80",
  "none-with-features/selfhosted":
    "28835:6aedb9580b977415a4f4d50749b0e63aa21c422c1320435a43cae88d077603f9",
  "none-with-features-and-workspace/none":
    "22049:d5bd66efb9d6479ff1f032c1eb903a1d0dc54cbef39babd56fe56e13d92c2155",
  "none-with-features-manage/none":
    "20801:a95d45dbf3b8d24fe285e437334bc474081bde693e6ec56643109703bee6f2a4",
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
