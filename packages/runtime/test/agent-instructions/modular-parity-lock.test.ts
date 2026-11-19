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
 */
const LOCKED: Record<string, string> = {
  "all/none": "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all/docker": "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all/selfhosted": "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all/markdown/none": "29770:c0c90687b4ec31d08d13b89639bede38ea93d94bd5289e7daa9e99b3585c1e72",
  "all/markdown/docker": "33834:a779c7142ac96a12d9f2ff4fbda75449ca13583bd72e80e0083cce33f9849b95",
  "all/markdown/selfhosted":
    "35361:aef1bd5426c58469547bb00a741cd60845e7c1e7729d84796637abeb0776cf42",
  "all/unattended/none": "31151:9b5e2ba400d23d5a845f651e74cdb139e171b9d8b239de89c715722ee02a2cc8",
  "all/unattended/docker": "36428:86286ea69ca6b9d4b2af5d51ab24f42e28dda5e18b10817d5fcde5f00a5e3242",
  "all/unattended/selfhosted":
    "38102:c745a4ffdea7a5ac52ef25dd46d73fb7347e82f6f380527f6524e84764a4158c",
  "all/secret-references/none":
    "32365:07f2b93a7e58b1f6b18bf1258da60c3ece10a050ee272d6c30914a3e01d87aad",
  "all/secret-references/docker":
    "37642:5ee331f2de053510938974689c0f6022417d8940e5623f516f25dda04e004b7b",
  "all/secret-references/selfhosted":
    "39316:6097d434e5721d9638214509dd76da7e37a4865855b2bc45250d9f8dd09a080c",
  "all/skills-read/none": "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all/skills-read/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all/skills-read/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all/identity/none": "30464:1fbbe8e10ff796562850430e9eca5d0a2f6191fae62bff716338b1d4bf39789d",
  "all/identity/docker": "35741:d6200cbc2a82ffec9161a77ad32157cd382fdff6baa0ab627f92e92de74a82db",
  "all/identity/selfhosted":
    "37415:a03aaad31dce27c71d986edd836fdbde53b534e0b950dfc9e86ccea5bc7848f3",
  "all-without-humanInput/none":
    "30590:52723beaf3543ddfc84d423b2b1210f216fa602fa5d6bd05152205509d6feb41",
  "all-without-humanInput/docker":
    "35867:3ce6a6d66b3f1a69991d93d6dfcffd4cd00e22b11692e1f44a93c52c5135b479",
  "all-without-humanInput/selfhosted":
    "37541:380d7f8f0b5dfa26488471a23ce92077fbb694ef4142f43d6383bcc6fd0e8c76",
  "all-without-notifications/none":
    "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all-without-notifications/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all-without-notifications/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all-without-media/none":
    "29847:7a760315ce16cf0a283fa8941d526cc8dbb68ca6477f33235af6995eba21854a",
  "all-without-media/docker":
    "35102:2c60b946fac538f11ddc2c49f5c068dd84b5416b43f9c53578fc8d8094ff68fb",
  "all-without-media/selfhosted":
    "36776:c322c3dc79e1227df7daa124e91fa3299c33fbb5bf7c3b8cdb079754d60da347",
  "all-without-subagents/none":
    "24424:51425cc6403e273b9fd1f89ec12a33ae3d282bdff5e07ef9360dc21d78dfec26",
  "all-without-subagents/docker":
    "29558:7e4f9c29945950a544d7ba6436e1befbc54f2955573d8d06b2a696e4fd7cd693",
  "all-without-subagents/selfhosted":
    "31232:27e52c6c0882aac2c24e557df0fc2013594d98f09ec07d963eacfc43c3eb46da",
  "all-without-schedules/none":
    "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all-without-schedules/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all-without-schedules/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all-without-browser/none":
    "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all-without-browser/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all-without-browser/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all-without-secrets/none":
    "30590:52723beaf3543ddfc84d423b2b1210f216fa602fa5d6bd05152205509d6feb41",
  "all-without-secrets/docker":
    "35867:3ce6a6d66b3f1a69991d93d6dfcffd4cd00e22b11692e1f44a93c52c5135b479",
  "all-without-secrets/selfhosted":
    "37541:380d7f8f0b5dfa26488471a23ce92077fbb694ef4142f43d6383bcc6fd0e8c76",
  "all-without-knowledge/none":
    "28331:e1543f4254ae58c1685e2973c420c53d9d0ee143c6ec460fcaeffb65dcafe159",
  "all-without-knowledge/docker":
    "33608:98a421378c01f05cd1180a738a6e901a58f0575ed52df99d09a93a4a6090721b",
  "all-without-knowledge/selfhosted":
    "35282:c761b323a00cb6aae42d3965ce0d42ebab64d55c51d828592ba634b9db42802a",
  "all-without-workspaceFiles/none":
    "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all-without-workspaceFiles/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all-without-workspaceFiles/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all-without-workspaceConnectors/none":
    "30744:ae30fc59cc95777c2dd684a953c187baa0faacd762d87ef566c27db9b033d030",
  "all-without-workspaceConnectors/docker":
    "36021:5ba25dc88c7db4bfaf1b231dcd2ff1cff33ec189f19fad6f0ee8383a4a8d4ac4",
  "all-without-workspaceConnectors/selfhosted":
    "37695:b63e54d836f30fb1a9523e52bc85fc77cc33eff1c8edd475262753534b9a8960",
  "all-without-workspaceAdmin/none":
    "29902:71f740f76b334712d8ee52bafb971a555ab31f743d9fec84b198134067378261",
  "all-without-workspaceAdmin/docker":
    "35179:b0d80b67ab370db319809b8582977322f5cb702cde72fd51349745d2cc3198aa",
  "all-without-workspaceAdmin/selfhosted":
    "36853:41d57ad45c8317977b2e3c796780f0f1a8f2cea16b4db8ddc16ec66099be4c52",
  "none-with-features/docker":
    "27638:012362c0a18ed4947d0c10324495a4a8d3fad2e73548f7aef9ba9378b4ec1a54",
  "none-with-features/selfhosted":
    "29312:70e9ef0017056407ee3655d9344964057307710e863017ae0cba9668e6aeddf6",
  "none-with-features-and-workspace/none":
    "22526:4137f980b117ffe3f5a7133b8588c148987338bb5a73dec66dcec76d05875475",
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
