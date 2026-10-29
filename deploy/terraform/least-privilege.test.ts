import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const roots = import.meta.dir;

/** Every top-level .tf file of a root, so a resource moved to another file is still checked. */
async function rootSource(root: string): Promise<string> {
  const dir = resolve(roots, root);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".tf")).sort();
  expect(files).toContain("main.tf");
  const sources = await Promise.all(files.map((name) => readFile(resolve(dir, name), "utf8")));
  return sources.join("\n");
}

function resourceBlocks(source: string, type: string): { name: string; body: string }[] {
  const blocks: { name: string; body: string }[] = [];
  const header = new RegExp(`^resource "${type}" "([^"]+)" \\{$`, "gmu");
  for (const match of source.matchAll(header)) {
    const start = match.index ?? 0;
    const end = source.indexOf("\n}\n", start);
    blocks.push({ name: match[1] ?? "", body: source.slice(start, end === -1 ? undefined : end) });
  }
  return blocks;
}

// terraform test can assert what a plan contains but not that a resource is
// absent from the configuration, so these guards read the roots directly.
test("the GCP runtime never gets Secret Manager access project-wide", async () => {
  const source = await rootSource("gcp");
  expect(resourceBlocks(source, "google_secret_manager_secret_iam_member").length).toBeGreaterThan(
    0,
  );
  for (const type of [
    "google_project_iam_member",
    "google_project_iam_binding",
    "google_project_iam_policy",
  ]) {
    for (const block of resourceBlocks(source, type)) {
      expect({
        resource: `${type}.${block.name}`,
        grantsSecrets: /secretmanager/u.test(block.body),
      }).toEqual({ resource: `${type}.${block.name}`, grantsSecrets: false });
    }
  }
});

test("AWS managed PostgreSQL ingress never falls back to a broad address range", async () => {
  const source = await rootSource("aws");
  const rules = resourceBlocks(source, "aws_vpc_security_group_ingress_rule").filter((block) =>
    block.name.startsWith("postgres"),
  );
  expect(rules.map((rule) => rule.name).sort()).toEqual([
    "postgres_from_client_cidrs",
    "postgres_from_eks_cluster",
    "postgres_from_security_groups",
    "postgres_from_vpc",
  ]);
  for (const rule of rules) {
    expect({
      rule: rule.name,
      literalCidr: rule.body.match(/"\d+\.\d+\.\d+\.\d+\/\d+"/u)?.[0],
    }).toEqual({ rule: rule.name, literalCidr: undefined });
  }
});
