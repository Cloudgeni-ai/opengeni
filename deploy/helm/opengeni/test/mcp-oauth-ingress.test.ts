import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Ingress = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    tls?: unknown[];
    rules: Array<{
      host: string;
      http: {
        paths: Array<{
          path: string;
          pathType: string;
          backend: { service: { name: string; port: { name: string } } };
        }>;
      };
    }>;
  };
};

const protocolRoutes = [
  ["/.well-known/oauth-authorization-server", "Exact"],
  ["/.well-known/oauth-protected-resource", "Prefix"],
  ["/oauth/register", "Exact"],
  ["/oauth/authorize", "Exact"],
  ["/oauth/token", "Exact"],
];

describe.skipIf(!Bun.which("helm"))("workspace MCP OAuth ingress", () => {
  test("is absent while MCP OAuth is disabled, including the chart default", async () => {
    const hosts = [host("app.example.test", [route("/", "web"), route("/v1", "api")])];
    expect(oauthIngress(await render(hosts))).toBeUndefined();
    expect(oauthIngress(await render(hosts, { enabled: "false" }))).toBeUndefined();
    expect(
      oauthIngress(await render(hosts, { enabled: "true", ingressEnabled: false })),
    ).toBeUndefined();
    expect(
      oauthIngress(await render(hosts, { enabled: "true", mcpOAuthIngressEnabled: false })),
    ).toBeUndefined();
  });

  test("routes the issuer-root protocol paths to the API on every API host", async () => {
    for (const enabled of ["true", "1", " On "]) {
      const ingresses = await render(
        [
          host("app.example.test", [route("/", "web"), route("/v1", "api")]),
          host("web-only.example.test", [route("/", "web")]),
          host("api.example.test", [route("/v1", "api")]),
        ],
        {
          enabled,
          annotations: { "example.test/gate": "kept" },
          tls: [{ secretName: "opengeni-tls", hosts: ["app.example.test"] }],
        },
      );
      const ingress = oauthIngress(ingresses);
      expect(ingress?.metadata.annotations).toEqual({ "example.test/gate": "kept" });
      expect(ingress?.spec.tls).toEqual([
        { secretName: "opengeni-tls", hosts: ["app.example.test"] },
      ]);
      expect(ingress?.spec.rules.map((rule) => rule.host)).toEqual([
        "app.example.test",
        "api.example.test",
      ]);
      for (const rule of ingress!.spec.rules) {
        expect(rule.http.paths.map((path) => [path.path, path.pathType])).toEqual(protocolRoutes);
        for (const path of rule.http.paths) {
          expect(path.backend.service).toEqual({
            name: "oauth-test-opengeni-api",
            port: { name: "http" },
          });
        }
      }
    }
  });
});

function host(hostname: string, paths: Array<Record<string, string>>) {
  return { host: hostname, paths };
}

function route(path: string, service: "api" | "web") {
  return { path, pathType: "Prefix", service };
}

function oauthIngress(ingresses: Ingress[]): Ingress | undefined {
  return ingresses.find((manifest) => manifest.metadata.name.endsWith("-mcp-oauth"));
}

async function render(
  hosts: Array<{ host: string; paths: Array<Record<string, string>> }>,
  options: {
    enabled?: string;
    ingressEnabled?: boolean;
    mcpOAuthIngressEnabled?: boolean;
    annotations?: Record<string, string>;
    tls?: unknown[];
  } = {},
): Promise<Ingress[]> {
  const helm = Bun.which("helm")!;
  const root = await mkdtemp(join(tmpdir(), "opengeni-mcp-oauth-ingress-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(
    valuesPath,
    JSON.stringify({
      config: {
        OPENGENI_PRODUCT_ACCESS_MODE: "managed",
        ...(options.enabled === undefined ? {} : { OPENGENI_MCP_OAUTH_ENABLED: options.enabled }),
        OPENGENI_PUBLIC_BASE_URL: "https://app.example.test",
      },
      ingress: {
        enabled: options.ingressEnabled ?? true,
        hosts,
        tls: options.tls ?? [],
        mcpOAuthIngress: {
          enabled: options.mcpOAuthIngressEnabled ?? true,
          annotations: options.annotations ?? {},
        },
      },
    }),
  );
  try {
    const process = Bun.spawn(
      [helm, "template", "oauth-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
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
      .filter((manifest) => manifest.kind === "Ingress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
