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
  "all/none": "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all/docker": "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all/selfhosted": "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all/markdown/none": "29959:439f119741188031ba159a86a79f60b6aee7434c16d9831d1a73d5622cb27cf9",
  "all/markdown/docker": "34145:6ab82be914ab7e26e8c620808e4117c961e2b998f9f5d7cffcf952f0a1f6adce",
  "all/markdown/selfhosted":
    "35672:6c13b89ca3e4eb85179a42cfcae66ac3a6f10e042c19effd185614d85a28d62b",
  "all/unattended/none": "31340:04d22a695a87f08d6c7897780197b6f501eddceae1b25a2ac0fd76fcfd0773b2",
  "all/unattended/docker": "36739:325ffdcb3ebc3cb34027ef2ec755a369a6f01af8e649c9a33155fed176a80ead",
  "all/unattended/selfhosted":
    "38413:57dfdd90fd9f6a0b8393cf2da85d172b0eabe96655a995fe8da4d2a6a6b6fc40",
  "all/secret-references/none":
    "32554:603adbdf879ad48554b9587cb20076683b761ca24663b67c1366c0c7de47726d",
  "all/secret-references/docker":
    "37953:164b75298b898573197458db80b7cd07e3526d7beffacc5453a02de521056e09",
  "all/secret-references/selfhosted":
    "39627:9d18228a2e80b509bd03d0f62414cd41bab765366b9fdaaa00b3ff9b1f4b8666",
  "all/skills-read/none": "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all/skills-read/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all/skills-read/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all/identity/none": "30653:9852c52e94f1bb4adcfb40f65c6c183ee2926c51db67e9b93577704c8b75f82e",
  "all/identity/docker": "36052:91e0c5641554e083982f346917926104480ebf9642280fa19077c3cc73d8d3ea",
  "all/identity/selfhosted":
    "37726:7a1a85062b3832f5f7bb9cb00f7b0d66b2a8eea9764f6e33d671a759cd6f7db0",
  "all-without-humanInput/none":
    "30779:5a5e7a9fc22f5b8e17c066f7923bdf884266bd421708e10b6de50dd21b3fecb8",
  "all-without-humanInput/docker":
    "36178:68e7d0b5abe7e0fb4ca47181f598e8249fec640a10f0f5c5f03c9ac195fe327b",
  "all-without-humanInput/selfhosted":
    "37852:139206f8505c310ed91b1d4fe772b5b6005e048eb2230927739e955ff1f1fdb6",
  "all-without-notifications/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-notifications/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all-without-notifications/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all-without-media/none":
    "30036:266f161a7d8e70440c558a2075f60a8a588dfe509e6963cd8c6c01e0c9c6f687",
  "all-without-media/docker":
    "35413:8970d586bbcf8ed4abda2db4d33ee7d29993990409c81c5153db01b0f97aa0c0",
  "all-without-media/selfhosted":
    "37087:e95b9f08cadc876192ebdbfb4adf4df4b13cb8f71ea7dd1e0d1223c9f92cf27b",
  "all-without-subagents/none":
    "24613:2c0c911aff29d13534630b6a57dafe852939e59b977c653acbdeb33ede7bd867",
  "all-without-subagents/docker":
    "29869:fc52baeaa989f1cb5d4aaede4d00c9885e8f65faeb77d2937b7455581479b714",
  "all-without-subagents/selfhosted":
    "31543:720e5cccca1aede4a118bdbbece4388b470e033f75451e87920e4c6bffcfdedf",
  "all-without-schedules/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-schedules/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all-without-schedules/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all-without-browser/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-browser/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all-without-browser/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all-without-secrets/none":
    "30779:5a5e7a9fc22f5b8e17c066f7923bdf884266bd421708e10b6de50dd21b3fecb8",
  "all-without-secrets/docker":
    "36178:68e7d0b5abe7e0fb4ca47181f598e8249fec640a10f0f5c5f03c9ac195fe327b",
  "all-without-secrets/selfhosted":
    "37852:139206f8505c310ed91b1d4fe772b5b6005e048eb2230927739e955ff1f1fdb6",
  "all-without-knowledge/none":
    "28520:56f2e58af34c369e4661b174676b79dad307510af104ebf13667bc65c1975ee7",
  "all-without-knowledge/docker":
    "33919:2564d26098c8ad05b0bfa38227919f757341488238bf100ca692b7ceede58a48",
  "all-without-knowledge/selfhosted":
    "35593:0975b81173dc6e0e07a6e67d48c09508382d887896a1573afd51db95f49c9889",
  "all-without-workspaceFiles/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-workspaceFiles/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all-without-workspaceFiles/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all-without-workspaceConnectors/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-workspaceConnectors/docker":
    "36332:346debfabf1ea70663b519c81dafaf1f54bfe996b48af7cba423bb50fe2311c2",
  "all-without-workspaceConnectors/selfhosted":
    "38006:9019d0d635b7ed33b0c71f0f2080f2079fe4ccd6c3ca55f2ecfdee25c72aa770",
  "all-without-workspaceAdmin/none":
    "30091:c8227354e2dc0d26b8f1cbe0c25662c19a648a71b19631ceb86064e70ca99c15",
  "all-without-workspaceAdmin/docker":
    "35490:a7518545cc84ca80d3ea855b5070e73d27b350bd15a3dc8613b1216638c60c9b",
  "all-without-workspaceAdmin/selfhosted":
    "37164:299236635c7c4567e61a930cfee977a7f491ff6d4c483b38170675c49dc1dc5d",
  "none-with-features/docker":
    "27949:bdab7f15e8cd52047f14a022cd073c15a73ca322f1f8bcd707579e242738aeb3",
  "none-with-features/selfhosted":
    "29623:e11039008d12ca3b06039f58079eb60a2c52567851632c0b9797834a18f4e521",
  "none-with-features-and-workspace/none":
    "22715:ae41dfb95c0205d9c1aca914945348ddda927c177fa925d1fc7102178e5aadf5",
  "none-with-features-manage/none":
    "20990:0f45c26fe121201488c434bbb6ab07d2042ed242d5d5d5c2d36322f720b724da",
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
