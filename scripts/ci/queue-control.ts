#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
type Api = (path: string, method?: string, body?: unknown) => any;

export function disableQueue(api: Api, repository = "Cloudgeni-ai/opengeni", dryRun = false) {
  const matches = api(`repos/${repository}/rulesets?includes_parents=false`).filter(
    (rule: any) => rule.name === "Main merge queue",
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected one Main merge queue ruleset, found ${matches.length}; inspect IDs before mutation`,
    );
  const current = api(`repos/${repository}/rulesets/${matches[0].id}`);
  const refs = current.conditions?.ref_name;
  if (
    current.target !== "branch" ||
    refs?.include?.length !== 1 ||
    refs.include[0] !== "refs/heads/main" ||
    refs?.exclude?.length !== 0
  )
    throw new Error("Queue ruleset is not main-only; inspect before mutation");
  const { name, target, conditions, bypass_actors, rules } = current;
  const payload = { name, target, conditions, bypass_actors, rules, enforcement: "disabled" };
  if (dryRun) return { id: current.id, dryRun: true, payload };
  if (current.enforcement !== "disabled")
    api(`repos/${repository}/rulesets/${current.id}`, "PUT", payload);
  const result = api(`repos/${repository}/rulesets/${current.id}`);
  if (result.enforcement !== "disabled")
    throw new Error("Queue disablement was not confirmed; inspect actual GitHub state");
  return { id: current.id, enforcement: result.enforcement, url: result._links?.html?.href };
}

if (import.meta.main) {
  if (process.argv[2] !== "disable")
    throw new Error(
      "usage: queue-control.ts disable [--dry-run] (incident/rollout-owner authorization required)",
    );
  const api: Api = (path, method, body) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["api", path, ...(method ? ["--method", method] : []), ...(body ? ["--input", "-"] : [])],
        { encoding: "utf8", ...(body ? { input: JSON.stringify(body) } : {}) },
      ),
    );
  console.log(
    JSON.stringify(
      disableQueue(api, process.env.GITHUB_REPOSITORY, process.argv.includes("--dry-run")),
      null,
      2,
    ),
  );
}
