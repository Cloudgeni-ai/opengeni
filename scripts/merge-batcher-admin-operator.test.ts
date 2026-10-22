import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { cli, type Snapshot } from "../docs/merge-batcher-admin/bundle";
import manifest from "../docs/merge-batcher-admin/app-manifest.json";

const directory = resolve(import.meta.dir, "../docs/merge-batcher-admin");
// Fake provider only: requests are logged without credentials, all remote state
// is a test-owned JSON file. No invocation can reach the real gh executable.
const fakeProvider = `#!/usr/bin/env bun
const state = JSON.parse(await Bun.file(process.env.FIXTURE_STATE).text());
const args = process.argv.slice(2);
const endpoint = args.find(a => a.startsWith("/")) ?? (args.includes("graphql") ? "graphql" : "");
const method = args.includes("--method") ? args[args.indexOf("--method")+1] : "GET";
const header = args.includes("-H") ? args[args.indexOf("-H")+1] : "";
const event = { endpoint, method, bearer: header === "Authorization: Bearer fixture.jwt.value" };
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
  await Bun.write(process.env.FIXTURE_STATE, JSON.stringify(state));
  if(process.env.FAIL_WRITE === "after") process.exit(1);
  output(result); process.exit(0);
}
if(endpoint === "/app") output({id:501,owner:{login:"Cloudgeni-ai"}});
else if(endpoint === "/app/installations/999") output({id:999,app_id:501,account:{login:"Cloudgeni-ai"},repository_selection:"selected",suspended_at:null,permissions:{...JSON.parse(process.env.FIXTURE_PERMISSIONS),metadata:"read"}});
else if(endpoint === "/installation/repositories") output({repositories:[{full_name:"Cloudgeni-ai/opengeni"}]});
else if(endpoint === "graphql") output(process.env.FAIL_CLASSIC ? {errors:[{message:"inaccessible"}]} : {data:{repository:{branchProtectionRules:state.classic}}});
else if(endpoint.includes("rulesets?")) output(state.rulesets);
else if(endpoint.includes("/rulesets/")) output(state.rulesets.find(r => r.id === Number(endpoint.split("/").at(-1))));
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
    ["sleep", fakeSleep],
  ]) {
    await writeFile(join(root, "bin", name!), body!);
    await chmod(join(root, "bin", name!), 0o700);
  }
  await cli(["prepare", state, "501", "999", join(root, "plan")]);
  async function run(action: string, arg = "", extra: Record<string, string> = {}) {
    const processHandle = Bun.spawn(
      ["bash", join(directory, "stage.sh"), root, action, ...(arg ? [arg] : [])],
      {
        env: {
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
          ...extra,
        },
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
  async function events(): Promise<{ endpoint: string; method: string; bearer: boolean }[]> {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return { root, state, run, events, close: () => rm(root, { recursive: true, force: true }) };
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
    const result = await h.run("identity");
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("fixture.jwt.value");
    expect((await h.events()).filter((e) => e.endpoint.startsWith("/app"))).toEqual([
      { endpoint: "/app", method: "GET", bearer: true },
      { endpoint: "/app/installations/999", method: "GET", bearer: true },
    ]);
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
