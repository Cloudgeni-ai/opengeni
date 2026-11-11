import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute the production declarations with held I/O, not a second concurrency
// implementation. The placement check pins the authority and history boundaries.
const source = readFileSync(
  new URL("../src/activities/agent-turn/tool-environment.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf(
  "const [workspaceResult, skillConfigurationResult, sharedSkillsResult]",
);
const end = source.indexOf("const selectedFirstPartyMcpTools", start);
if (start < 0 || end < 0) throw new Error("Missing startup metadata stage");
// The stage reads the personal Skill index under this module-level bound.
const personalSkillBound = /^const PERSONAL_SKILL_MARKDOWN_MAX_BYTES = [^;\n]+;$/mu.exec(
  source,
)?.[0];
if (!personalSkillBound) throw new Error("Missing personal Skill index bound");
const stage = new Function(
  "ports",
  "options",
  `
  const { requireWorkspace, getWorkspaceVideoGenerationPolicy, listSkillDescriptors } = ports;
  ${personalSkillBound}
  const db = {}, input = { accountId: "account", workspaceId: "workspace" }, turn = {};
  const deps = { fileAuthoritySubjectId: "human" };
  const toolFamilies = { skills: options.skills };
  const videoSkillSelected = options.video;
  const scheduledTurnMcpServerIds = () => options.scheduled ? [] : null;
  return (async () => {
    ${source.slice(start, end)}
    return [workspaceResult.value, skillConfiguration, sharedSkillDescriptors];
  })();
`,
) as (
  ports: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options: {
    skills: false | "read";
    video: boolean;
    scheduled: boolean;
  },
) => Promise<unknown[]>;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const readers = ["requireWorkspace", "getWorkspaceVideoGenerationPolicy", "listSkillDescriptors"];
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

for (const first of [0, 1, 2]) {
  test(`all metadata reads start before any settles; completion order ${first}`, async () => {
    const reads = readers.map(deferred);
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const running = stage(
      Object.fromEntries(
        readers.map((name, i) => [
          name,
          (...args: unknown[]) => {
            calls.push({ name, args });
            return reads[i]!.promise;
          },
        ]),
      ),
      { skills: "read", video: true, scheduled: false },
    );
    let settled = false;
    void running.finally(() => {
      settled = true;
    });
    expect(calls.map((call) => call.name)).toEqual(readers);
    reads[first]!.resolve(first);
    await flush();
    expect(settled).toBe(false);
    for (const [i, read] of reads.entries()) read.resolve(i);
    expect(await running).toEqual([0, 1, 2]);
    expect(calls[0]!.args[1]).toBe("workspace");
    expect(calls[1]!.args[1]).toBe("workspace");
    expect(calls[2]!.args[1]).toEqual({
      accountId: "account",
      workspaceId: "workspace",
      subjectId: "human",
    });
    expect(calls[2]!.args[2]).toEqual({ personalSkillMarkdownMaxBytes: 8 * 1024 });
  });
}

for (const failed of [0, 1, 2]) {
  test(`failure ${failed} waits for every scope before propagating`, async () => {
    const reads = readers.map(deferred);
    const failure = new Error(`read ${failed} failed`);
    const running = stage(
      Object.fromEntries(readers.map((name, i) => [name, () => reads[i]!.promise])),
      { skills: "read", video: true, scheduled: false },
    );
    let settled = false;
    const observed = running.catch((error) => {
      settled = true;
      return error;
    });
    reads[failed]!.reject(failure);
    await flush();
    expect(settled).toBe(false);
    for (const read of reads) read.resolve(null);
    expect(await observed).toBe(failure);
  });
}

test("scheduled and disabled metadata branches remain absent", async () => {
  const calls: string[] = [];
  const ports = Object.fromEntries(
    readers.map((name) => [
      name,
      async () => {
        calls.push(name);
        return name;
      },
    ]),
  );
  expect(await stage(ports, { skills: false, video: false, scheduled: true })).toEqual([
    null,
    null,
    [],
  ]);
  expect(calls).toEqual([]);
  expect(await stage(ports, { skills: "read", video: false, scheduled: false })).toEqual([
    readers[0],
    null,
    readers[2],
  ]);
  expect(calls).toEqual([readers[0]!, readers[2]!]);
});

test("workspace error retains precedence and no independent read escapes the join", async () => {
  const failures = readers.map((name) => new Error(name));
  await expect(
    stage(
      Object.fromEntries(
        readers.map((name, i) => [
          name,
          async () => {
            throw failures[i];
          },
        ]),
      ),
      { skills: "read", video: true, scheduled: false },
    ),
  ).rejects.toBe(failures[0]);
});

test("linked authority precedes metadata; catalog history and live video checks stay ordered", () => {
  expect(source.indexOf('throw new Error("Native identity link was revoked")')).toBeLessThan(start);
  expect(end).toBeLessThan(source.indexOf("runtime.prepareTools("));
  const agent = readFileSync(
    new URL("../src/activities/agent-turn/agent-build.ts", import.meta.url),
    "utf8",
  );
  expect(agent.match(/await recoveryAwareSessionInstructions\(/g)).toHaveLength(1);
  expect(agent.match(/getWorkspaceVideoGenerationPolicy\(/g)).toHaveLength(1);
  expect(agent.indexOf("await recoveryAwareSessionInstructions(")).toBeLessThan(
    agent.indexOf("await ensureSessionSkillCatalog("),
  );
  expect(agent.indexOf("await ensureSessionSkillCatalog(")).toBeLessThan(
    agent.indexOf("await ensureSessionWorkspaceGovernance("),
  );
  expect(agent.indexOf("await ensureSessionWorkspaceGovernance(")).toBeLessThan(
    agent.indexOf("await getExternalLinkTurnAuthorization("),
  );
});
