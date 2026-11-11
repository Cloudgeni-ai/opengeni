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
  "all/none": "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all/docker": "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all/selfhosted": "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all/markdown/none": "30026:ca825c42d392574e27d8a06ba805f2a6bf218edc663418097b57e821ae316185",
  "all/markdown/docker": "34090:9637d8abf59bb2dc793179fbcc6c7a15b92135cf8216195d1aa22074ba09eaab",
  "all/markdown/selfhosted":
    "35617:26d924c7bcefc2ad8c05aef3b9dc1be9afb3d623a2b6595ea4c67ae227f00e19",
  "all/unattended/none": "31407:ea8f9bf293bbd8674712d910a19384a5515315a213dd9f685ff30fccaffc636b",
  "all/unattended/docker": "36684:fdb854870f5a4b11474b844d61b679d3cf3c9601699e7d0ef496de2e4cf377be",
  "all/unattended/selfhosted":
    "38358:925d5820608f00511d2d573cdc1b090a8280923fbb18c9162ffc79d95378bbda",
  "all/secret-references/none":
    "32556:84be969686bc396e72e8e100a6cd454260fcd44bed96c652ae7d258956899d2e",
  "all/secret-references/docker":
    "37833:90b20a87ffb1cebbd8bbfc3ff023cb6a2c977afc78659f60d5626a28a7663455",
  "all/secret-references/selfhosted":
    "39507:0483c4ecaf65aeaccc9d7a4265d47b45a3d82acd8aba1151b4612a91f0f977b8",
  "all/skills-read/none": "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all/skills-read/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all/skills-read/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all/identity/none": "30720:bc42fd17e0ab2eaab7349223e2be0d715ea96a4fcad87e8b8c92b9da585d2bf7",
  "all/identity/docker": "35997:3d565b91d5c912081ac5fff9b5a024588f054d0339f6dad911154b4d64f49b16",
  "all/identity/selfhosted":
    "37671:b80173a439698010199b6856e91b8c5d872f7b94c4d39579b1ab0cb24e311e02",
  "all-without-humanInput/none":
    "30846:e2773128d9ed477548d2a2f604c34a7002fad0ab7dca7dadfe6c68edf6ecf850",
  "all-without-humanInput/docker":
    "36123:ecbc67d7726ba2edfc0570162a59614ef8a2f986dd1bd13b27d2202aac1a2878",
  "all-without-humanInput/selfhosted":
    "37797:57839b60a36721758681d38bb48524ee2c6150d5e985507a397505d32bc85a96",
  "all-without-notifications/none":
    "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all-without-notifications/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all-without-notifications/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all-without-media/none":
    "30103:d1304e7d1839d482dc3ef3d51f0cf715c281f931b78aea38e261f2ca4b8ad12a",
  "all-without-media/docker":
    "35358:a97222ee326d3cefac6d95d8a0d0e7514de886995322ba3b34a72268fad96e94",
  "all-without-media/selfhosted":
    "37032:6497c64f743cfea8281bd138a1cf4e4c687aa3b008c4c9dce8ee9d8ce32a47f4",
  "all-without-subagents/none":
    "24694:c768ad41c7fcdb47f9c293d4a2875b5ae93aab090ace5479b4586f4cfe17d48b",
  "all-without-subagents/docker":
    "29828:f3e2f31ae5df3c0889327a510e524fc1167686d1fdc07728796127052dcc913b",
  "all-without-subagents/selfhosted":
    "31502:8428096d7548549ca47dd5bba878fb5ce6691a52f251d73d2aa5b5c807cd80a2",
  "all-without-schedules/none":
    "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all-without-schedules/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all-without-schedules/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all-without-browser/none":
    "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all-without-browser/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all-without-browser/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all-without-secrets/none":
    "30846:e2773128d9ed477548d2a2f604c34a7002fad0ab7dca7dadfe6c68edf6ecf850",
  "all-without-secrets/docker":
    "36123:ecbc67d7726ba2edfc0570162a59614ef8a2f986dd1bd13b27d2202aac1a2878",
  "all-without-secrets/selfhosted":
    "37797:57839b60a36721758681d38bb48524ee2c6150d5e985507a397505d32bc85a96",
  "all-without-knowledge/none":
    "28587:98777a172f86a1e50b8aa63a41a922c913c7826edfcc8ae0da00176b6cf5cc9a",
  "all-without-knowledge/docker":
    "33864:e5d752d5feff23ba9c6a10a7f2b0cc253bf166323b6a0576c0d7f22fc30dd311",
  "all-without-knowledge/selfhosted":
    "35538:f4fc0bcb109e2e9651b62236b1d53635c71dd5d6d7e1de701914de44295c0ae0",
  "all-without-workspaceFiles/none":
    "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all-without-workspaceFiles/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all-without-workspaceFiles/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all-without-workspaceConnectors/none":
    "31000:04090befd2dc2000ff593d58fa63a4a3c54b9b2eba5c9c31be93009d475f6a80",
  "all-without-workspaceConnectors/docker":
    "36277:e16e3c08fdd75536967f20d4b5aeccaba0233c6b54cccc5902f28871e7528ccf",
  "all-without-workspaceConnectors/selfhosted":
    "37951:77ef9ab2ee1ce0b5f860b1cf1ca0046bb1824d24b93621ea62278e84d5c441fa",
  "all-without-workspaceAdmin/none":
    "29681:975684b981c6618876082ba99b3c2f8db2e84157f427e2a2fb4b41965292ce89",
  "all-without-workspaceAdmin/docker":
    "34958:ce2a184d815ff27001c426545f513fc6ebd9699ea2684b92146f24fe80aad970",
  "all-without-workspaceAdmin/selfhosted":
    "36632:c77c3c9712f6645db241aab64dc695fac447fb72421c1e89ae6b68f084f281b8",
  "none-with-features/docker":
    "27431:329cabae4161559e49b2a38e4d09fc534ecb20d5db75eecb2994409077c24b8c",
  "none-with-features/selfhosted":
    "29105:62f64ce1e6d0838c7f5b9e72aef55d3327d20b8a5371dac71661b8537226e9fe",
  "none-with-features-and-workspace/none":
    "22319:548a7851eb24a18de19c5a91063da0b5189ecbf7d982f3e3f8db588748726c56",
  "none-with-features-manage/none":
    "21071:b4122dc38b1f81964eda0f22f8edfde940c5789181e669a233bb18f2a0021a74",
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
