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
  "all/none": "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all/docker": "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all/selfhosted": "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all/markdown/none": "30110:fc1d10911469dfa0a5b57f23f79df80e000e950d6ee975f47220cea0d1c74eae",
  "all/markdown/docker": "34174:2466d0e1bcf886b9b9e4c693ebd9f5f919beb21965bf934407d4fa28e41dc25f",
  "all/markdown/selfhosted":
    "35701:352793e0d00c801f37bfda08a2c5478b054e0aa284e810ee646d73e88c2efaf0",
  "all/unattended/none": "31491:13415ed48328cf8c41249777e89c257e780c511cb6fe6147bb903e42539fa28b",
  "all/unattended/docker": "36768:917057ad4360e2217971fa2bb117fff9ead490c44b30e79021c76ce538a39016",
  "all/unattended/selfhosted":
    "38442:eab68f6edb079b6b5448879ba1df0203284a7f066522135f6bf7bb5b14dacd76",
  "all/secret-references/none":
    "32640:7ec6299fff20e3b881d06bd3d137da1f10c5cee243e3c96f54a6b96937520c63",
  "all/secret-references/docker":
    "37917:8905d653fbfa7ae3fbf700650893c5bb618fa5392eaaa50e32bd8aca00b9571b",
  "all/secret-references/selfhosted":
    "39591:feec5bdb8f8c40f1863eac3bb2dd7c1cec7af85d6f5870ab489118800963775c",
  "all/skills-read/none": "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all/skills-read/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all/skills-read/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all/identity/none": "30804:e66d7aa066e657318ed3028c5b98d8934769be49b59335abeee001d514c8758e",
  "all/identity/docker": "36081:84b1f6f2b149c782a0fc9b05374f6292ed3280be99f995cefc1ec05f849b95f5",
  "all/identity/selfhosted":
    "37755:872268ea191811db7457c4b09e0b77f02c210b4f924f2359475131aca9a829c0",
  "all-without-humanInput/none":
    "30930:a28e24aa88e223f532f46df73cb9f53b589b970b8631e9a3ad8d5a611fa4faa8",
  "all-without-humanInput/docker":
    "36207:c995872eb195bf5e3764360dcd4700c858671f2cd5b6908d3631b88721dcb362",
  "all-without-humanInput/selfhosted":
    "37881:c40bc316a180679bad44aee3ae20184dc278a09b1148bc766dbb94ecf58c6b51",
  "all-without-notifications/none":
    "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all-without-notifications/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all-without-notifications/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all-without-media/none":
    "30187:ba864ae3c796b8c2ed74be01700153b879605e0add2a46d07b2224bbdbf9507b",
  "all-without-media/docker":
    "35442:2a5371228c1847ea09f8bd28c0e175c205286792843aa2347aafe5e77ed33eef",
  "all-without-media/selfhosted":
    "37116:bd96f53e364ec75e5e8fcd778d232ad29166cbfcd7062b9c84d5ccb994c91860",
  "all-without-subagents/none":
    "24778:265cf69ab175ad2e4de7183f8d80c00baebd868e4a705c3365cdee97aa1a5370",
  "all-without-subagents/docker":
    "29912:6723dee4719767ced36f53d1ecfdcccf5f2a1cdcfea2c9462f5b51d60ed97bec",
  "all-without-subagents/selfhosted":
    "31586:a0d0a4e4eec8a1b817e31fdc4b825112d09a05ceb6835510e302a2f392804d7b",
  "all-without-schedules/none":
    "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all-without-schedules/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all-without-schedules/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all-without-browser/none":
    "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all-without-browser/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all-without-browser/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all-without-secrets/none":
    "30930:a28e24aa88e223f532f46df73cb9f53b589b970b8631e9a3ad8d5a611fa4faa8",
  "all-without-secrets/docker":
    "36207:c995872eb195bf5e3764360dcd4700c858671f2cd5b6908d3631b88721dcb362",
  "all-without-secrets/selfhosted":
    "37881:c40bc316a180679bad44aee3ae20184dc278a09b1148bc766dbb94ecf58c6b51",
  "all-without-knowledge/none":
    "28671:799161913cb385bad2dabef3e3e1ca8a4a40a73b564c43bb996d878aacc61edc",
  "all-without-knowledge/docker":
    "33948:8306fad43a8aec9011a17bcf126e94c6d2c94f201d526cc07600cfda95412996",
  "all-without-knowledge/selfhosted":
    "35622:5e3fca9e344f79015c7f9d5b99b0e6b60b95414a50db7b577c25a23f8e486122",
  "all-without-workspaceFiles/none":
    "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all-without-workspaceFiles/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all-without-workspaceFiles/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all-without-workspaceConnectors/none":
    "31084:01257b191777c1da74c45ea5fed03c15ddb715e88c7a7d26f7b99b90027c1864",
  "all-without-workspaceConnectors/docker":
    "36361:b770185db03c7fc51f2e8ce0e8354eb9bc64d04aaf1162c74738c790d45c8d2e",
  "all-without-workspaceConnectors/selfhosted":
    "38035:732921bfe0b38e79fef9b285e5f57d3c5ed2b519b714f6e03b51e891aab9291b",
  "all-without-workspaceAdmin/none":
    "29765:bb443a6c594720a4f6073f7a5d33118c2945227c12202a3a3e0dc8d82a1cfc70",
  "all-without-workspaceAdmin/docker":
    "35042:3a828449e812e0c8b6525122731c7cfc2c1c3f8fd2058f8b4f49b3bc5c99be93",
  "all-without-workspaceAdmin/selfhosted":
    "36716:248a21ce42807b5a5aa41b967908d1971e43eeeba65efc7a39ce72f644124848",
  "none-with-features/docker":
    "27515:570c9f3de9cf1ae140dc12b806f48e64af542a1d0a66e71d1442374770223051",
  "none-with-features/selfhosted":
    "29189:433f932205d9b2d9824baa23ed62acbb83ad452433ffa26472475eeea4f39586",
  "none-with-features-and-workspace/none":
    "22403:201f84e4c9994974029dc801e0facca9a2261df060d5269c121ee336fcafa3ad",
  "none-with-features-manage/none":
    "21155:d66d9c14dcd7f70554440e5d01ab4f90bf58fde120f8087013935a76866783d9",
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
