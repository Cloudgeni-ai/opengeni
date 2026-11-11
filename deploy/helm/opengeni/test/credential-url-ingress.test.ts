import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Route = {
  path: string;
  pathType: string;
  backend: { service: { name: string; port: { name: string } } };
};

type Ingress = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: { rules: Array<{ host?: string; http: { paths: Route[] } }> };
};

const API_CREDENTIAL_PATHS = [
  "/v1/auth/reset-password",
  "/v1/auth/verify-email",
  "/v1/auth/callback",
  "/v1/integrations/oauth/callback",
  "/v1/integrations/provider-oauth/callback",
  "/v1/integrations/fiken/callback",
  "/v1/integrations/slack/callback",
  "/v1/integrations/github-personal/oauth/callback",
  "/v1/social/oauth/callback",
  "/v1/github/oauth/callback",
  "/v1/github/setup",
  "/v1/github/install/callback",
  "/v1/github/app-manifest/callback",
];

describe("credential URL ingress", () => {
  test("is enabled by default", async () => {
    const values = await readFile(new URL("../values.yaml", import.meta.url), "utf8");
    expect(values).toContain("credentialUrlIngress:\n    enabled: true");
  });

  test.skipIf(!Bun.which("helm"))(
    "splits every token-bearing path off the logged Ingress without rerouting it",
    async () => {
      const ingresses = await renderIngresses(
        [
          host("api.example.test", [path("/v1", "api"), path("/healthz", "api", "Exact")]),
          host("app.example.test", [path("/", "web", "Prefix", "http")]),
          host("mixed.example.test", [
            path("/", "web"),
            path("/v1", "api"),
            // A narrower route to another service keeps serving its own paths.
            path("/v1/github", "web"),
          ]),
        ],
        {
          primaryAnnotations: {
            "nginx.ingress.kubernetes.io/auth-type": "basic",
            "nginx.ingress.kubernetes.io/enable-access-log": "true",
          },
          credentialAnnotations: {
            "nginx.ingress.kubernetes.io/enable-opentelemetry": "true",
            "example.test/extra": "yes",
          },
        },
      );
      const credential = credentialIngress(ingresses);
      expect(credential?.metadata.annotations).toMatchObject({
        "nginx.ingress.kubernetes.io/enable-access-log": "false",
        "nginx.ingress.kubernetes.io/enable-opentelemetry": "false",
        "nginx.ingress.kubernetes.io/auth-type": "basic",
        "nginx.ingress.kubernetes.io/proxy-body-size": "32m",
        "example.test/extra": "yes",
      });
      const rules = Object.fromEntries(
        (credential?.spec.rules ?? []).map((rule) => [rule.host, rule.http.paths]),
      );
      expect(Object.keys(rules)).toEqual([
        "api.example.test",
        "app.example.test",
        "mixed.example.test",
      ]);
      expect(rules["api.example.test"]?.map((route) => route.path)).toEqual(API_CREDENTIAL_PATHS);
      expect(
        rules["api.example.test"]?.every(
          (route) => route.backend.service.name === "credential-test-opengeni-api",
        ),
      ).toBe(true);
      expect(rules["api.example.test"]?.[0]?.pathType).toBe("Prefix");
      expect(rules["api.example.test"]?.[3]?.pathType).toBe("Exact");
      expect(rules["app.example.test"]).toEqual([
        {
          path: "/reset-password",
          pathType: "Exact",
          backend: { service: { name: "credential-test-opengeni-web", port: { name: "http" } } },
        },
      ]);
      expect(rules["mixed.example.test"]?.map((route) => route.path)).toEqual([
        ...API_CREDENTIAL_PATHS.filter((route) => !route.startsWith("/v1/github/")),
        "/reset-password",
      ]);
    },
  );

  test.skipIf(!Bun.which("helm"))(
    "renders nothing when disabled or no host routes them",
    async () => {
      const hosts = [host("app.example.test", [path("/", "web"), path("/v1", "api")])];
      expect(credentialIngress(await renderIngresses(hosts, { enabled: false }))).toBeUndefined();
      expect(
        credentialIngress(await renderIngresses([host("x.example.test", [path("/docs", "web")])])),
      ).toBeUndefined();
    },
  );
});

function host(hostname: string, paths: Array<Record<string, string>>) {
  return { host: hostname, paths };
}

function path(route: string, service: "api" | "web", pathType = "Prefix", portName?: string) {
  return { path: route, pathType, service, ...(portName ? { portName } : {}) };
}

function credentialIngress(ingresses: Ingress[]): Ingress | undefined {
  return ingresses.find((manifest) => manifest.metadata.name.endsWith("-credential-urls"));
}

async function renderIngresses(
  hosts: Array<{ host: string; paths: Array<Record<string, string>> }>,
  options: {
    enabled?: boolean;
    primaryAnnotations?: Record<string, string>;
    credentialAnnotations?: Record<string, string>;
  } = {},
): Promise<Ingress[]> {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for credential URL ingress render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-credential-ingress-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(
    valuesPath,
    JSON.stringify({
      ingress: {
        enabled: true,
        hosts,
        annotations: options.primaryAnnotations ?? {},
        credentialUrlIngress: {
          enabled: options.enabled ?? true,
          annotations: options.credentialAnnotations ?? {},
        },
      },
    }),
  );
  try {
    const process = Bun.spawn(
      [helm, "template", "credential-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`helm template failed: ${stderr}`);
    return stdout
      .split(/^---\s*$/mu)
      .map((document) => document.trim())
      .filter(Boolean)
      .map((document) => Bun.YAML.parse(document) as Ingress)
      .filter((manifest) => manifest?.kind === "Ingress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
