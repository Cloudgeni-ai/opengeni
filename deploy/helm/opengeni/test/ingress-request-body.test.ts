import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Ingress = { kind: string; metadata: { name: string; annotations?: Record<string, string> } };

const BODY_SIZE = "nginx.ingress.kubernetes.io/proxy-body-size";

describe.skipIf(!Bun.which("helm"))("primary ingress request body", () => {
  test("passes on every body the API accepts by default", async () => {
    const ingress = await primary({ className: "nginx" });
    expect(ingress.metadata.annotations?.[BODY_SIZE]).toBe("32m");
    expect(nginxBytes("32m")).toBe(await apiMaxRequestBodyBytes());
  });

  test("keeps the other annotations and an explicit body size", async () => {
    const ingress = await primary({
      className: "nginx",
      annotations: { "nginx.ingress.kubernetes.io/proxy-buffering": "off", [BODY_SIZE]: "64m" },
    });
    expect(ingress.metadata.annotations).toEqual({
      "nginx.ingress.kubernetes.io/proxy-buffering": "off",
      [BODY_SIZE]: "64m",
    });
    const kept = await primary({
      className: "nginx",
      annotations: { "nginx.ingress.kubernetes.io/proxy-buffering": "off" },
    });
    expect(kept.metadata.annotations).toEqual({
      "nginx.ingress.kubernetes.io/proxy-buffering": "off",
      [BODY_SIZE]: "32m",
    });
  });

  test("leaves the controller's default when unset", async () => {
    const ingress = await primary({ className: "nginx", maxRequestBody: "" });
    expect(ingress.metadata.annotations).toBeUndefined();
  });
});

/** Bytes in an nginx size such as `32m` (nginx sizes are binary). */
function nginxBytes(size: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(size);
  if (!match) throw new Error(`not an nginx size: ${size}`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase()]!;
  return Number(match[1]) * unit;
}

/** The API's own request body ceiling, read from its source. */
async function apiMaxRequestBodyBytes(): Promise<number> {
  const source = await Bun.file(resolve(import.meta.dir, "../../../../apps/api/src/app.ts")).text();
  const match = /export const API_MAX_REQUEST_BODY_BYTES = ([\d\s*]+);/.exec(source);
  if (!match) throw new Error("API_MAX_REQUEST_BODY_BYTES not found in apps/api/src/app.ts");
  return match[1]!.split("*").reduce((product, factor) => product * Number(factor.trim()), 1);
}

async function primary(ingress: Record<string, unknown>): Promise<Ingress> {
  const helm = Bun.which("helm")!;
  const root = await mkdtemp(join(tmpdir(), "opengeni-ingress-body-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(valuesPath, JSON.stringify({ ingress: { enabled: true, ...ingress } }));
  try {
    const process = Bun.spawn(
      [helm, "template", "body-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
    const found = stdout
      .split(/^---$/m)
      .map((document) => Bun.YAML.parse(document) as Ingress | null)
      .find((document) => document?.kind === "Ingress" && document.metadata.name === "body-test-opengeni");
    if (!found) throw new Error("no primary Ingress rendered");
    return found;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
