import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { verifyImageInputs } from "../docs/merge-batcher-admin/minimal-watchdog-image";
import { off } from "../docs/merge-batcher-admin/off";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
for (const directoryValue of ["/opt/batcher-operator", "/unreviewed"]) {
  test(`OFF refuses unbound separate receipts for ${directoryValue}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "off-receipts-"));
    try {
      const bytes = JSON.stringify({
        schemaVersion: 1,
        directory: directoryValue,
        receiptDirectory: "/work/operator",
      });
      await writeFile(join(directory, "stop-contract.json"), bytes);
      await expect(
        off(
          directory,
          "--apply-after-go",
          directoryValue === "/unreviewed" ? sha(bytes) : undefined,
        ),
      ).rejects.toThrow("Separate receipt directory");
      expect(await readdir(directory)).toEqual(["stop-contract.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
function fixture() {
  const files = new Map<string, string>();
  const sources: Record<string, string> = {};
  for (const name of [
    "control.ts",
    "cloud-auth.ts",
    "service-config.ts",
    "service-limits.ts",
    "stopped-reconciliation.ts",
    "stopped-lineage.ts",
  ]) {
    const bytes = `image-only ${name}`;
    files.set(`/opt/batcher-operator/${name}`, bytes);
    sources[name] = sha(bytes);
  }
  files.set("/opt/batcher-operator/source-manifest.json", JSON.stringify({ sources }));
  const contract = JSON.stringify({
    directory: "/opt/batcher-operator",
    receiptDirectory: "/work/operator",
    sources,
  });
  files.set("/work/admin/stop-contract.json", contract);
  const config = JSON.stringify({
    operatorDirectory: "/opt/batcher-operator",
    adminDirectory: "/work/admin",
    contractSha256: sha(contract),
  });
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    const value = files.get(path);
    if (value === undefined) throw Error("missing");
    return value;
  };
  return { files, config, read, reads };
}
test("immutable config and image hashes anchor code; writable code is never read", async () => {
  const f = fixture();
  f.files.set("/work/operator/cloud-auth.ts", "unreviewed");
  expect((await verifyImageInputs(f.config, sha(f.config), f.read)).operatorDirectory).toBe(
    "/opt/batcher-operator",
  );
  expect(f.reads.some((path) => path.startsWith("/work/operator"))).toBe(false);
});
test("altered config refuses before any mounted read", async () => {
  const f = fixture();
  await expect(verifyImageInputs(f.config + " ", sha(f.config), f.read)).rejects.toThrow("digest");
  expect(f.reads).toHaveLength(0);
});
test("consistent mounted code and contract replacement cannot bypass immutable pins", async () => {
  const f = fixture();
  const contract = JSON.parse(f.files.get("/work/admin/stop-contract.json")!);
  contract.sources["cloud-auth.ts"] = sha("attacker");
  f.files.set("/work/admin/stop-contract.json", JSON.stringify(contract));
  f.files.set("/work/operator/cloud-auth.ts", "attacker");
  await expect(verifyImageInputs(f.config, sha(f.config), f.read)).rejects.toThrow(
    "contract digest",
  );
});
test("image manifest/source mismatch or missing file refuses", async () => {
  for (const mode of ["bytes", "missing", "manifest"]) {
    const f = fixture();
    if (mode === "bytes") f.files.set("/opt/batcher-operator/control.ts", "changed");
    else if (mode === "missing") f.files.delete("/opt/batcher-operator/control.ts");
    else f.files.set("/opt/batcher-operator/source-manifest.json", JSON.stringify({ sources: {} }));
    await expect(verifyImageInputs(f.config, sha(f.config), f.read)).rejects.toThrow();
  }
});
test("OFF rechecks immutable contract digest before source loading, locks or effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "off-contract-pin-"));
  try {
    await writeFile(
      join(directory, "stop-contract.json"),
      JSON.stringify({ directory: "/unreviewed" }),
    );
    await expect(off(directory, "--apply-after-go", "a".repeat(64))).rejects.toThrow(
      "contract changed",
    );
    expect(await readdir(directory)).toEqual(["stop-contract.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
