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
 * documents, Sites and session-coordination guidance (PROMPT_CHANGELOG.md);
 * every case with a sandbox or Connected Machine kept its bytes.
 */
const LOCKED: Record<string, string> = {
  "all/none": "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all/docker": "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all/selfhosted": "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all/markdown/none": "28905:7b78bae843c5040556c52364e288541ce9b57642105700427f967b20e64cc373",
  "all/markdown/docker": "33323:ff14b5309bbd0f3a56ed934872f41141d3ed047a2bdbe65e2d4f94739cc2afe3",
  "all/markdown/selfhosted":
    "34850:1dbdb7cbcb374892aac4c12e2ac951e2f371c971134851b67178984872325843",
  "all/unattended/none": "30252:f4292ad1c50f831bf9b2d22edca7fb86086b0ed013d740addeaa2cf4c3dba0bd",
  "all/unattended/docker": "35917:36cd7acc51192a2505af8a7b1a8122646708e662a0bc0031f3c5e46b958130d8",
  "all/unattended/selfhosted":
    "37591:7fe26b853ec599d2ca45322a3081aa6c9cbeea2c5c34eb5a61b82607cd54c573",
  "all/secret-references/none":
    "31401:b9b67706514b25001067e7099c7501da33720ec258652c29186d958f2d536f5a",
  "all/secret-references/docker":
    "37066:7ac1de6bccab3a3c8a498825dd58356f33e9695c114e8d023ec78a36adc1c85c",
  "all/secret-references/selfhosted":
    "38740:b6ee85ee189790130d8380946f025d4f1a6187c5023f1084604172374668487f",
  "all/skills-read/none": "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all/skills-read/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all/skills-read/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all/identity/none": "29565:c32ad0e0bf9e26b2c42412ed4882435711f3f63ca394534ab0dd08c5ec8daa70",
  "all/identity/docker": "35230:122b9af64dbe3d892dbab7cc858aceb401c0390a4e1b2d66525b488a584aebdb",
  "all/identity/selfhosted":
    "36904:91a63027cd2394e26180f36cdc1018064842fe0948209cf57e1cf77aa10f2e16",
  "all-without-humanInput/none":
    "29691:b2a2184b83c8bbce09ec2c41a5244b7cc3c376f746df177f4d7989d7766b3bb5",
  "all-without-humanInput/docker":
    "35356:826e26e4e7695712a478c8b769b0a5991c1df1ef8a11ad0bc746b46165152409",
  "all-without-humanInput/selfhosted":
    "37030:331de1956a9ddd982a437eeff524f80d60e3a8dfbf2a820f18639ec6da04b6c9",
  "all-without-notifications/none":
    "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all-without-notifications/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all-without-notifications/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all-without-media/none":
    "28948:69269ead889a6c2a941e7465b436a717dcb3e9e414dbbd4bb33f8dc96d1cebc2",
  "all-without-media/docker":
    "34591:f5fdfc2ebde7fab697029ae8e126ce7589acb63a046ff1e37d2f42e68b868e90",
  "all-without-media/selfhosted":
    "36265:77ad406d6eaf6b32a66bbdf2306d6f659983559f9ef211784a18ba30f0d4ea49",
  "all-without-subagents/none":
    "23539:dce1c1ff47e1de7cd98f8bf096496c04fb1090544b28d087e010806380943e85",
  "all-without-subagents/docker":
    "29061:495268903e1f67cd0c687930a7b8a0842a9dbe6fe88c62be137eaec3221a0730",
  "all-without-subagents/selfhosted":
    "30735:93b790f312bd5b6c55b9f9a2c0d7bec6efbb55bae1ba0b7b07538471895916f2",
  "all-without-schedules/none":
    "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all-without-schedules/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all-without-schedules/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all-without-browser/none":
    "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all-without-browser/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all-without-browser/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all-without-secrets/none":
    "29691:b2a2184b83c8bbce09ec2c41a5244b7cc3c376f746df177f4d7989d7766b3bb5",
  "all-without-secrets/docker":
    "35356:826e26e4e7695712a478c8b769b0a5991c1df1ef8a11ad0bc746b46165152409",
  "all-without-secrets/selfhosted":
    "37030:331de1956a9ddd982a437eeff524f80d60e3a8dfbf2a820f18639ec6da04b6c9",
  "all-without-knowledge/none":
    "27432:f037b38a62fa7935aa187daa4b80f89e09015c9f2780e6482422aac5740e1c89",
  "all-without-knowledge/docker":
    "33097:28285b9354d27051d67015c19e491556e6fd337f963022dd87b5212018a30c87",
  "all-without-knowledge/selfhosted":
    "34771:ac7417cbb89bf299e465a304a9d3e99572e23544a6dcf25d954776f75570a9d0",
  "all-without-workspaceFiles/none":
    "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all-without-workspaceFiles/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all-without-workspaceFiles/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all-without-workspaceConnectors/none":
    "29845:4f09a0f23f2af8314f62f05f60e97f107c20ce533b192946bc7d518056923a0b",
  "all-without-workspaceConnectors/docker":
    "35510:957b58f3ce771a81f99fe29fd533a7783eda757f8bf9a531ab291749c6ace818",
  "all-without-workspaceConnectors/selfhosted":
    "37184:f02d90aaf87b7b84918efcfe97219f0653b8452c6a98780587cd0a1bc07aa110",
  "all-without-workspaceAdmin/none":
    "28537:72755f93cfb0d52223d46b43e52c6a22c2fd39067b0ce7cfb81d4cffe0b96355",
  "all-without-workspaceAdmin/docker":
    "34202:326932705690cfd86f5ddb7de8420654f4c6fd0b12e2959011f0a507636bc6d6",
  "all-without-workspaceAdmin/selfhosted":
    "35876:c0c63667cc3ad580d7d7c76904c03b28c0cd33ccdd55af3c58c8116e538b527e",
  "none-with-features/docker":
    "26685:afa0e8df8b5f279440437fd547d7167c5d1334f19eebcc2224e1f53b11d2ce2c",
  "none-with-features/selfhosted":
    "28359:e946163bc0688cd80dbb419d0b5c9b1bad945b7cd623db3613b8d81f6243f54e",
  "none-with-features-and-workspace/none":
    "21185:622cd2401d771a6a6171a430803e84acc0eb00f44a4ebe125b11157753a2661c",
  "none-with-features-manage/none":
    "19926:ac1cf93f28d639d2a68c01bdbd1fda2d8c182d6f4e43776c536850a4e38e7b09",
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
      gone: ["A web search takes", "Link the source next to each study or figure you cite"],
      pure: true,
    },
    artifacts: {
      options: without({ artifacts: false }),
      gone: ["Answer in chat by default", "documents, Sites and visuals"],
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
      gone: ["Decide the design before you build."],
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
      gone: ["Show its setup card"],
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
        "A web search takes",
        "Decide the design before you build.",
        "share one workspace",
        "Link the source next to each study or figure you cite",
        "Answer in chat by default",
        "Show its setup card",
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
    expect(renderWith({ secrets: true, humanInput: true })).toContain("Show its setup card");
    expect(renderWith({ secrets: true, humanInput: false })).not.toContain("Show its setup card");
    expect(renderWith({ browser: true })).toContain("Show its setup card");
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
