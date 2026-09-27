import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  CODEMODE_PROGRAMMATIC_DIRECTIVE,
  composeRuntimeSkills,
  coreInstructions,
} from "../src/index";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../src/operational-instructions";

describe("provider-neutral operational instructions", () => {
  test("routes missing integrations through one provider-neutral human setup flow", () => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("# Integration setup");
    const end = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("# Session coordination", start);
    const guidance = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(guidance).toContain("`capability_catalog_search`");
    expect(guidance).toContain("`capability_authorization_request`");
    expect(guidance).toContain("Use available integration tools directly");
    expect(guidance).toContain("`setup.nextAction`");
    expect(guidance).toContain("does not need integration-management permission");
    expect(guidance).toContain("authenticated human must authorize");
    expect(guidance).not.toMatch(/github|gmail|slack|atlassian/i);
    expect(guidance.length).toBeLessThan(1000);
  });

  test("asks about out-of-scope architecture without blocking authorized choices", () => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "Decide the design before building it.",
    );
    const end = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("# Destructive Actions", start);
    const guidance = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(guidance).toContain("check whether OpenGeni already provides the capability natively");
    expect(guidance).toContain(
      "a Site reaches the model and workspace tools through the host bridge",
    );
    expect(guidance).toContain(
      "Follow the project's established architecture and choices the user has already authorized or delegated",
    );
    expect(guidance).toContain(
      "Ask before making a new external commitment or materially departing from the established architecture beyond the authorized scope",
    );
    expect(guidance).toContain("do not start parallel work that assumes the unresolved choice");
    expect(guidance).toContain("The absence of a native path alone does not require a question");
    expect(guidance).not.toContain(
      "Do not commit to a host, provider, or credential the user did not name",
    );
    expect(guidance.length).toBeLessThan(1000);
  });

  test("allows Connect cards for established or delegated designs", () => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("# Integration setup");
    const end = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("# Session coordination", start);
    const guidance = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, end);
    expect(guidance).toContain(
      "A card is for an integration required by the authorized design, including established or delegated choices",
    );
    expect(guidance).toContain("Resolve out-of-scope architecture choices before requesting setup");
  });

  test("separates command observation from conversation and diagnostic reads concisely", () => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "Use `session_events` for conversation history",
    );
    const end = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf("If the user asks to create", start);
    const guidance = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(guidance).toContain("Cursors only paginate");
    expect(guidance).toContain("Audit reads do not acknowledge command completion");
    expect(guidance).toContain("`command_read`");
    expect(guidance).toContain("`command_wait`");
    expect(guidance).toContain("`command_input` only to send input");
    expect(guidance).toContain("a running read does not");
    expect(guidance).toContain("Earlier tool results and delivered messages never change");
    expect(guidance.length).toBeLessThan(1600);
  });

  test("prefers the attempt-provided native Codemode client over an older installed CLI", () => {
    expect(CODEMODE_PROGRAMMATIC_DIRECTIVE).toContain(
      "prefer the connection-bound native client even if an older `ogtool` is installed",
    );
    expect(CODEMODE_PROGRAMMATIC_DIRECTIVE).toContain("OPENGENI_CODEMODE_NATIVE_CLIENT");
    expect(CODEMODE_PROGRAMMATIC_DIRECTIVE).toContain("OPENGENI_CODEMODE_CLIENT_MODULE");
    expect(CODEMODE_PROGRAMMATIC_DIRECTIVE).toContain(
      "do not import the older image-baked package",
    );
  });

  test("does not carry Codex-only runtime language", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("You are Codex");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("GPT-5");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("$CODEX_HOME");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`commentary` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`final` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("skill://");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("orchestrator");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("/abs/path");
  });

  test("teaches OpenGeni sandbox file links with optional line numbers", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.py](sandbox:/workspace/app.py:12)");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "[My Component.ts](<sandbox:/workspace/My Project/My Component.ts:3>)",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "a Connected Machine instead uses its host-native workspace root",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("`/home/u/proj` or `C:/repo`");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Both are valid inside a `sandbox:` link when they are the active workspace.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.py](sandbox:/home/u/proj/app.py:12)");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.ts](<sandbox:C:/repo/app.ts:12>)");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "In managed sandboxes, never link directly to `/tmp`",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "or any file outside the current workspace",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "copy it into the current workspace before responding",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("canonical sandbox path");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "absolute file links may point outside the working directory",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("a host path");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("host-absolute paths");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Do not provide ranges of lines.");
  });

  test("answers in chat by default and routes document deliverables before local-file guidance", () => {
    const reportRouting = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "Answer in chat by default, including summaries and reports",
    );
    const localLinks = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "When referencing a real local source file",
    );
    expect(reportRouting).toBeGreaterThan(-1);
    expect(localLinks).toBeGreaterThan(reportRouting);
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain(
      "User-facing reports are durable document Artifacts by default",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain(
      "including audit or summary reports produced while doing another task",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "only when the user asks for a document or file, or when the deliverable is large (multi-page) or clearly meant to be kept or shared",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "give a short summary and the artifact link in chat, not a full restatement",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Read the opengeni-documents Skill and create the native document artifact before authoring",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "including ones discovered after the goal was created",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Inspect the relevant final artifact head after the last edit",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("artifact reference returned by the tools");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("My Report.md");
  });

  test("keeps failed report delivery incomplete without banning legitimate local links", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "If artifact creation, inspection, access, or delivery tooling is unavailable or fails",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("leave report delivery incomplete");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Do not silently fall back to a sandbox link",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Ordinary in-chat answers, brief progress updates, internal worker findings, source-code navigation, and explicitly requested local-file workflows do not become report deliverables",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.py](sandbox:/workspace/app.py:12)");
  });

  test("is non-configurable and precedes every workspace persona", () => {
    for (const sandboxBackend of ["none", "docker"] as const) {
      const agent = buildOpenGeniAgent(testSettings({ sandboxBackend }), [], {
        instructionsTemplate: "CUSTOM WORKSPACE PERSONA {{core}}",
        workspaceGovernance: "STRUCTURED WORKSPACE GOVERNANCE",
        sessionInstructions: "SESSION-SPECIFIC INSTRUCTIONS",
      });
      expect(agent.instructions.startsWith(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBe(true);
      expect(agent.instructions.split(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toHaveLength(2);
      expect(agent.instructions).toContain("CUSTOM WORKSPACE PERSONA");
      expect(agent.instructions.indexOf(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBeLessThan(
        agent.instructions.indexOf("CUSTOM WORKSPACE PERSONA"),
      );
      expect(agent.instructions.indexOf("CUSTOM WORKSPACE PERSONA")).toBeLessThan(
        agent.instructions.indexOf("STRUCTURED WORKSPACE GOVERNANCE"),
      );
      expect(agent.instructions.indexOf("STRUCTURED WORKSPACE GOVERNANCE")).toBeLessThan(
        agent.instructions.indexOf("SESSION-SPECIFIC INSTRUCTIONS"),
      );
    }
  });

  test("requires selective child delegation and a terminal-result join", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "only for a concrete, bounded subtask that can run independently",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Do not delegate a scope that you will also perform yourself.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain('waitFor: "completion"');
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "A `goal.completed` event records goal state but is not a terminal child result",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("continuation segment settlements");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("pausing an ancestor also stops you");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Keep the accepted update/turn ID");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "an older in-flight turn finishing does not prove your input was consumed",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Do not repeatedly send unconsumed input");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Preserve explicit human pauses and approvals",
    );
  });

  test("answers a question asked mid-run with a final response instead of resuming work", () => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "The user may send a new message while you are still working.",
    );
    const end = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(
      "When earlier context is compacted",
      start,
    );
    const guidance = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(guidance).not.toContain("provide the update and then progress with the task");
    expect(guidance).toContain(
      "If it only asks a question or for status, answer it without starting or resuming other work in that turn unless the user asks.",
    );
    expect(guidance).toContain(
      "If nothing is in flight, the answer is your final response: an active goal continues on its own, and without one, offer to continue when work remains.",
    );
    expect(guidance).toContain("acknowledgement, not approval");
  });

  test("keeps a status answer short and in the user's terms", () => {
    // Benchmark status replies led with plumbing such as "this session didn't
    // inherit its credentials" instead of progress.
    // A blocker only the user can clear (a missing credential, a tool approval
    // a worker is waiting on) must still reach them.
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Keep a status answer to one or two sentences about progress in the user's terms, without session, credential, or tool mechanics; name a blocker only when the user must act on it, and say what they need to do.",
    );
  });

  test("a question asked during a wait keeps the wait so in-flight results still resume the agent", () => {
    // A newer finished turn supersedes a registered wait, and child or command
    // results wake a goal-less session only while a wait is held. A question
    // turn that answered and ended would silently drop the watch; with an
    // active goal it instead starts a continuation that rediscovers the same
    // wait. The re-wait rule must not be conditional on having no goal.
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "If work you already started is still in flight (a child, a command, or a timed recheck), give the answer, then call `wait_for_input` when available so its result resumes you, even when a goal is active.",
    );
    // Each turn's wait sets a fresh absolute deadline from its timeout, so a
    // re-wait with the full timeout would push a timed recheck back on every
    // status question.
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "If you were already waiting, reuse that reason and keep its deadline by setting the timeout to the time left rather than a fresh full timeout.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("again with the same reason");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain(
      "Otherwise the answer is your final response: an active goal continues on its own",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "do not post a status right before `wait_for_input` unless it answers the user",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "For ordinary background commands, register that session-level wait before ending your turn.",
    );
  });

  test("holds an unchanged external wait outside question turns without stalling useful work", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Outside a question or status turn, do not end with only a status reply and leave an immediate continuation",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "only when further progress genuinely depends on unchanged work already in flight",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Do not use `wait_for_input` for work you can still advance or for a blocker that requires a human decision.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "A continuation that only confirms the same unchanged wait calls `wait_for_input` and ends without restating the status unless you found material new information.",
    );
    // Any turn may end with a wait instead of a final response, so a turn that
    // starts long work and waits still has a compliant ending.
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "a turn that ends with `wait_for_input` has none, and its reason is the user-visible status.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain(
      "unchanged-wait `wait_for_input` continuation",
    );
  });
});

describe("proportional effort", () => {
  const section = (heading: string) => {
    const start = OPENGENI_OPERATIONAL_INSTRUCTIONS.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const next = OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start + heading.length).search(/\n#+ /);
    return next === -1
      ? OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start)
      : OPENGENI_OPERATIONAL_INSTRUCTIONS.slice(start, start + heading.length + next);
  };

  test("scales work to the request and reuses the earlier approach on repeat asks", () => {
    const guidance = section("## Match effort to the request");
    expect(guidance).toContain("A simple question or lookup gets a direct answer");
    expect(guidance).toContain("do not verify beyond what the question needs");
    expect(guidance).toContain("Waiting is the user's main cost");
    expect(guidance).toContain(
      "research or comparison questions, still get the full effort they need.",
    );
    // What a sourced answer contains is decided in the final answer, not here.
    expect(guidance).not.toContain("link the sources you rely on");
    expect(guidance).toContain('"check again"');
    expect(guidance).toContain("reuse the approach");
    expect(guidance).toContain("instead of rediscovering");
  });

  test("keeps progress updates short and skips the opening update for quick answers", () => {
    const guidance = section("## Progress updates");
    expect(guidance).not.toContain("If the request requires tools, start with a progress update");
    expect(guidance).not.toContain("more than 60 seconds");
    expect(guidance).toContain("one short, plain sentence");
    expect(guidance).toContain(
      "Skip the opening update when you expect to answer within about 20 seconds",
    );
    expect(guidance).toContain("at least every two minutes");
    expect(guidance).toContain("Do not narrate Skill reads or waits");
    expect(guidance).toContain("do not post a status right before `wait_for_input`");
  });

  test("puts a blank line before every heading so the contract renders as Markdown", () => {
    const lines = OPENGENI_OPERATIONAL_INSTRUCTIONS.split("\n");
    const crowded = lines.filter(
      (line, index) => /^#+ /.test(line) && index > 0 && lines[index - 1] !== "",
    );
    expect(crowded).toEqual([]);
  });

  test("leads final answers with the answer and keeps simple answers short", () => {
    const guidance = section("## Final answer");
    expect(guidance).toContain("Put the answer or outcome in the first sentence");
    expect(guidance).toContain("a few sentences or one table");
    expect(guidance).toContain("to the minute");
  });

  test("keeps source-backed answers short but not partial", () => {
    const guidance = section("## Final answer");
    expect(guidance).toContain(
      "An answer built from web or published sources (research, evidence summaries, product or price comparisons) may be short but not partial: summarize what the sources establish, including the best-supported finding, not only the practical takeaway; give figures in the user's terms, such as a monthly total at their stated size rather than only a starting price or unit rate; and link the source next to each study or figure you cite.",
    );
  });

  test("reads a Skill once, without announcing it or triggering on keywords", () => {
    const guidance = section("# Using skills");
    expect(guidance).not.toContain("Briefly tell the user which skills you are using");
    expect(guidance).not.toContain("Do not carry skills across turns");
    expect(guidance).toContain("not because of keyword matches");
    expect(guidance).toContain("do not read it again");
    expect(guidance).toContain("Do not announce Skill reads");
  });

  test("drops directives that pushed simple asks toward audits", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("evidence-backed response");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("exhaust safe in-scope checks");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("point out likely pitfalls");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("in proportion to the question");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Do not introduce unsolicited warnings");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("stop optional verification");
  });

  test("the default persona is a general assistant with repository-conditional code guidance", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    const instructions = agent.instructions as string;
    expect(instructions).toContain("general assistant");
    expect(instructions).not.toMatch(/Checkov|Terraform|GitOps/);
    // Branches, commits, and pull requests are conditional on a remote plus
    // credentials, or on the user asking. An unconditional branch clause made
    // every benchmark coding run create a branch in a repository without a
    // remote, and a blocker clause ended every answer with pull-request talk.
    expect(instructions).toContain(
      "When the Git repository you change has a remote and git provider credentials are available, work on a focused branch and open a pull request.",
    );
    // A repository with a remote but no credentials still says the changes
    // are not pushed, so the user does not assume they were.
    expect(instructions).toContain(
      "Otherwise leave changes in the working tree and do not create or mention branches, commits, or pull requests unless the user asks; if the repository has a remote, say the changes are not pushed, and if the user asks for something you cannot make, say what blocks it.",
    );
    expect(instructions).not.toContain("make code changes on a focused branch with a pull request");
    expect(instructions).not.toContain("report the exact commands and blockers");
    expect(instructions).toContain("Attached files are mounted read-only");
    expect(instructions).toContain("pre-authenticated");
  });

  test("a question does not resume a paused goal", () => {
    const goalLine = coreInstructions()[0]!;
    expect(goalLine).toContain("opengeni__goal_complete");
    expect(goalLine).not.toContain("regardless of who paused it or why;");
    expect(goalLine).toContain("when the user asks you to continue");
    expect(goalLine).toContain("A question alone is not such a request");
  });

  test("bundled Skill descriptors apply when asked or clearly useful, never proactively", () => {
    const { index } = composeRuntimeSkills([], {
      editableArtifacts: true,
      sites: true,
      videoGeneration: true,
    });
    const descriptions = new Map(index.map((entry) => [entry.name, entry.description]));
    expect(descriptions.get("opengeni-sites")).toBeDefined();
    expect(descriptions.get("opengeni-visualize")).toBeDefined();
    for (const [name, description] of descriptions) {
      expect(description, name).not.toMatch(/proactively|even when the user doesn't name/i);
    }
    expect(descriptions.get("opengeni-sites")).toContain("Use when the user asks");
    expect(descriptions.get("opengeni-visualize")).toContain("Use when the user asks");
  });
});
