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
 * Every case with a sandbox or Connected Machine later gained the
 * install-a-missing-library bullet, and Connected Machine cases its
 * no-sudo bullet (the prompt changelog); nothing else changed.
 */
const LOCKED: Record<string, string> = {
  "all/none": "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all/docker": "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all/selfhosted": "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all/markdown/none": "29959:439f119741188031ba159a86a79f60b6aee7434c16d9831d1a73d5622cb27cf9",
  "all/markdown/docker": "34314:f866f948868ba41987614839ebe3b902ff1ce023c97aa44690decf78d071fe4d",
  "all/markdown/selfhosted":
    "35965:f7ff01f02abd66bb2c13cf2f9fd1ba81e7950d7842f6a92e343856375909b8e5",
  "all/unattended/none": "31340:04d22a695a87f08d6c7897780197b6f501eddceae1b25a2ac0fd76fcfd0773b2",
  "all/unattended/docker": "36908:281090fc5c536cc1e4f365edbe25fb8906ab55de0d8c9e04aad2f2e2bf23cf7b",
  "all/unattended/selfhosted":
    "38706:ecaa01ef210886116413495c30e0c8e9639aaeabd40162a7ae15ce0ab99d2269",
  "all/secret-references/none":
    "32554:603adbdf879ad48554b9587cb20076683b761ca24663b67c1366c0c7de47726d",
  "all/secret-references/docker":
    "38122:d2d4d8c822dcf97bcf519bfbecd19c5507e5816571b5494e247b25d916661aba",
  "all/secret-references/selfhosted":
    "39920:1949762552e4b59e95a37b3abe9e0ad01e69eba51ed94a518bb7b422a48cd6e4",
  "all/skills-read/none": "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all/skills-read/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all/skills-read/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all/identity/none": "30653:9852c52e94f1bb4adcfb40f65c6c183ee2926c51db67e9b93577704c8b75f82e",
  "all/identity/docker": "36221:24e5b4b723b62f9fd2db4a7d8f4ea833cd82108216f4d481518fd0c90deb28e0",
  "all/identity/selfhosted":
    "38019:654783d3e84c6d36c222444620693737ae58a991a0a1435ae47ff0e1d7f7733f",
  "all-without-humanInput/none":
    "30779:5a5e7a9fc22f5b8e17c066f7923bdf884266bd421708e10b6de50dd21b3fecb8",
  "all-without-humanInput/docker":
    "36347:2ca42f0d557df936b28549a216104d9162b1afc46966185e17f99d513601986a",
  "all-without-humanInput/selfhosted":
    "38145:18cb4cd937c0d0ec6194f33d43ca4c33003194bd737327eb693d85ef58eff85e",
  "all-without-notifications/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-notifications/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all-without-notifications/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all-without-media/none":
    "30036:266f161a7d8e70440c558a2075f60a8a588dfe509e6963cd8c6c01e0c9c6f687",
  "all-without-media/docker":
    "35582:b3dc1634f06bd6540e4e359f817b3455ad7c15b59387e953c0c41b9c00a85b0c",
  "all-without-media/selfhosted":
    "37380:d6a1c0ddb06408b5a973bbd5fd055d1554d9b62fb292a80939988501bf3c5735",
  "all-without-subagents/none":
    "24613:2c0c911aff29d13534630b6a57dafe852939e59b977c653acbdeb33ede7bd867",
  "all-without-subagents/docker":
    "30038:47f3dcff8c2555f903847e1c8cb29e01e2a0df5816205f5f85a1fcefb47c6d8a",
  "all-without-subagents/selfhosted":
    "31836:b19a3f3b8cfba46ee70f5524c04d35dc755dcfc5ba57adb50f6f815158071c14",
  "all-without-schedules/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-schedules/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all-without-schedules/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all-without-browser/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-browser/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all-without-browser/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all-without-secrets/none":
    "30779:5a5e7a9fc22f5b8e17c066f7923bdf884266bd421708e10b6de50dd21b3fecb8",
  "all-without-secrets/docker":
    "36347:2ca42f0d557df936b28549a216104d9162b1afc46966185e17f99d513601986a",
  "all-without-secrets/selfhosted":
    "38145:18cb4cd937c0d0ec6194f33d43ca4c33003194bd737327eb693d85ef58eff85e",
  "all-without-knowledge/none":
    "28520:56f2e58af34c369e4661b174676b79dad307510af104ebf13667bc65c1975ee7",
  "all-without-knowledge/docker":
    "34088:6c775cac7930ec858c3977a71eda536be11b7f9ee142d215e373bbfca9cf3d7f",
  "all-without-knowledge/selfhosted":
    "35886:4047a00d98c046143006e9dfefab669a486c6590c8958853cc945b8b192e7ffe",
  "all-without-workspaceFiles/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-workspaceFiles/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all-without-workspaceFiles/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all-without-workspaceConnectors/none":
    "30933:cb1673f914ab67b0e2473907b6efdc0202f828b27ed3b444aed197c2c2052fcc",
  "all-without-workspaceConnectors/docker":
    "36501:4e9d974d8b2183018a85da589922b3f63bd099c82eaa0fe28adaf1dde848e05f",
  "all-without-workspaceConnectors/selfhosted":
    "38299:975ccfb155a76b0b80ea52b6f4c6ce31f5ce18b5388ed29a34408961e94dd922",
  "all-without-workspaceAdmin/none":
    "30091:c8227354e2dc0d26b8f1cbe0c25662c19a648a71b19631ceb86064e70ca99c15",
  "all-without-workspaceAdmin/docker":
    "35659:e80ea86f89d2938b82386797a967895780c3988a426ec41c9d8de130a8a5be5d",
  "all-without-workspaceAdmin/selfhosted":
    "37457:a57bbbed850a539694d8bf2c960a71b5edae18bc1e2cab869539a0edc1d0f3e0",
  "none-with-features/docker":
    "28118:f58dba670d80e55cc728a66d7910dfd429a3cf89fa1eb74ab46a602f462f7c2b",
  "none-with-features/selfhosted":
    "29916:5a9df2dc3ae297f99c41f327bdad7ad24c89d056dc2962f41e7e0473289c71c4",
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
