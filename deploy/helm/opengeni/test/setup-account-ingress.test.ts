import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("managed setup-account ingress", () => {
  test("uses an exact no-telemetry location for the mail-compatible query bearer", async () => {
    const values = await source("../values.yaml");
    const ingress = await source("../templates/ingress.yaml");

    expect(values).toContain("OPENGENI_ORGANIZATION_USER_SETUP_EMAIL_TOKEN_TRANSPORT: fragment");
    expect(values).toContain(
      'OPENGENI_ORGANIZATION_USER_SETUP_QUERY_EDGE_SANITIZATION_CONFIRMED: "false"',
    );
    expect(ingress).toContain(
      '.Values.ingress.setupAccountIngress.enabled .Values.web.enabled (eq .Values.config.OPENGENI_PRODUCT_ACCESS_MODE "managed") (gt (len $setupAccountHosts) 0)',
    );
    expect(ingress).toContain('name: {{ include "opengeni.fullname" . }}-setup-account');
    expect(ingress).toContain("- path: /setup-account\n            pathType: Exact");
    expect(ingress).toContain('nginx.ingress.kubernetes.io/enable-access-log: "false"');
    expect(ingress).toContain('nginx.ingress.kubernetes.io/enable-opentelemetry: "false"');
    expect(ingress).toContain("range $setupAccountHosts");
  });

  test.skipIf(!Bun.which("helm"))(
    "renders only valid managed web-host rules across API-only, multi-host, and non-managed values",
    async () => {
      const apiOnly = await renderIngresses([host("api.example.test", [path("/v1", "api")])]);
      expect(setupIngress(apiOnly)).toBeUndefined();

      const multiHost = await renderIngresses(
        [
          host("api.example.test", [path("/v1", "api")]),
          host("app.example.test", [path("/", "web")]),
          host("mixed.example.test", [path("/healthz", "api"), path("/app", "web")]),
        ],
        {
          setupAnnotations: {
            "nginx.ingress.kubernetes.io/enable-access-log": "true",
            "nginx.ingress.kubernetes.io/enable-opentelemetry": "true",
            "example.test/retained": "yes",
          },
        },
      );
      const setup = setupIngress(multiHost);
      expect(setup?.metadata.annotations).toMatchObject({
        "nginx.ingress.kubernetes.io/enable-access-log": "false",
        "nginx.ingress.kubernetes.io/enable-opentelemetry": "false",
        "example.test/retained": "yes",
      });
      expect(setup?.spec.rules.map((rule) => rule.host)).toEqual([
        "app.example.test",
        "mixed.example.test",
      ]);
      expect(setup?.spec.rules.every((rule) => rule.http.paths.length === 1)).toBe(true);
      expect(setup?.spec.rules[0]?.http.paths[0]).toMatchObject({
        path: "/setup-account",
        pathType: "Exact",
      });

      const localMode = await renderIngresses([host("app.example.test", [path("/", "web")])], {
        productAccessMode: "local",
      });
      expect(setupIngress(localMode)).toBeUndefined();
    },
  );

  test.skipIf(!Bun.which("helm"))(
    "fails query transport closed until controller/edge error-log sanitization is confirmed",
    async () => {
      const hosts = [host("app.example.test", [path("/", "web")])];
      await expect(renderIngresses(hosts, { tokenTransport: "query" })).rejects.toThrow(
        /QUERY_EDGE_SANITIZATION_CONFIRMED/,
      );
      expect(
        setupIngress(
          await renderIngresses(hosts, {
            tokenTransport: "query",
            queryEdgeSanitizationConfirmed: true,
          }),
        ),
      ).toBeDefined();
    },
  );
});

type Ingress = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    rules: Array<{
      host: string;
      http: { paths: Array<{ path: string; pathType: string }> };
    }>;
  };
};

function host(hostname: string, paths: Array<Record<string, string>>) {
  return { host: hostname, paths };
}

function path(route: string, service: "api" | "web") {
  return { path: route, pathType: "Prefix", service };
}

function setupIngress(ingresses: Ingress[]): Ingress | undefined {
  return ingresses.find((manifest) => manifest.metadata.name.endsWith("-setup-account"));
}

async function renderIngresses(
  hosts: Array<{ host: string; paths: Array<Record<string, string>> }>,
  options: {
    productAccessMode?: "local" | "managed";
    setupAnnotations?: Record<string, string>;
    tokenTransport?: "fragment" | "query";
    queryEdgeSanitizationConfirmed?: boolean;
  } = {},
): Promise<Ingress[]> {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for setup-account ingress render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-setup-ingress-"));
  const valuesPath = join(root, "values.json");
  await Bun.write(
    valuesPath,
    JSON.stringify({
      config: {
        OPENGENI_PRODUCT_ACCESS_MODE: options.productAccessMode ?? "managed",
        OPENGENI_ORGANIZATION_USER_SETUP_EMAIL_TOKEN_TRANSPORT:
          options.tokenTransport ?? "fragment",
        OPENGENI_ORGANIZATION_USER_SETUP_QUERY_EDGE_SANITIZATION_CONFIRMED: String(
          options.queryEdgeSanitizationConfirmed ?? false,
        ),
      },
      ingress: {
        enabled: true,
        hosts,
        setupAccountIngress: { annotations: options.setupAnnotations ?? {} },
      },
    }),
  );
  try {
    const process = Bun.spawn(
      [helm, "template", "setup-test", resolve(import.meta.dir, ".."), "-f", valuesPath],
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
