import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  cli,
  prepare,
  prepareAppOnly,
  appOnlyCheckName,
  appOnlyNamespaceName,
  verify,
  writable,
  validatePlan,
  mergeMode,
  type Plan,
  type RuleSet,
  type Snapshot,
} from "../docs/merge-batcher-admin/bundle.ts";
import manifest from "../docs/merge-batcher-admin/app-manifest.json";

function fixture(): Snapshot {
  return {
    repository: {
      full_name: "Cloudgeni-ai/opengeni",
      default_branch: "main",
      allow_squash_merge: true,
    },
    classic: { nodes: [], pageInfo: { hasNextPage: false } },
    rulesets: [
      {
        id: 101,
        name: "Protection",
        source_type: "Repository",
        source: "Cloudgeni-ai/opengeni",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        rules: [
          { type: "non_fast_forward" },
          { type: "deletion" },
          {
            type: "pull_request",
            parameters: {
              allowed_merge_methods: ["squash"],
              required_approving_review_count: 0,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              require_extra_approval_for_unattributed_changes: true,
            },
          },
        ],
        created_at: "2026-01-01T00:00:00Z",
        _links: { self: { href: "https://api.github.com/example" } },
      },
      {
        id: 102,
        name: "Production",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/heads/production"], exclude: [] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      },
      {
        id: 103,
        name: "Release tags",
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
        rules: [{ type: "deletion" }],
      },
    ],
  };
}
function staged(plan: Plan, phase: "guard" | "namespace" | "applied") {
  const current = structuredClone(plan.before);
  const guard = { ...plan.guard, id: 201 } as RuleSet;
  const namespace = { ...plan.namespace, id: 202 } as RuleSet;
  current.rulesets.push(guard);
  if (phase !== "guard") current.rulesets.push(namespace);
  if (phase === "applied") current.rulesets[0] = { ...plan.admission, id: plan.admissionId };
  return { current, receipts: { guard, namespace } };
}

describe("offline batcher administration contract", () => {
  test("v4 recovery identifies only the exact legacy and ordered partial upgrade inventories", () => {
    const legacy = prepare(fixture(), 5425399, 174101112);
    const next = prepareAppOnly(fixture(), 5425399, 174101112);
    const { current, receipts } = staged(legacy, "applied");
    const retained = JSON.stringify(receipts);
    expect(() => verify(next, current, "legacy-applied", receipts)).not.toThrow();
    expect(() => verify(legacy, current, "legacy-applied", receipts)).toThrow(
      "explicit version 4 plan",
    );
    expect(() => verify(next, current, "applied", receipts)).toThrow();
    current.rulesets[0] = { ...next.admission, id: next.admissionId };
    expect(() => verify(next, current, "upgrade-admission", receipts)).not.toThrow();
    expect(() => verify(next, current, "legacy-applied", receipts)).toThrow();
    expect(() => verify(next, current, "applied", receipts)).toThrow();
    current.rulesets[0] = { ...next.restore, id: next.admissionId };
    expect(() => verify(next, current, "legacy-namespace", receipts)).not.toThrow();
    expect(() => verify(next, current, "namespace", receipts)).toThrow();
    current.rulesets[0] = { ...next.admission, id: next.admissionId };
    current.rulesets[current.rulesets.length - 1] = {
      ...next.namespace,
      id: receipts.namespace.id,
    };
    expect(() => verify(next, current, "applied", receipts)).not.toThrow();
    expect(JSON.stringify(receipts)).toBe(retained);
    current.rulesets[0] = { ...legacy.admission, id: legacy.admissionId };
    for (const phase of [
      "legacy-applied",
      "upgrade-admission",
      "legacy-namespace",
      "applied",
    ] as const)
      expect(() => verify(next, current, phase, receipts)).toThrow();
    expect(mergeMode("legacy-applied")).toBe("hold");
    expect(mergeMode("upgrade-admission")).toBe("hold");
  });

  test("App-only v4 binds the guiding check and both bypass lists to the App", () => {
    const before = fixture();
    const plan = prepareAppOnly(before, 5425399, 174101112);
    const onlyApp = [{ actor_id: 5425399, actor_type: "Integration", bypass_mode: "always" }];
    expect(plan.schemaVersion).toBe(4);
    expect(plan.namespace.name).toBe(appOnlyNamespaceName);
    expect(plan.admission.bypass_actors).toEqual(onlyApp);
    expect(plan.namespace.bypass_actors).toEqual(onlyApp);
    expect(plan.admission.rules).toContainEqual({
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: appOnlyCheckName, integration_id: 5425399 }],
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
      },
    });
    expect(plan.restore).toEqual(writable(before.rulesets[0]!));
    expect(plan.restore.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
    expect(
      (plan.restore.rules as { type: string }[]).some((r) => r.type === "required_status_checks"),
    ).toBe(false);
    for (const phase of ["guard", "namespace", "applied"] as const) {
      const { current, receipts } = staged(plan, phase);
      expect(() => verify(plan, current, phase, receipts)).not.toThrow();
    }
    expect(() => verify(plan, before, "restored", {})).not.toThrow();
  });

  test("v4 guidance preserves exact legacy plans and both reverse paths", () => {
    const before = fixture();
    const oldName = "Merges go through the batcher: add the queue-ready label";
    const legacy = prepare(before, 5425399, 174101112);
    const old = prepareAppOnly(before, 5425399, 174101112, "legacy");
    const next = prepareAppOnly(before, 5425399, 174101112);
    expect(legacy.namespace.name).toBe(oldName);
    expect(old.namespace.name).toBe(oldName);
    expect(next.namespace.name).toBe(
      "Merges go through the batcher: use gh pr merge --auto or add the queue-ready label",
    );
    expect({ ...next, namespace: { ...next.namespace, name: oldName } }).toEqual(old);
    for (const plan of [old, next]) {
      const retained = JSON.stringify(plan);
      expect(() => validatePlan(plan)).not.toThrow();
      expect(plan.restore).toEqual(legacy.restore);
      const { current, receipts } = staged(plan, "applied");
      expect(() => verify(plan, current, "applied", receipts)).not.toThrow();
      current.rulesets[0] = { ...plan.restore, id: plan.admissionId };
      expect(() => verify(plan, current, "namespace", receipts)).not.toThrow();
      current.rulesets = current.rulesets.filter((r) => r.id !== receipts.namespace!.id);
      expect(() => verify(plan, current, "guard", receipts)).not.toThrow();
      current.rulesets = current.rulesets.filter((r) => r.id !== receipts.guard!.id);
      expect(() => verify(plan, current, "restored", receipts)).not.toThrow();
      expect(JSON.stringify(plan)).toBe(retained);
    }
    for (const plan of [old, next]) {
      const { current, receipts } = staged(plan, "applied");
      const namespace = current.rulesets.find((r) => r.id === receipts.namespace!.id)!;
      namespace.name = plan === old ? appOnlyNamespaceName : oldName;
      expect(() => verify(plan, current, "applied", receipts)).toThrow("readback drift");
      const wrongReceipt = structuredClone(receipts);
      wrongReceipt.namespace!.name = namespace.name;
      expect(() => verify(plan, current, "applied", wrongReceipt)).toThrow();
    }
  });

  test("v4 labels reject arbitrary names, collisions and unrelated policy changes", () => {
    const plan = prepareAppOnly(fixture(), 5425399, 174101112);
    for (const name of [
      appOnlyNamespaceName + " ",
      "arbitrary",
      "",
      "Opengeni batcher dedicated writer",
    ]) {
      const changed = structuredClone(plan);
      changed.namespace.name = name;
      expect(() => validatePlan(changed)).toThrow();
    }
    for (const name of [
      plan.namespace.name,
      prepare(fixture(), 5425399, 174101112).namespace.name,
    ]) {
      const before = fixture();
      before.rulesets.push({ ...plan.namespace, id: 999, name });
      expect(() => prepareAppOnly(before, 5425399, 174101112)).toThrow("reconcile prior execution");
    }
    const renamed = structuredClone(plan);
    renamed.namespace.bypass_actors = [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ];
    expect(() => validatePlan(renamed)).toThrow();
    const scoped = structuredClone(plan);
    scoped.namespace.conditions = { ref_name: { include: ["~ALL"], exclude: [] } };
    expect(() => validatePlan(scoped)).toThrow();
  });

  test("fresh native-auto Manual snapshots retain true without relaxing repository equality", () => {
    const before = fixture();
    Object.assign(before.repository, { allow_auto_merge: true });
    const plan = prepareAppOnly(before, 5425399, 174101112);
    expect(plan.before.repository).toMatchObject({ allow_auto_merge: true });
    expect(() => verify(plan, before, "restored")).not.toThrow();
    const changed = structuredClone(before);
    Object.assign(changed.repository, { allow_auto_merge: false });
    expect(() => verify(plan, changed, "restored")).toThrow("Repository configuration");
    expect(plan.restore).toEqual(writable(before.rulesets[0]!));
  });

  test("App-only plans reject admin bypass and unbound guiding checks; legacy plans remain exact", () => {
    const legacy = prepare(fixture(), 5425399, 174101112);
    const saved = JSON.stringify(legacy);
    expect(() => validatePlan(legacy)).not.toThrow();
    const plan = prepareAppOnly(fixture(), 5425399, 174101112);
    for (const key of ["namespace", "admission"] as const) {
      const changed = structuredClone(plan);
      (changed[key].bypass_actors as unknown[]).push({
        actor_id: null,
        actor_type: "OrganizationAdmin",
        bypass_mode: "always",
      });
      expect(() => validatePlan(changed)).toThrow();
    }
    const changed = structuredClone(plan);
    const rules = changed.admission.rules as {
      type: string;
      parameters?: { required_status_checks: { integration_id?: number }[] };
    }[];
    delete rules.find((r) => r.type === "required_status_checks")!.parameters!
      .required_status_checks[0]!.integration_id;
    expect(() => validatePlan(changed)).toThrow();
    expect(JSON.stringify(legacy)).toBe(saved);
  });

  test("App-only provider readback includes the explicit create default without accepting changed semantics", () => {
    const plan = prepareAppOnly(fixture(), 5425399, 174101112);
    const { current, receipts } = staged(plan, "applied");
    const rule = (
      current.rulesets[0]!.rules as { type: string; parameters: Record<string, unknown> }[]
    ).find((r) => r.type === "required_status_checks")!;
    rule.parameters.do_not_enforce_on_create = false;
    expect(() => verify(plan, current, "applied", receipts)).not.toThrow();
    for (const value of [true, null, "false", 0]) {
      rule.parameters.do_not_enforce_on_create = value;
      expect(() => verify(plan, current, "applied", receipts)).toThrow();
    }
  });

  test("OrganizationAdmin null readback matches sentinel 1 without rewriting saved policy", () => {
    const plan = prepare(fixture(), 5425399, 174101112);
    const saved = JSON.stringify(plan);
    for (const phase of ["namespace", "applied"] as const) {
      const { current, receipts } = structuredClone(staged(plan, phase));
      for (const rule of [...current.rulesets, receipts.namespace]) {
        for (const actor of rule.bypass_actors as Record<string, unknown>[])
          if (actor.actor_type === "OrganizationAdmin") actor.actor_id = null;
      }
      expect(() => verify(plan, current, phase, receipts)).not.toThrow();
    }
    expect(JSON.stringify(plan)).toBe(saved);
  });
  test("OrganizationAdmin normalization rejects other actor, ID, mode and shape drift", () => {
    const plan = prepare(fixture(), 5425399, 174101112);
    for (const change of [
      { actor_id: 2 },
      { actor_id: "1" },
      { actor_id: null, actor_type: "RepositoryRole" },
      { actor_id: null, actor_type: "Integration" },
      { actor_id: null, bypass_mode: "pull_request" },
      { actor_id: null, bypass_mode: "exempt" },
      { actor_id: null, extra: true },
    ]) {
      const { current, receipts } = structuredClone(staged(plan, "namespace"));
      const actors = receipts.namespace.bypass_actors as Record<string, unknown>[];
      Object.assign(actors.find((a) => a.actor_type === "OrganizationAdmin")!, change);
      expect(() => verify(plan, current, "namespace", receipts)).toThrow();
    }
    for (const mutation of ["missing", "duplicate", "integration-id"] as const) {
      const { current, receipts } = structuredClone(staged(plan, "namespace"));
      const actors = receipts.namespace.bypass_actors as Record<string, unknown>[];
      const actor = actors.find((a) => a.actor_type === "OrganizationAdmin")!;
      if (mutation === "missing") delete actor.actor_id;
      if (mutation === "duplicate") actors.push({ ...actor, actor_id: null });
      if (mutation === "integration-id")
        actors.find((a) => a.actor_type === "Integration")!.actor_id = null;
      expect(() => verify(plan, current, "namespace", receipts)).toThrow();
    }
  });
  test("observed GitHub omitted update default verifies plan, apply and exact reverse phases", () => {
    for (const omittedPlan of [false, true]) {
      const plan = prepare(fixture(), 5425399, 174101112);
      if (omittedPlan) plan.namespace.rules = [{ type: "creation" }, { type: "update" }];
      expect(() => validatePlan(plan)).not.toThrow();
      const { current, receipts } = structuredClone(staged(plan, "applied"));
      // Exact policy fields from the live POST/GET writer response; the provider
      // omitted parameters although the submitted payload explicitly said false.
      receipts.namespace.rules = omittedPlan
        ? [
            { type: "creation" },
            { type: "update", parameters: { update_allows_fetch_and_merge: false } },
          ]
        : [{ type: "creation" }, { type: "update" }];
      expect(() => verify(plan, current, "applied", receipts)).not.toThrow();
      current.rulesets[0] = { ...plan.restore, id: plan.admissionId };
      expect(() => verify(plan, current, "namespace", receipts)).not.toThrow();
      current.rulesets = current.rulesets.filter((r) => r.id !== receipts.namespace.id);
      expect(() => verify(plan, current, "guard", receipts)).not.toThrow();
      current.rulesets = current.rulesets.filter((r) => r.id !== receipts.guard.id);
      expect(() => verify(plan, current, "restored")).not.toThrow();
    }
  });
  test("unchanged original update rules compare symmetrically without rewriting saved originals", () => {
    for (const omitted of [false, true]) {
      const before = fixture();
      before.rulesets[2]!.rules = omitted
        ? [{ type: "update" }]
        : [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }];
      const saved = JSON.stringify(before);
      const plan = prepare(before, 501, 999);
      const current = structuredClone(before);
      current.rulesets[2]!.rules = omitted
        ? [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }]
        : [{ type: "update" }];
      expect(() => verify(plan, current, "original")).not.toThrow();
      expect(() => verify(plan, current, "restored")).not.toThrow();
      expect(JSON.stringify(before)).toBe(saved);
      expect(JSON.stringify(plan.before)).toBe(saved);
    }
  });
  for (const update of [
    { type: "update", parameters: { update_allows_fetch_and_merge: true } },
    { type: "update", parameters: {} },
    { type: "update", parameters: null },
    { type: "update", parameters: { update_allows_fetch_and_merge: "false" } },
    { type: "update", parameters: { update_allows_fetch_and_merge: 0 } },
    { type: "update", parameters: { update_allows_fetch_and_merge: false, extra: false } },
    { type: "update", extra: false },
    { type: "update", parameters: { update_allows_fetch_and_merge: false }, extra: false },
  ])
    test(`update default comparison refuses ${JSON.stringify(update)}`, () => {
      const plan = prepare(fixture(), 501, 999);
      const badPlan = structuredClone(plan);
      badPlan.namespace.rules = [{ type: "creation" }, update];
      expect(() => validatePlan(badPlan)).toThrow();
      const { current, receipts } = structuredClone(staged(plan, "applied"));
      receipts.namespace.rules = [{ type: "creation" }, update];
      expect(() => verify(plan, current, "applied", receipts)).toThrow();
      const original = structuredClone(plan.before);
      original.rulesets[2]!.rules = [{ type: "update" }];
      const originalPlan = prepare(original, 501, 999);
      const drifted = structuredClone(original);
      drifted.rulesets[2]!.rules = [update];
      expect(() => verify(originalPlan, drifted, "original")).toThrow();
      expect(() => verify(originalPlan, drifted, "restored")).toThrow();
    });
  test("default equivalence preserves rule multiplicity, extra rules and non-rule objects", () => {
    const plan = prepare(fixture(), 501, 999);
    for (const extra of [{ type: "update" }, { type: "deletion" }]) {
      const badPlan = structuredClone(plan);
      (badPlan.namespace.rules as unknown[]).push(extra);
      expect(() => validatePlan(badPlan)).toThrow();
      const { current, receipts } = structuredClone(staged(plan, "applied"));
      (receipts.namespace.rules as unknown[]).push(extra);
      expect(() => verify(plan, current, "applied", receipts)).toThrow();
    }
    const before = fixture();
    // A similarly named nested value outside a ruleset is not a rule.
    before.rulesets[2]!.conditions = { rules: [{ type: "update" }] };
    const otherPlan = prepare(before, 501, 999);
    const current = structuredClone(before);
    current.rulesets[2]!.conditions = {
      rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }],
    };
    expect(() => verify(otherPlan, current, "original")).toThrow();
  });
  test("all prepared shell blocks are syntactically valid without execution", async () => {
    const guide = await readFile(
      new URL("../docs/merge-batcher-admin/README.md", import.meta.url),
      "utf8",
    );
    const blocks = [...guide.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const block of blocks) {
      expect(() =>
        execFileSync("bash", ["-n"], { input: block[1]!, stdio: ["pipe", "pipe", "pipe"] }),
      ).not.toThrow();
    }
  });
  test("App has exact runtime permissions with read-only administration and no events", () => {
    expect(manifest.name).toBe("Opengeni merge batcher");
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual([]);
    expect(manifest.default_permissions).toEqual({
      administration: "read",
      contents: "write",
      workflows: "write",
      actions: "write",
      pull_requests: "write",
      issues: "write",
    });
    expect(manifest.url).toBe("https://github.com/Cloudgeni-ai/opengeni");
  });
  test("assigned App ID and organization administrators bypass admission; original approvals unchanged", () => {
    const before = fixture();
    const original = structuredClone(before);
    const plan = prepare(before, 501, 999);
    expect(plan.admission.bypass_actors).toEqual([
      { actor_id: 501, actor_type: "Integration", bypass_mode: "always" },
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
    ]);
    const rules = before.rulesets[0]!.rules;
    expect(plan.admission.rules).toEqual(Array.isArray(rules) ? rules.slice(2) : []);
    expect(before).toEqual(original);
    expect(plan.installationId).toBe(999);
  });
  test("non-FF/deletion guard has no bypass even for the App/admin", () => {
    const plan = prepare(fixture(), 501, 999);
    expect(plan.guard.bypass_actors).toEqual([]);
    expect(plan.guard.rules).toEqual([{ type: "non_fast_forward" }, { type: "deletion" }]);
    expect(plan.guard.conditions).toEqual({
      ref_name: {
        include: ["refs/heads/main", "refs/heads/queue/live/**", "refs/heads/batcher-state"],
        exclude: [],
      },
    });
  });
  test("main and live namespace allow App and emergency organization admin; no production/tag/shadow overlap", () => {
    const plan = prepare(fixture(), 501, 999);
    expect(plan.namespace.conditions).toEqual({
      ref_name: {
        include: ["refs/heads/main", "refs/heads/queue/live/**", "refs/heads/batcher-state"],
        exclude: [],
      },
    });
    expect(plan.namespace.rules).toEqual([
      { type: "creation" },
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    ]);
    expect(plan.namespace.bypass_actors).toEqual(plan.admission.bypass_actors);
  });

  test("emergency bypass cannot leak into immutable guard or broaden to repository admins", () => {
    const plan = prepare(fixture(), 501, 999);
    for (const target of ["guard", "admission", "namespace"] as const) {
      const changed = structuredClone(plan);
      (changed[target].bypass_actors as unknown[]).push({
        actor_type: "RepositoryRole",
        actor_id: 5,
        bypass_mode: "always",
      });
      expect(() => validatePlan(changed)).toThrow("drift");
    }
    for (const target of ["admission", "namespace"] as const) {
      const missing = structuredClone(plan);
      (missing[target].bypass_actors as unknown[]).pop();
      expect(() => validatePlan(missing)).toThrow("drift");
      const exempt = structuredClone(plan);
      (exempt[target].bypass_actors as { bypass_mode: string }[])[1]!.bypass_mode = "exempt";
      expect(() => validatePlan(exempt)).toThrow("drift");
    }
    const legacy = fixture();
    legacy.rulesets[1]!.name = "Opengeni batcher dedicated writer";
    expect(() => prepare(legacy, 501, 999)).toThrow("reconcile prior execution");
  });

  test("GitHub-only instructions require checks and readiness, not attestations", async () => {
    const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
    const guide = await readFile(new URL("../docs/merge-batcher.md", import.meta.url), "utf8");
    expect(agents).toContain(
      "VM attestations and reviewer session UUIDs are not admission requirements",
    );
    expect(guide).toContain("required GitHub-hosted checks on its exact current head");
    expect(guide).toContain("open the failed GitHub check and its logs");
    expect(guide).not.toContain("generic review alone does not admit");
    expect(agents).not.toContain("there is no standing admin writer bypass");
  });

  test("old/manual-path or tampered plans are never silently activated", () => {
    const plan = prepare(fixture(), 501, 999);
    expect(plan.schemaVersion).toBe(3);
    expect(() => validatePlan({ ...plan, schemaVersion: 1 } as unknown as Plan)).toThrow(
      "version 3",
    );
    expect(() => validatePlan({ ...plan, schemaVersion: 2 } as unknown as Plan)).toThrow(
      "version 3",
    );
    expect(plan.namespace.name).toBe("Merges go through the batcher: add the queue-ready label");
    const weakened = structuredClone(plan);
    weakened.namespace.conditions = {
      ref_name: { include: ["refs/heads/queue/live/**", "refs/heads/batcher-state"], exclude: [] },
    };
    expect(() => validatePlan(weakened)).toThrow("drift");
    const adminBypass = structuredClone(plan);
    (adminBypass.namespace.bypass_actors as unknown[]).push({
      actor_type: "RepositoryRole",
      actor_id: 5,
      bypass_mode: "always",
    });
    expect(() => validatePlan(adminBypass)).toThrow("drift");
  });

  test("agent merge mode follows whole verified policy, not merely controller STOP", () => {
    expect(mergeMode("original")).toBe("manual");
    expect(mergeMode("guard")).toBe("hold");
    expect(mergeMode("namespace")).toBe("hold");
    expect(mergeMode("applied")).toBe("queue-only");
    expect(mergeMode("restored")).toBe("manual");
  });

  test("agent instructions pair queue-only activation with verified OFF manual restoration", async () => {
    const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
    expect(agents).toContain("only normal path to main");
    expect(agents).toContain("manually rerun/cancel Batch CI");
    expect(agents).toContain("create/update/delete queue or batcher-state refs");
    expect(agents).toContain("Stopping the controller alone does **not** restore");
    expect(agents).toContain("complete verified OFF restoration");
    expect(agents).toContain("gh api repos/Cloudgeni-ai/opengeni/rules/branches/main");
    expect(agents).toContain("A private receipt is not a");
    expect(agents).toContain("A ruleset name alone is never");
    expect(agents).not.toContain("current verified ruleset receipt");
    const readback = await readFile(
      new URL("../docs/merge-batcher-admin/README.md", import.meta.url),
      "utf8",
    );
    const section = readback.split("### Agent-readable merge mode")[1]!.split("For a timeout")[0]!;
    for (const required of [
      "includes_parents=true&per_page=100",
      "orgs/ORG/rulesets/ID",
      "hasNextPage",
      "**Manual:**",
      "**Queue-only:**",
      "**Hold:**",
      "no bypass actors",
      "update_allows_fetch_and_merge=false",
      "owner-local",
      "not an atomic fence",
    ])
      expect(section).toContain(required);
    expect(section).not.toMatch(/gh api[^\n]*(?:--method|-X)\s+(?:POST|PUT|DELETE|PATCH)/);
  });
  test("ordinary-reader bypass omission preserves visible manual/queue policy decisions", async () => {
    const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
    const readback = await readFile(
      new URL("../docs/merge-batcher-admin/README.md", import.meta.url),
      "utf8",
    );
    expect(agents).toContain("that expected omission is");
    expect(agents).toContain("not malformed policy and does not by itself force hold");
    expect(agents).not.toContain("including inherited rules and bypass actors");
    const rows = readback
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| Original squash") ||
          line.startsWith("| Complete intended") ||
          line.startsWith("| Mixed or inaccessible"),
      );
    const decisions = rows.map((row) =>
      row
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
    expect(decisions).toHaveLength(5);
    expect(decisions.map((row) => [row[1], row[2]])).toEqual([
      ["omitted", "manual"],
      ["visible and expected", "manual"],
      ["omitted", "queue-only"],
      ["visible and expected", "queue-only"],
      ["omitted", "hold"],
    ]);
    expect(readback).toContain("Those exact identity/bypass checks are activation gates");
    expect(readback).toContain("not prerequisites for an ordinary agent to choose queue-only");
    expect(agents).toContain('`{type:"update"}` (parameters absent) is equivalent to exactly');
    expect(agents).toContain("unknown or mixed policy remains hold");
    expect(readback).toContain('or exactly `{type:"update"}`');
    expect(readback).toContain("saved originals and request payloads are not rewritten");
  });
  test("restore preserves exact original writable fields, not API metadata", () => {
    const before = fixture();
    const plan = prepare(before, 501, 999);
    expect(plan.restore).toEqual(writable(before.rulesets[0]!));
    expect(Object.keys(plan.restore).sort()).toEqual([
      "bypass_actors",
      "conditions",
      "enforcement",
      "name",
      "rules",
      "target",
    ]);
    expect(plan.before.rulesets[0]!.created_at).toBeDefined();
  });
  for (const phase of ["guard", "namespace", "applied"] as const) {
    test(`full ${phase} readback accepts only the exact intended stage`, () => {
      const plan = prepare(fixture(), 501, 999);
      const { current, receipts } = staged(plan, phase);
      expect(() => verify(plan, current, phase, receipts)).not.toThrow();
      expect(() => verify(plan, current, "original", receipts)).toThrow();
      current.rulesets[1]!.rules = [];
      expect(() => verify(plan, current, phase, receipts)).toThrow("readback drift");
    });
  }
  test("partial rollback and exact full rollback are verified", () => {
    const plan = prepare(fixture(), 501, 999);
    const { current, receipts } = staged(plan, "applied");
    current.rulesets[0] = { ...plan.restore, id: plan.admissionId };
    verify(plan, current, "namespace", receipts);
    current.rulesets = current.rulesets.filter((r) => r.id !== receipts.namespace.id);
    verify(plan, current, "guard", receipts);
    current.rulesets = current.rulesets.filter((r) => r.id !== receipts.guard.id);
    verify(plan, current, "restored");
  });
  test("changed inventory, missing bypass fields, duplicate/colliding IDs fail", () => {
    const plan = prepare(fixture(), 501, 999);
    const { current, receipts } = staged(plan, "applied");
    expect(() => verify(plan, current, "applied")).toThrow("Missing");
    expect(() =>
      verify(plan, current, "applied", { ...receipts, guard: { ...receipts.guard, id: 101 } }),
    ).toThrow("collides");
    current.rulesets.push({ ...current.rulesets[1]!, id: 900 });
    expect(() => verify(plan, current, "applied", receipts)).toThrow("inventory");
    current.rulesets.pop();
    current.rulesets.push(current.rulesets[0]!);
    expect(() => verify(plan, current, "applied", receipts)).toThrow("Duplicate");
    current.rulesets.pop();
    delete current.rulesets[0]!.bypass_actors;
    expect(() => verify(plan, current, "applied", receipts)).toThrow("Missing ruleset field");
  });
  test("unexpected App bypass in guard and incorrect receipts fail", () => {
    const plan = prepare(fixture(), 501, 999);
    const { current, receipts } = staged(plan, "applied");
    receipts.guard.bypass_actors = plan.admission.bypass_actors!;
    expect(() => verify(plan, current, "applied", receipts)).toThrow("creation receipt");
  });
  test("ruleset ordering and server metadata do not falsely signal drift", () => {
    const plan = prepare(fixture(), 501, 999);
    const current = structuredClone(plan.before);
    current.rulesets.reverse();
    const protection = current.rulesets.find((r) => r.id === 101)!;
    (protection.rules as unknown[]).reverse();
    protection.updated_at = "2026-10-22T00:00:00Z";
    verify(plan, current, "original");
  });
  test("canonical comparison preserves duplicate rule and actor multiplicity", () => {
    const plan = prepare(fixture(), 501, 999);
    for (const field of ["rules", "bypass_actors"]) {
      const current = structuredClone(plan.before);
      const values = current.rulesets[0]![field];
      if (!Array.isArray(values)) throw new Error("Invalid fixture");
      values.push(structuredClone(values[0]!));
      expect(() => verify(plan, current, "original")).toThrow("readback drift");
    }
  });
  test("squash-only prior admission is required, not silently widened", () => {
    const snapshot = fixture();
    snapshot.rulesets[0]!.rules = [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: { allowed_merge_methods: ["squash", "merge"] },
      },
    ];
    expect(() => prepare(snapshot, 501, 999)).toThrow("Manual merge methods");
  });
  test("offline bundle imports only filesystem/path and exposes no network executor", async () => {
    const source = await readFile(
      new URL("../docs/merge-batcher-admin/bundle.ts", import.meta.url),
      "utf8",
    );
    expect([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1])).toEqual([
      "node:fs/promises",
      "node:path",
    ]);
    expect(source).not.toMatch(/\b(?:fetch|spawn|exec|execFile)\s*\(/);
  });
  test("repository merge-setting changes and classic protection drift fail", () => {
    const plan = prepare(fixture(), 501, 999);
    const current = structuredClone(plan.before);
    current.repository.allow_squash_merge = false;
    expect(() => verify(plan, current, "original")).toThrow("Repository");
    current.repository.allow_squash_merge = true;
    current.classic.nodes.push({ id: "new", pattern: "main" });
    expect(() => verify(plan, current, "original")).toThrow("Classic");
  });
  test("prepare refuses unsupported prior policy instead of dropping it", () => {
    for (const mutate of [
      (s: Snapshot) => {
        s.repository.full_name = "another/repository";
      },
      (s: Snapshot) => {
        s.repository.default_branch = "trunk";
      },
      (s: Snapshot) => {
        s.repository.allow_squash_merge = false;
      },
      (s: Snapshot) => {
        s.classic.pageInfo.hasNextPage = true;
      },
      (s: Snapshot) => {
        s.classic.nodes.push({ id: "classic" });
      },
      (s: Snapshot) => {
        s.rulesets[0]!.source_type = "Organization";
      },
      (s: Snapshot) => {
        s.rulesets[0]!.enforcement = "disabled";
      },
      (s: Snapshot) => {
        (s.rulesets[0]!.rules as unknown[]).push({ type: "required_signatures" });
      },
      (s: Snapshot) => {
        s.rulesets[0]!.conditions = { ref_name: { include: ["~ALL"], exclude: [] } };
      },
      (s: Snapshot) => {
        s.rulesets[1]!.name = "Merges go through the batcher: add the queue-ready label";
      },
      (s: Snapshot) => {
        s.rulesets[1]!.name = "Opengeni batcher immutable refs";
      },
    ]) {
      const snapshot = fixture();
      mutate(snapshot);
      expect(() => prepare(snapshot, 501, 999)).toThrow();
    }
    for (const id of [0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => prepare(fixture(), id, 999)).toThrow("assigned");
      expect(() => prepare(fixture(), 501, id)).toThrow("assigned");
    }
  });
  test("CLI has no apply path and refuses overwriting retained plans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batcher-admin-test-"));
    try {
      const snapshot = join(dir, "before.json");
      await Bun.write(snapshot, JSON.stringify(fixture()));
      const output = join(dir, "plan");
      await cli(["prepare", snapshot, "501", "999", output]);
      expect((await readdir(output)).sort()).toEqual([
        "admission.json",
        "guard.json",
        "namespace.json",
        "plan.json",
        "restore.json",
      ]);
      const before = await readFile(join(output, "plan.json"), "utf8");
      await expect(cli(["prepare", snapshot, "501", "999", output])).rejects.toThrow();
      expect(await readFile(join(output, "plan.json"), "utf8")).toBe(before);
      await cli(["verify", output, snapshot, "original"]);
      await expect(cli(["apply", output])).rejects.toThrow("Usage");
      await expect(cli(["verify", output, snapshot, "unknown"])).rejects.toThrow("Unknown phase");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("receipt validates source, full inventory and retained bytes before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "batcher-receipt-test-"));
    try {
      const snapshotPath = join(root, "snapshot.json");
      const candidatePath = join(root, "candidate.json");
      const before = fixture();
      await Bun.write(snapshotPath, JSON.stringify(before));
      const output = join(root, "plan");
      await cli(["prepare", snapshotPath, "501", "999", output]);
      const plan = prepare(before, 501, 999);
      const { current, receipts } = staged(plan, "guard");
      const candidate = {
        ...receipts.guard,
        source_type: "Repository",
        source: "Cloudgeni-ai/opengeni",
      };
      await Bun.write(snapshotPath, JSON.stringify(current));
      const command = ["receipt", output, snapshotPath, "guard", candidatePath];
      await Bun.write(candidatePath, JSON.stringify({ ...candidate, source_type: "Organization" }));
      await expect(cli(command)).rejects.toThrow("belong");
      expect(await Bun.file(join(output, "guard-receipt.json")).exists()).toBe(false);
      await Bun.write(candidatePath, JSON.stringify(candidate));
      const drifted = structuredClone(current);
      drifted.rulesets[1]!.rules = [];
      await Bun.write(snapshotPath, JSON.stringify(drifted));
      await expect(cli(command)).rejects.toThrow("drift");
      expect(await Bun.file(join(output, "guard-receipt.json")).exists()).toBe(false);
      await Bun.write(snapshotPath, JSON.stringify(current));
      const different = JSON.stringify({ ...candidate, name: "different retained receipt" });
      await Bun.write(join(output, "guard-receipt.json"), different);
      await expect(cli(command)).rejects.toThrow("Retained receipt");
      expect(await readFile(join(output, "guard-receipt.json"), "utf8")).toBe(different);
      const retained = JSON.stringify(
        { ...candidate, retained_evidence: "original timestamp" },
        null,
        4,
      );
      await Bun.write(join(output, "guard-receipt.json"), retained);
      await cli(command);
      expect(await readFile(join(output, "guard-receipt.json"), "utf8")).toBe(retained);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
