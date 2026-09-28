// Times skill_checkout against a real Docker sandbox behind a routing session
// that counts provider commands, durable mutation admissions, and change
// events. Opt in with OPENGENI_SKILL_CHECKOUT_LIVE=1 (image override:
// OPENGENI_SKILL_CHECKOUT_LIVE_IMAGE; simulated admission and settlement
// latency: OPENGENI_SKILL_CHECKOUT_LIVE_ADMISSION_MS).
import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { testSettings } from "@opengeni/testing";
import {
  establishSandboxSessionFromEnvelope,
  RoutingSandboxSession,
  SandboxChannelAService,
} from "@opengeni/runtime/sandbox";
import { checkoutSkillDirectory } from "../src/activities/agent-turn/skill-transfer";

const execFileAsync = promisify(execFile);
const enabled = process.env.OPENGENI_SKILL_CHECKOUT_LIVE === "1";
const image = process.env.OPENGENI_SKILL_CHECKOUT_LIVE_IMAGE ?? "opengeni-sandbox:local";
const admissionMs = Number(process.env.OPENGENI_SKILL_CHECKOUT_LIVE_ADMISSION_MS ?? "0");
const runs = 7;
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
});

/** An 11-file, 31 KB Skill: SKILL.md, six scripts, four references. */
function analyticsSkill() {
  const lines = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `# line ${index}: compute the metric for the window\n`,
    ).join("");
  return [
    {
      path: "SKILL.md",
      content: `---\nname: analytics\ndescription: Answer product analytics questions\n---\n# Analytics\n${lines(90)}`,
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      path: `scripts/query_${index}.py`,
      content: `#!/usr/bin/env python3\n"""Usage: python scripts/query_${index}.py --from DATE --to DATE"""\n${lines(70)}`,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      path: `references/table_${index}.md`,
      content: `# Table ${index}\n${lines(45)}`,
    })),
  ];
}

test.skipIf(!enabled)(
  "skill checkout uses one sandbox command and one admission on a real Docker sandbox",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "opengeni-skill-checkout-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));
    const created = await establishSandboxSessionFromEnvelope(
      testSettings({ sandboxBackend: "docker", dockerImage: image, dockerWorkspaceBaseDir: base }),
      null,
      {
        sessionId: "skill-checkout-live",
        recovery: "create-or-restore",
        backendOverride: "docker",
        environment: {},
      },
    );
    cleanup.push(() => execFileAsync("docker", ["rm", "-f", created.instanceId]));
    const counts = { commands: 0, admissions: 0, events: 0 };
    const routing = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: created.session as never,
        sandboxId: null,
        kind: "docker",
        leaseEpoch: 1,
        providerInstanceId: created.instanceId,
        activeEpoch: 0,
      }),
      onOperation: () => {
        counts.commands += 1;
      },
      beforeMutation: async () => {
        counts.admissions += 1;
        if (admissionMs) await Bun.sleep(admissionMs);
        return {};
      },
      afterMutation: async () => {
        if (admissionMs) await Bun.sleep(admissionMs);
      },
    });
    const service = new SandboxChannelAService({
      session: routing as never,
      workspaceRoot: "/workspace",
      leaseEpoch: 1,
      emit: async (events) => {
        counts.events += events.length;
      },
    });
    const files = analyticsSkill();
    // Warm the exec path so the first sample is not a cold docker exec.
    await service.fsList({ path: "", depth: 1, maxEntries: 10, includeHidden: false });

    const scenarios = [
      { label: "fresh", directory: (run: number) => `skills/fresh-${run}`, paths: undefined },
      { label: "repeat", directory: () => "skills/fresh-0", paths: undefined },
      {
        label: "one script",
        directory: (run: number) => `skills/one-${run}`,
        paths: ["scripts/query_0.py"],
      },
    ];
    for (const scenario of scenarios) {
      const samples: number[] = [];
      let perRun = { ...counts };
      for (let run = 0; run < runs; run += 1) {
        const before = { ...counts };
        const started = performance.now();
        await checkoutSkillDirectory(
          service,
          scenario.directory(run),
          files,
          scenario.paths ? { paths: scenario.paths } : {},
        );
        samples.push(performance.now() - started);
        perRun = {
          commands: counts.commands - before.commands,
          admissions: counts.admissions - before.admissions,
          events: counts.events - before.events,
        };
      }
      samples.sort((left, right) => left - right);
      console.log(
        JSON.stringify({
          scenario: scenario.label,
          files: files.length,
          admissionMs,
          medianMs: Math.round(samples[Math.floor(samples.length / 2)]!),
          ...perRun,
        }),
      );
      expect(perRun.commands).toBe(1);
      expect(perRun.admissions).toBe(1);
    }
    const listed = await service.fsRead({
      path: "skills/fresh-0/scripts/query_5.py",
      encoding: "utf8",
      maxBytes: 64 * 1024,
    });
    expect(listed.content).toBe(files.find((file) => file.path === "scripts/query_5.py")!.content);
  },
  600_000,
);
