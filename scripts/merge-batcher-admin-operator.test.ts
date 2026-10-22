import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { cli, type Snapshot } from "../docs/merge-batcher-admin/bundle";
import manifest from "../docs/merge-batcher-admin/app-manifest.json";
import { bindStop, verifyStop } from "../docs/merge-batcher-admin/off";

const directory = resolve(import.meta.dir, "../docs/merge-batcher-admin");
const stopped = {
  command: "stop",
  disabled: true,
  manualZero: true,
  taggedRevisionsMayRemain: false,
  stopPersisted: true,
  drainProven: true,
  forced: false,
  priorDrainProof: false,
  outcome: "drained-state-observed",
  stateBefore: "a".repeat(40),
  stateAfter: "a".repeat(40),
  writer: {
    state: "stopped",
    writerActive: false,
    writerPid: null,
    uncertainOutcome: false,
    reconciliationRequired: false,
  },
};
const deployment = {
  uid: "fixture-uid",
  image: `example.test/image@sha256:${"b".repeat(64)}`,
  uri: "https://fixture.test",
  stopProof: { uid: "fixture-uid", stateSha: "a".repeat(40), outcome: "drained-state-observed" },
};

async function offHarness(h: Awaited<ReturnType<typeof harness>>) {
  const runtime = join(h.root, "runtime");
  await mkdir(runtime);
  await writeFile(join(runtime, "deployment-receipt.json"), JSON.stringify(deployment));
  for (const file of ["cloud-auth.ts", "service-config.ts", "service-limits.ts"])
    await writeFile(join(runtime, file), "export {};\n");
  await writeFile(
    join(runtime, "control.ts"),
    `
if(process.argv[2]!=='stop')throw Error('stop only');
await Bun.write(process.env.FIXTURE_LOG,await Bun.file(process.env.FIXTURE_LOG).text()+JSON.stringify({endpoint:'runtime-stop',method:'STOP'})+'\\n');
const result={...${JSON.stringify(stopped)},...JSON.parse(process.env.STOP_OVERRIDE||'{}')};
console.log(JSON.stringify(result));
if(process.env.STOP_FAILURE)process.exitCode=2;
`,
  );
  await bindStop(h.root, runtime);
  return {
    runtime,
    async run(extra: Record<string, string> = {}, flag = "--apply-after-go") {
      const child = Bun.spawn(["bun", join(directory, "off.ts"), "run", h.root, flag], {
        env: { ...h.fixtureEnv, ...extra },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}
// Fake provider only: requests are logged without credentials, all remote state
// is a test-owned JSON file. No invocation can reach the real gh executable.
const fakeProvider = `#!/usr/bin/env bun
import {statSync} from "node:fs";
const state = JSON.parse(await Bun.file(process.env.FIXTURE_STATE).text());
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith("https://api.github.com/"));
const endpoint = url ? new URL(url).pathname : args.find(a => a.startsWith("/")) ?? (args.includes("graphql") ? "graphql" : "");
const method = args.includes("--method") ? args[args.indexOf("--method")+1] : "GET";
const headerArg = args.includes("--header") ? args[args.indexOf("--header")+1] : args.includes("-H") ? args[args.indexOf("-H")+1] : "";
const header = headerArg.startsWith("@") ? (await Bun.file(headerArg.slice(1)).text()).trim() : headerArg;
const event = { endpoint, method, bearer: header === "Authorization: Bearer fixture.jwt.value", jwtInArgv:args.some(a=>a.includes("fixture.jwt.value")), headerMode:headerArg.startsWith("@") ? statSync(headerArg.slice(1)).mode & 0o777 : null, debug:!!process.env.GH_DEBUG };
await Bun.write(process.env.FIXTURE_LOG, (await Bun.file(process.env.FIXTURE_LOG).text()) + JSON.stringify(event) + "\\n");
const output = value => console.log(JSON.stringify(value));
if(method !== "GET") {
  if(process.env.FAIL_WRITE === "before") process.exit(1);
  if(process.env.FAIL_WRITE === "422") { console.error("HTTP 422 invalid parameter"); process.exit(1); }
  let result = {};
  const id = Number(endpoint.split("/").at(-1));
  if(method === "POST") {
    result = { ...await Bun.file(args[args.indexOf("--input")+1]).json(), id: 200 + state.rulesets.length, source_type:"Repository", source:"Cloudgeni-ai/opengeni" };
    state.rulesets.push(result);
  } else if(method === "PUT") {
    result = { ...state.rulesets.find(r => r.id === id), ...await Bun.file(args[args.indexOf("--input")+1]).json() };
    state.rulesets = state.rulesets.map(r => r.id === id ? result : r);
  } else if(method === "DELETE") state.rulesets = state.rulesets.filter(r => r.id !== id);
  if(process.env.WRITE_DRIFT && method === "PUT") state.rulesets.find(r=>r.id===id).enforcement="disabled";
  if(process.env.WRITE_DRIFT && method === "DELETE") state.rulesets.push({id:999,name:"unexpected"});
  await Bun.write(process.env.FIXTURE_STATE, JSON.stringify(state));
  if(process.env.FAIL_WRITE === "after") process.exit(1);
  output(result); process.exit(0);
}
if(endpoint === "/app") output({id:501,owner:{login:"Cloudgeni-ai"},...JSON.parse(process.env.APP_OVERRIDE || "{}")});
else if(endpoint === "/app/installations/999") output({id:999,app_id:501,account:{login:"Cloudgeni-ai"},repository_selection:"selected",suspended_at:null,permissions:{...JSON.parse(process.env.FIXTURE_PERMISSIONS),metadata:"read"},...JSON.parse(process.env.INSTALLATION_OVERRIDE || "{}")});
else if(endpoint === "/installation/repositories") output({repositories:[{full_name:"Cloudgeni-ai/opengeni"},...JSON.parse(process.env.EXTRA_REPOS || "[]")]});
else if(endpoint === "graphql") output(process.env.FAIL_CLASSIC ? {errors:[{message:"inaccessible"}]} : {data:{repository:{branchProtectionRules:state.classic}}});
else if(endpoint.includes("rulesets?")) {
 if(process.env.LIST_JSON) output(JSON.parse(process.env.LIST_JSON));
 else if(process.env.PAGINATED) { output(state.rulesets.slice(0,1)); if(args.includes("--paginate")) output(state.rulesets.slice(1)); }
 else output(state.rulesets);
}
else if(endpoint.includes("/rulesets/")) {
 if(process.env.FAIL_DETAIL === endpoint.split("/").at(-1)) process.exit(1);
 output(state.rulesets.find(r => r.id === Number(endpoint.split("/").at(-1))));
}
else if(endpoint === "/repos/Cloudgeni-ai/opengeni") output(state.repository);
else process.exit(2);
`;
const fakeSleep = `#!/usr/bin/env bun
await Bun.write(process.env.FIXTURE_SLEEP, process.argv.slice(2).join(" "));
if(process.env.APPEAR_ON_SLEEP) {
 const state = await Bun.file(process.env.FIXTURE_STATE).json();
 const rule = await Bun.file(process.env.APPEAR_ON_SLEEP).json();
 state.rulesets.push({...rule,id:203,source_type:"Repository",source:"Cloudgeni-ai/opengeni"});
 await Bun.write(process.env.FIXTURE_STATE, JSON.stringify(state));
}
if(process.env.DRIFT_ON_SLEEP) {
 const state = await Bun.file(process.env.FIXTURE_STATE).json();
 state.rulesets[0].enforcement="disabled";
 await Bun.write(process.env.FIXTURE_STATE, JSON.stringify(state));
}
`;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "batcher-admin-operator-"));
  await mkdir(join(root, "bin"));
  const before: Snapshot = {
    repository: Object.assign(
      { full_name: "Cloudgeni-ai/opengeni", default_branch: "main", allow_squash_merge: true },
      { allow_auto_merge: false, allow_merge_commit: true, allow_rebase_merge: false },
    ),
    classic: { nodes: [], pageInfo: { hasNextPage: false } },
    rulesets: [
      {
        id: 101,
        name: "Protection",
        source_type: "Repository",
        source: "Cloudgeni-ai/opengeni",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          {
            type: "pull_request",
            parameters: {
              allowed_merge_methods: ["squash"],
              require_extra_approval_for_unattributed_changes: true,
            },
          },
        ],
      },
    ],
  };
  const state = join(root, "state.json");
  const log = join(root, "requests.jsonl");
  await writeFile(state, JSON.stringify(before));
  await writeFile(log, "");
  for (const [name, body] of [
    ["gh", fakeProvider],
    ["curl", fakeProvider],
    ["sleep", fakeSleep],
  ]) {
    await writeFile(join(root, "bin", name!), body!);
    await chmod(join(root, "bin", name!), 0o700);
  }
  await cli(["prepare", state, "501", "999", join(root, "plan")]);
  const fixtureEnv = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GH_TOKEN: "fixture-admin",
    APP_JWT: "fixture.jwt.value",
    INSTALLATION_TOKEN: "fixture-installation",
    APP_ID: "501",
    INSTALLATION_ID: "999",
    FIXTURE_STATE: state,
    FIXTURE_LOG: log,
    FIXTURE_SLEEP: join(root, "sleep.txt"),
    FIXTURE_PERMISSIONS: JSON.stringify(manifest.default_permissions),
  };
  async function run(action: string, arg = "", extra: Record<string, string> = {}) {
    const processHandle = Bun.spawn(
      ["bash", join(directory, "stage.sh"), root, action, ...(arg ? [arg] : [])],
      {
        env: { ...fixtureEnv, ...extra },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  async function events(): Promise<
    {
      endpoint: string;
      method: string;
      bearer: boolean;
      jwtInArgv: boolean;
      headerMode: number | null;
      debug: boolean;
    }[]
  > {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const identity = await run("identity");
  if (identity.code !== 0) throw new Error(`Fixture identity failed: ${identity.stderr}`);
  await writeFile(log, "");
  return {
    root,
    state,
    run,
    events,
    fixtureEnv,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("checked-in shell helpers parse; sourcing read-only definitions has no effects", () => {
  for (const file of ["read.sh", "stage.sh"]) execFileSync("bash", ["-n", join(directory, file)]);
  const output = execFileSync(
    "bash",
    [
      "-c",
      'before=$-; source "$1"; test "$before" = "$-"; printf ok',
      "fixture",
      join(directory, "read.sh"),
    ],
    { encoding: "utf8" },
  );
  expect(output).toBe("ok");
});
test("both App-JWT GETs use explicit Bearer, without logging the secret", async () => {
  const h = await harness();
  try {
    const result = await h.run("identity", "", { GH_DEBUG: "api" });
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("fixture.jwt.value");
    expect((await h.events()).filter((e) => e.endpoint.startsWith("/app"))).toEqual([
      {
        endpoint: "/app",
        method: "GET",
        bearer: true,
        jwtInArgv: false,
        headerMode: 0o600,
        debug: false,
      },
      {
        endpoint: "/app/installations/999",
        method: "GET",
        bearer: true,
        jwtInArgv: false,
        headerMode: 0o600,
        debug: false,
      },
    ]);
    for (const name of (await readdir(h.root)).filter((entry) => entry.startsWith("identity."))) {
      expect(await Bun.file(join(h.root, name, "authorization.header")).exists()).toBe(false);
    }
  } finally {
    await h.close();
  }
});
test("explicit write opt-in, unknown actions and classic-read failure issue zero writes", async () => {
  const h = await harness();
  try {
    expect((await h.run("create-guard")).code).not.toBe(0);
    expect((await h.run("unknown", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("create-guard", "--apply-after-go", { FAIL_CLASSIC: "1" })).code).not.toBe(
      0,
    );
    expect((await h.events()).filter((e) => e.method !== "GET")).toEqual([]);
  } finally {
    await h.close();
  }
});
test("each fresh process can resume the complete setup and exact reverse restoration", async () => {
  const h = await harness();
  try {
    for (const action of [
      "create-guard",
      "create-namespace",
      "admit",
      "restore-admission",
      "delete-namespace",
      "delete-guard",
    ]) {
      const result = await h.run(action, "--apply-after-go");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }
    expect((await h.run("check", "restored")).code).toBe(0);
    expect((await h.events()).filter((e) => e.method !== "GET").map((e) => e.method)).toEqual([
      "POST",
      "POST",
      "PUT",
      "PUT",
      "DELETE",
      "DELETE",
    ]);
  } finally {
    await h.close();
  }
});
test("ambiguous POST survives restart and reconciles without replay, then partial rollback", async () => {
  const h = await harness();
  try {
    expect(
      (await h.run("create-guard", "--apply-after-go", { FAIL_WRITE: "after" })).code,
    ).not.toBe(0);
    expect((await h.run("create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("reconcile-guard")).code).toBe(0);
    expect((await h.run("reconcile-guard")).code).toBe(0);
    expect((await h.events()).filter((e) => e.method === "POST")).toHaveLength(1);
    expect((await h.run("delete-guard", "--apply-after-go")).code).toBe(0);
    expect((await h.run("check", "restored")).code).toBe(0);
  } finally {
    await h.close();
  }
});
test("empty ambiguous outcome waits and stays blocked, with no blind POST retry", async () => {
  const h = await harness();
  try {
    expect(
      (await h.run("create-guard", "--apply-after-go", { FAIL_WRITE: "before" })).code,
    ).not.toBe(0);
    expect((await h.run("reconcile-guard")).code).not.toBe(0);
    expect(await readFile(join(h.root, "sleep.txt"), "utf8")).toBe("30");
    expect((await h.run("reissue-create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).filter((e) => e.method === "POST")).toHaveLength(1);
  } finally {
    await h.close();
  }
});
test("late POST appears only on delayed readback and is reconciled, not repeated", async () => {
  const h = await harness();
  try {
    expect(
      (await h.run("create-guard", "--apply-after-go", { FAIL_WRITE: "before" })).code,
    ).not.toBe(0);
    expect(
      (await h.run("reconcile-guard", "", { APPEAR_ON_SLEEP: join(h.root, "plan/guard.json") }))
        .code,
    ).toBe(0);
    expect((await h.events()).filter((e) => e.method === "POST")).toHaveLength(1);
    expect((await h.run("check", "guard")).code).toBe(0);
  } finally {
    await h.close();
  }
});
test("422 restore retains exact prior policy and blocks deleting protective rules", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace", "admit"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    const prior = await readFile(join(h.root, "plan/restore.json"), "utf8");
    expect(prior).toContain("require_extra_approval_for_unattributed_changes");
    expect(
      (await h.run("restore-admission", "--apply-after-go", { FAIL_WRITE: "422" })).code,
    ).not.toBe(0);
    expect((await h.run("check", "applied")).code).toBe(0);
    expect((await h.run("delete-namespace", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("delete-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).filter((e) => e.method === "DELETE")).toHaveLength(0);
    expect(await readFile(join(h.root, "plan/restore.json"), "utf8")).toBe(prior);
  } finally {
    await h.close();
  }
});

test("namespace POST and partial rollback DELETE ambiguities are readback-recoverable", async () => {
  const h = await harness();
  try {
    expect((await h.run("create-guard", "--apply-after-go")).code).toBe(0);
    expect(
      (await h.run("create-namespace", "--apply-after-go", { FAIL_WRITE: "after" })).code,
    ).not.toBe(0);
    expect((await h.run("reconcile-namespace")).code).toBe(0);
    expect(
      (await h.run("delete-namespace", "--apply-after-go", { FAIL_WRITE: "after" })).code,
    ).not.toBe(0);
    expect((await h.run("check", "guard")).code).toBe(0);
    expect(
      (await h.run("delete-guard", "--apply-after-go", { FAIL_WRITE: "after" })).code,
    ).not.toBe(0);
    expect((await h.run("check", "restored")).code).toBe(0);
    expect((await h.events()).filter((e) => e.method !== "GET").map((e) => e.method)).toEqual([
      "POST",
      "POST",
      "DELETE",
      "DELETE",
    ]);
  } finally {
    await h.close();
  }
});

test("ambiguous admission PUT is checked, not replayed", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go", { FAIL_WRITE: "after" })).code).not.toBe(0);
    expect((await h.run("check", "applied")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).filter((e) => e.method === "PUT")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("inherited rules are fetched from their organization and never assumed absent", async () => {
  const h = await harness();
  try {
    const state = JSON.parse(await readFile(h.state, "utf8")) as Snapshot;
    state.rulesets.push({
      id: 555,
      name: "Inherited",
      source_type: "Organization",
      source: "Cloudgeni-ai",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      rules: [{ type: "deletion" }],
    });
    await writeFile(h.state, JSON.stringify(state));
    const result = await h.run("snapshot");
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(result.stdout.trim(), "utf8")).rulesets).toHaveLength(2);
    expect((await h.events()).some((e) => e.endpoint === "/orgs/Cloudgeni-ai/rulesets/555")).toBe(
      true,
    );
    expect((await h.run("create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).some((e) => e.method !== "GET")).toBe(false);
  } finally {
    await h.close();
  }
});

test("identity rejects wrong App, installation, selection, suspension, permissions and repositories", async () => {
  const h = await harness();
  try {
    for (const invalid of [
      { APP_OVERRIDE: JSON.stringify({ id: 999 }) },
      { APP_OVERRIDE: JSON.stringify({ owner: { login: "foreign" } }) },
      { INSTALLATION_OVERRIDE: JSON.stringify({ app_id: 999 }) },
      { INSTALLATION_OVERRIDE: JSON.stringify({ id: 888 }) },
      { INSTALLATION_OVERRIDE: JSON.stringify({ repository_selection: "all" }) },
      { INSTALLATION_OVERRIDE: JSON.stringify({ suspended_at: "2026-10-22T00:00:00Z" }) },
      {
        INSTALLATION_OVERRIDE: JSON.stringify({
          permissions: {
            ...manifest.default_permissions,
            metadata: "read",
            administration: "write",
          },
        }),
      },
      { EXTRA_REPOS: JSON.stringify([{ full_name: "another/repository" }]) },
    ]) {
      expect((await h.run("identity", "", invalid as Record<string, string>)).code).not.toBe(0);
    }
    expect((await h.events()).some((e) => e.method !== "GET")).toBe(false);
  } finally {
    await h.close();
  }
});

test("write stages require identity bound to plan and exact generated payloads", async () => {
  const h = await harness();
  try {
    const receiptPath = join(h.root, "identity-receipt.json");
    const original = await readFile(receiptPath, "utf8");
    for (const change of [{ appId: 999 }, { installationId: 501 }]) {
      await writeFile(receiptPath, JSON.stringify({ ...JSON.parse(original), ...change }));
      expect((await h.run("create-guard", "--apply-after-go")).code).not.toBe(0);
    }
    await writeFile(receiptPath, original);
    const payloadPath = join(h.root, "plan/guard.json");
    const payload = JSON.parse(await readFile(payloadPath, "utf8"));
    payload.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
    await writeFile(payloadPath, JSON.stringify(payload));
    expect((await h.run("create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).some((e) => e.method !== "GET")).toBe(false);
  } finally {
    await h.close();
  }
});

test("snapshot pins pagination, nonempty array shape, unsupported sources and detail failures", async () => {
  const h = await harness();
  try {
    const state = JSON.parse(await readFile(h.state, "utf8")) as Snapshot;
    const another = { ...state.rulesets[0]!, id: 777, name: "another" };
    state.rulesets.push(another);
    await writeFile(h.state, JSON.stringify(state));
    const paginated = await h.run("snapshot", "", { PAGINATED: "1" });
    expect(paginated.code).toBe(0);
    expect(JSON.parse(await readFile(paginated.stdout.trim(), "utf8")).rulesets).toHaveLength(2);
    for (const list of [[], null, { rule: state.rulesets[0] }]) {
      expect((await h.run("snapshot", "", { LIST_JSON: JSON.stringify(list) })).code).not.toBe(0);
    }
    state.rulesets[1]!.source_type = "Enterprise";
    await writeFile(h.state, JSON.stringify(state));
    expect((await h.run("snapshot")).code).not.toBe(0);
    state.rulesets[1]!.source_type = "Repository";
    await writeFile(h.state, JSON.stringify(state));
    const direct = Bun.spawn(
      [
        "bash",
        "-c",
        'source "$1"; current=$(batcher_snapshot); code=$?; printf "%s" "$current"; exit "$code"',
        "fixture",
        join(directory, "read.sh"),
      ],
      {
        env: { ...h.fixtureEnv, ADMIN_DIR: h.root, FAIL_DETAIL: "777" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout] = await Promise.all([
      direct.exited,
      new Response(direct.stdout).text(),
      new Response(direct.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
  } finally {
    await h.close();
  }
});

test("creation reconciliation pins uniqueness, ownership, payload and full receipt validation", async () => {
  const h = await harness();
  try {
    expect(
      (await h.run("create-guard", "--apply-after-go", { FAIL_WRITE: "after" })).code,
    ).not.toBe(0);
    const original = JSON.parse(await readFile(h.state, "utf8")) as Snapshot;
    const receiptPath = join(h.root, "plan/guard-receipt.json");
    const duplicated = structuredClone(original);
    duplicated.rulesets.push({ ...duplicated.rulesets[1]!, id: 999 });
    await writeFile(h.state, JSON.stringify(duplicated));
    expect((await h.run("reconcile-guard")).stderr).toContain("No unique creation result");
    const foreign = structuredClone(original);
    foreign.rulesets[1]!.source = "foreign/repo";
    await writeFile(h.state, JSON.stringify(foreign));
    expect((await h.run("reconcile-guard")).stderr).toContain("No unique creation result");
    const drifted = structuredClone(original);
    drifted.rulesets[1]!.bypass_actors = [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ];
    await writeFile(h.state, JSON.stringify(drifted));
    expect((await h.run("reconcile-guard")).code).not.toBe(0);
    expect(await Bun.file(receiptPath).exists()).toBe(false);
    await writeFile(h.state, JSON.stringify(original));
    const retained = JSON.stringify({ ...original.rulesets[1], name: "wrong retained receipt" });
    await writeFile(receiptPath, retained);
    expect((await h.run("reconcile-guard")).code).not.toBe(0);
    expect(await readFile(receiptPath, "utf8")).toBe(retained);
    expect((await h.events()).filter((e) => e.method === "POST")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("successful provider response with changed post-state fails the write stage itself", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go", { WRITE_DRIFT: "1" })).code).not.toBe(0);
    expect(await Bun.file(join(h.root, "plan/admit-attempt/verified")).exists()).toBe(false);
  } finally {
    await h.close();
  }
});

test("reverse-only reissue archives failed attempts and reaches exact restoration", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace", "admit"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    for (const action of ["restore-admission", "delete-namespace", "delete-guard"]) {
      expect((await h.run(action, "--apply-after-go", { FAIL_WRITE: "before" })).code).not.toBe(0);
      const oldMeta = await readFile(
        join(h.root, `plan/${action}-attempt/request-meta.json`),
        "utf8",
      );
      expect((await h.run(`reissue-${action}`, "--apply-after-go")).code).toBe(0);
      expect(await readFile(join(h.root, "sleep.txt"), "utf8")).toBe("30");
      const archives = (await readdir(join(h.root, "plan"))).filter((n) =>
        n.startsWith(`${action}-archive.`),
      );
      expect(archives).toHaveLength(1);
      expect(
        await readFile(join(h.root, "plan", archives[0]!, "attempt/request-meta.json"), "utf8"),
      ).toBe(oldMeta);
      expect(await readFile(join(h.root, `plan/${action}-attempt/request-meta.json`), "utf8")).toBe(
        oldMeta,
      );
    }
    expect((await h.run("check-stable", "restored")).code).toBe(0);
    expect((await h.events()).filter((e) => e.method !== "GET").map((e) => e.method)).toEqual([
      "POST",
      "POST",
      "PUT",
      "PUT",
      "PUT",
      "DELETE",
      "DELETE",
      "DELETE",
      "DELETE",
    ]);
  } finally {
    await h.close();
  }
});

test("reverse reissue rejects changed second readback and any nonidentical request", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace", "admit"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect(
      (await h.run("restore-admission", "--apply-after-go", { FAIL_WRITE: "before" })).code,
    ).not.toBe(0);
    const before = await readFile(h.state, "utf8");
    expect(
      (await h.run("reissue-restore-admission", "--apply-after-go", { DRIFT_ON_SLEEP: "1" })).code,
    ).not.toBe(0);
    await writeFile(h.state, before);
    await writeFile(join(h.root, "plan/restore-admission-attempt/request.json"), "{}");
    expect((await h.run("reissue-restore-admission", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("reissue-create-guard", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("reissue-admit", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).filter((e) => e.method === "PUT")).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("unresolved forward PUT cannot lose its guard based on absent readback", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go", { FAIL_WRITE: "before" })).code).not.toBe(0);
    expect((await h.run("check-stable", "namespace")).code).toBe(0);
    expect((await h.run("reissue-admit", "--apply-after-go")).code).not.toBe(0);
    expect((await h.run("delete-namespace", "--apply-after-go")).code).not.toBe(0);
    expect((await h.events()).some((e) => e.method === "DELETE")).toBe(false);
  } finally {
    await h.close();
  }
});

test("observed applied forward PUT can be reconciled before reverse restoration", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go", { FAIL_WRITE: "after" })).code).not.toBe(0);
    expect((await h.run("reconcile-admit")).code).toBe(0);
    for (const action of ["restore-admission", "delete-namespace", "delete-guard"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
  } finally {
    await h.close();
  }
});

test("one-command OFF stops first, reconciles ambiguous admit, restores exact original and is reentrant", async () => {
  const h = await harness();
  try {
    const original = await readFile(h.state, "utf8");
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    expect((await h.run("admit", "--apply-after-go", { FAIL_WRITE: "after" })).code).not.toBe(0);
    await writeFile(h.fixtureEnv.FIXTURE_LOG, "");
    const operator = await offHarness(h);
    const result = await operator.run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("normal reviewed squash path restored");
    expect((await h.events())[0]?.method).toBe("STOP");
    expect(JSON.parse(await readFile(h.state, "utf8"))).toEqual(JSON.parse(original));
    const writes = (await h.events()).filter((e) => ["PUT", "DELETE", "POST"].includes(e.method));
    expect(writes.map((e) => e.method)).toEqual(["PUT", "DELETE", "DELETE"]);
    expect(await Bun.file(join(h.root, "plan", "admit-attempt", "verified")).exists()).toBe(true);
    await writeFile(h.fixtureEnv.FIXTURE_LOG, "");
    expect((await operator.run()).code).toBe(0);
    expect((await h.events()).some((e) => ["PUT", "DELETE", "POST"].includes(e.method))).toBe(
      false,
    );
    const receipts = (await readdir(h.root)).filter((name) => name.startsWith("off."));
    expect(receipts.length).toBe(2);
    expect(await Bun.file(join(h.root, receipts[0]!, "off-verified.json")).exists()).toBe(true);
  } finally {
    await h.close();
  }
});

for (const failure of ["before", "after", "422"] as const)
  test(`OFF reverse failure ${failure} retains evidence and resumes safely`, async () => {
    const h = await harness();
    try {
      const original = JSON.parse(await readFile(h.state, "utf8"));
      for (const action of ["create-guard", "create-namespace", "admit"])
        expect((await h.run(action, "--apply-after-go")).code).toBe(0);
      const operator = await offHarness(h);
      expect((await operator.run({ FAIL_WRITE: failure })).code).not.toBe(0);
      expect(
        await Bun.file(join(h.root, "plan", "restore-admission-attempt", "response.json")).exists(),
      ).toBe(true);
      // Provider problem is resolved, with no payload change. Reverse-only retry.
      expect((await operator.run()).code).toBe(0);
      expect(JSON.parse(await readFile(h.state, "utf8"))).toEqual(original);
      const archives = (await readdir(join(h.root, "plan"))).filter((name) =>
        name.startsWith("restore-admission-archive."),
      );
      expect(archives.length).toBe(failure === "after" ? 0 : 1);
    } finally {
      await h.close();
    }
  });

test("OFF refuses forced/unknown STOP, drift, unresolved forward intent and unapproved invocation", async () => {
  const h = await harness();
  try {
    for (const action of ["create-guard", "create-namespace"])
      expect((await h.run(action, "--apply-after-go")).code).toBe(0);
    const operator = await offHarness(h);
    await writeFile(h.fixtureEnv.FIXTURE_LOG, "");
    expect((await operator.run({}, "not-authorized")).code).not.toBe(0);
    expect(await h.events()).toEqual([]);
    for (const override of [
      { forced: true },
      { outcome: "unknown" },
      { stopPersisted: false },
      { stateAfter: "c".repeat(40) },
    ]) {
      expect((await operator.run({ STOP_OVERRIDE: JSON.stringify(override) })).code).not.toBe(0);
    }
    expect((await h.events()).every((e) => e.method === "STOP")).toBe(true);
    expect((await h.run("admit", "--apply-after-go", { FAIL_WRITE: "before" })).code).not.toBe(0);
    expect((await operator.run()).code).not.toBe(0);
    expect((await h.events()).some((e) => e.method === "DELETE")).toBe(false);
    const snapshot = JSON.parse(await readFile(h.state, "utf8"));
    snapshot.repository.allow_squash_merge = false;
    await writeFile(h.state, JSON.stringify(snapshot));
    await writeFile(h.fixtureEnv.FIXTURE_LOG, "");
    expect((await operator.run()).code).not.toBe(0);
    expect(
      (await h.events()).filter((e) => e.method !== "STOP").every((e) => e.method === "GET"),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test("OFF binds exact STOP dependency bytes and runtime UID; old plans require fresh review", async () => {
  const h = await harness();
  try {
    const operator = await offHarness(h);
    await writeFile(join(operator.runtime, "service-config.ts"), "export const changed = true;\n");
    expect((await operator.run()).code).not.toBe(0);
    expect(await h.events()).toEqual([]);
    await writeFile(join(operator.runtime, "service-config.ts"), "export {};\n");
    await writeFile(
      join(operator.runtime, "deployment-receipt.json"),
      JSON.stringify({ ...deployment, uid: "other" }),
    );
    expect((await operator.run()).code).not.toBe(0);
    expect(await h.events()).toEqual([]);
  } finally {
    await h.close();
  }
});

test("STOP proof verifier rejects partial/stale evidence and accepts reviewed already-disabled proof", () => {
  expect(() => verifyStop(stopped, deployment, deployment)).not.toThrow();
  expect(() =>
    verifyStop(
      {
        ...stopped,
        outcome: "verified-disabled",
        drainProven: false,
        priorDrainProof: true,
        writer: null,
      },
      deployment,
      deployment,
    ),
  ).not.toThrow();
  for (const patch of [
    { command: "start" },
    { disabled: false },
    { manualZero: false },
    { taggedRevisionsMayRemain: true },
    { stopPersisted: false },
    { drainProven: false },
    { forced: true },
    { stateBefore: null },
    { stateAfter: "c".repeat(40) },
    { outcome: "unknown" },
  ]) {
    expect(() => verifyStop({ ...stopped, ...patch }, deployment, deployment)).toThrow();
  }
  for (const patch of [
    { writerActive: true },
    { writerPid: 12 },
    { unprovenWriterPid: 12 },
    { uncertainOutcome: true },
    { reconciliationRequired: true },
    { state: "running" },
  ]) {
    expect(() =>
      verifyStop({ ...stopped, writer: { ...stopped.writer, ...patch } }, deployment, deployment),
    ).toThrow();
  }
  expect(() =>
    verifyStop(
      stopped,
      { ...deployment, stopProof: { ...deployment.stopProof, stateSha: "d".repeat(40) } },
      deployment,
    ),
  ).toThrow();
  expect(() => verifyStop(stopped, { ...deployment, uid: "wrong" }, deployment)).toThrow();
});
