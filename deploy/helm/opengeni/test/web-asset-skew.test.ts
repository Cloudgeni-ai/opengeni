import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Web pods of two builds serve side by side during a rollout, and open tabs keep
// requesting their own build's hashed assets after it. These tests pin the chart
// half of keeping those requests working: previous web images carried into an
// emptyDir (live lookup, explicit list, cap, annotation chain) and the
// ingress-nginx asset Ingress that retries a 404 on another pod.

type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: any;
};

const CHART = resolve(import.meta.dir, "..");
const LOOKUP_LINE =
  '{{- lookup "apps/v1" "Deployment" .Release.Namespace (printf "%s-web" (include "opengeni.fullname" .)) | toJson -}}';
const ANNOTATION = "opengeni.ai/previous-web-images";
const MOUNT = "/var/lib/opengeni/previous-web-assets";
const helm = Bun.which("helm");

async function render(
  values: Record<string, unknown>,
  live?: Record<string, unknown>,
): Promise<Manifest[]> {
  if (!helm) throw new Error("helm is required for chart render tests");
  const root = await mkdtemp(join(tmpdir(), "opengeni-web-assets-"));
  try {
    let chart = CHART;
    if (live) {
      // `helm template` has no cluster, so substitute the one live lookup the
      // previous-asset chain reads with a fixture taken from values.
      chart = join(root, "chart");
      const tests = join(CHART, "test");
      await cp(CHART, chart, {
        recursive: true,
        filter: (path) => path !== tests && !path.startsWith(`${tests}/`),
      });
      const helpersPath = join(chart, "templates/_helpers.tpl");
      const helpers = await readFile(helpersPath, "utf8");
      expect(helpers).toContain(LOOKUP_LINE);
      await writeFile(
        helpersPath,
        helpers.replace(
          LOOKUP_LINE,
          "{{- .Values.testLiveWebDeployment | default dict | toJson -}}",
        ),
      );
      values = { ...values, testLiveWebDeployment: live };
    }
    const valuesPath = join(root, "values.json");
    await Bun.write(valuesPath, JSON.stringify({ global: { imageRegistry: "" }, ...values }));
    const process = Bun.spawn([helm, "template", "skew", chart, "-f", valuesPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
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
      .map((document) => Bun.YAML.parse(document) as Manifest)
      .filter((manifest) => manifest && typeof manifest.kind === "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function webDeployment(manifests: Manifest[]): Manifest {
  const found = manifests.find(
    (manifest) => manifest.kind === "Deployment" && manifest.metadata.name === "skew-opengeni-web",
  );
  if (!found) throw new Error("missing web Deployment");
  return found;
}

function webImage(tag: string): Record<string, unknown> {
  return { web: { image: { repository: "registry.test/opengeni-web", tag } } };
}

function liveWeb(image: string, carried?: string): Record<string, unknown> {
  return {
    metadata: {
      name: "skew-opengeni-web",
      ...(carried ? { annotations: { [ANNOTATION]: carried } } : {}),
    },
    spec: { template: { spec: { containers: [{ name: "web", image }] } } },
  };
}

function carriedImages(deployment: Manifest): string[] {
  return (deployment.spec.template.spec.initContainers ?? []).map(
    (container: { image: string }) => container.image,
  );
}

const image = (tag: string) => `registry.test/opengeni-web:${tag}`;

describe.skipIf(!helm)("previous web assets", () => {
  test("offline renders without explicit images carry nothing and match the feature turned off", async () => {
    const offline = webDeployment(await render(webImage("v2")));
    const disabled = webDeployment(
      await render({ web: { ...webImage("v2").web, previousAssets: { enabled: false } } } as any),
    );
    expect(offline.metadata.annotations).toBeUndefined();
    expect(offline.spec.template.spec.initContainers).toBeUndefined();
    expect(offline.spec.template.spec.volumes).toBeUndefined();
    expect(offline.spec.template.spec.containers[0].volumeMounts).toBeUndefined();
    expect(JSON.stringify(offline.spec.template.spec.containers[0].env)).not.toContain(
      "OPENGENI_WEB_PREVIOUS_ASSET_ROOTS",
    );
    expect(offline).toEqual(disabled);
  });

  test("an explicit list is trimmed, de-duplicated, capped and never carries the deployed image", async () => {
    const deployment = webDeployment(
      await render({
        web: {
          image: { repository: "registry.test/opengeni-web", tag: "v4" },
          previousAssets: {
            images: [image("v4"), ` ${image("v3")} `, image("v3"), "", image("v2"), image("v1")],
          },
        },
      }),
    );
    expect(carriedImages(deployment)).toEqual([image("v3"), image("v2")]);
    expect(deployment.metadata.annotations).toEqual({
      [ANNOTATION]: `${image("v3")},${image("v2")}`,
    });
  });

  test("each carried image copies its assets into the shared volume the server reads", async () => {
    const script = await readFile(join(CHART, "files/copy-previous-web-assets.js"), "utf8");
    const deployment = webDeployment(
      await render({
        web: {
          image: { repository: "registry.test/opengeni-web", tag: "v3", pullPolicy: "Always" },
          previousAssets: { images: [image("v2"), image("v1")], sizeLimit: "1Gi" },
        },
      }),
    );
    const pod = deployment.spec.template.spec;
    expect(pod.initContainers).toHaveLength(2);
    for (const [index, initContainer] of pod.initContainers.entries()) {
      expect(initContainer).toMatchObject({
        name: `previous-web-assets-${index}`,
        image: image(index === 0 ? "v2" : "v1"),
        imagePullPolicy: "Always",
        // Old web images have Bun but no shell, and may predate this chart.
        command: ["bun", "-e", script],
        env: [
          { name: "OPENGENI_PREVIOUS_WEB_DIST", value: "/app/apps/web/dist" },
          { name: "OPENGENI_PREVIOUS_WEB_ASSETS_TARGET", value: `${MOUNT}/${index}` },
        ],
        volumeMounts: [{ name: "previous-web-assets", mountPath: MOUNT }],
        securityContext: pod.containers[0].securityContext,
        resources: pod.containers[0].resources,
      });
    }
    const web = pod.containers[0];
    expect(web.env).toContainEqual({
      name: "OPENGENI_WEB_PREVIOUS_ASSET_ROOTS",
      value: `${MOUNT}/0,${MOUNT}/1`,
    });
    expect(web.volumeMounts).toEqual([
      { name: "previous-web-assets", mountPath: MOUNT, readOnly: true },
    ]);
    expect(pod.volumes).toEqual([{ name: "previous-web-assets", emptyDir: { sizeLimit: "1Gi" } }]);
  });

  test("keeps the demo credential mount and env alongside the previous assets", async () => {
    const pod = webDeployment(
      await render({
        api: { enabled: false },
        web: {
          image: { repository: "registry.test/opengeni-web", tag: "v2" },
          demoApiBaseUrl: "http://api.test",
          demoApiCredentialsSecret: "demo-credentials",
          previousAssets: { images: [image("v1")] },
        },
      }),
    ).spec.template.spec;
    expect(pod.containers[0].volumeMounts.map((mount: { name: string }) => mount.name)).toEqual([
      "demo-api-credentials",
      "previous-web-assets",
    ]);
    expect(pod.volumes.map((volume: { name: string }) => volume.name)).toEqual([
      "demo-api-credentials",
      "previous-web-assets",
    ]);
    expect(pod.containers[0].env.map((entry: { name: string }) => entry.name)).toEqual([
      "OPENGENI_DEPLOYMENT_REVISION",
      "OPENGENI_DEMO_API_URL",
      "OPENGENI_DEMO_CREDENTIALS_DIR",
      "OPENGENI_WEB_PREVIOUS_ASSET_ROOTS",
    ]);
    expect(pod.volumes[1]).toEqual({ name: "previous-web-assets", emptyDir: {} });
  });

  test("the first upgrade that ships this carries the live pre-feature web image", async () => {
    // The live Deployment predates the feature: no annotation, no init containers.
    const deployment = webDeployment(await render(webImage("v2"), liveWeb(image("v1"))));
    expect(carriedImages(deployment)).toEqual([image("v1")]);
    expect(deployment.metadata.annotations).toEqual({ [ANNOTATION]: image("v1") });
  });

  test("upgrades chain the live image ahead of the images it carried, capped at maxImages", async () => {
    expect(
      carriedImages(webDeployment(await render(webImage("v3"), liveWeb(image("v2"), image("v1"))))),
    ).toEqual([image("v2"), image("v1")]);
    const capped = webDeployment(
      await render(webImage("v4"), liveWeb(image("v3"), `${image("v2")},${image("v1")}`)),
    );
    expect(carriedImages(capped)).toEqual([image("v3"), image("v2")]);
    expect(capped.metadata.annotations?.[ANNOTATION]).toBe(`${image("v3")},${image("v2")}`);
    expect(
      carriedImages(
        webDeployment(
          await render(
            { web: { ...webImage("v4").web, previousAssets: { maxImages: 3 } } } as any,
            liveWeb(image("v3"), `${image("v2")},${image("v1")}`),
          ),
        ),
      ),
    ).toEqual([image("v3"), image("v2"), image("v1")]);
  });

  test("config-only upgrades keep the chain and upgrading to an older image keeps the newer build", async () => {
    const sameImage = webDeployment(
      await render(webImage("v3"), liveWeb(image("v3"), `${image("v2")},${image("v1")}`)),
    );
    expect(carriedImages(sameImage)).toEqual([image("v2"), image("v1")]);

    // `helm upgrade` to v2 over v3 (not `helm rollback`, which re-applies the
    // stored manifest without a lookup): v3's assets stay available to v3 tabs.
    const olderImage = webDeployment(
      await render(webImage("v2"), liveWeb(image("v3"), `${image("v2")},${image("v1")}`)),
    );
    expect(carriedImages(olderImage)).toEqual([image("v3"), image("v1")]);
  });

  test("ignores empty or malformed carried annotations and other containers", async () => {
    const live = liveWeb(image("v1"), ` , ,${image("v0")},,`);
    (live.spec as any).template.spec.containers.unshift({ name: "sidecar", image: "sidecar:1" });
    expect(carriedImages(webDeployment(await render(webImage("v2"), live)))).toEqual([
      image("v1"),
      image("v0"),
    ]);
  });

  test("an explicit list replaces the live lookup, and disabling or zero carries nothing", async () => {
    const live = liveWeb(image("v2"), image("v1"));
    expect(
      carriedImages(
        webDeployment(
          await render(
            {
              web: { ...webImage("v3").web, previousAssets: { images: [image("pinned")] } },
            } as any,
            live,
          ),
        ),
      ),
    ).toEqual([image("pinned")]);
    for (const previousAssets of [{ enabled: false }, { maxImages: 0 }]) {
      const deployment = webDeployment(
        await render({ web: { ...webImage("v3").web, previousAssets } } as any, live),
      );
      expect(carriedImages(deployment)).toEqual([]);
      expect(deployment.metadata.annotations).toBeUndefined();
    }
  });
});

describe("previous web asset copy script", () => {
  async function runScript(env: Record<string, string>) {
    const script = await readFile(join(CHART, "files/copy-previous-web-assets.js"), "utf8");
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("copies every hashed asset directory and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-copy-assets-"));
    try {
      const dist = join(root, "dist");
      for (const [path, body] of Object.entries({
        "index.html": "shell",
        "assets/app-1.js": "app",
        "assets/app-1.js.gz": "gz",
        "assets/nested/font-1.woff2": "font",
        "office/taskpane.html": "office shell",
        "office/assets/taskpane-1.js": "office",
      })) {
        await mkdir(join(dist, path, ".."), { recursive: true });
        await writeFile(join(dist, path), body);
      }
      const target = join(root, "volume/0");
      const result = await runScript({
        OPENGENI_PREVIOUS_WEB_DIST: dist,
        OPENGENI_PREVIOUS_WEB_ASSETS_TARGET: target,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("copied 2 asset directories");
      expect(result.stderr).toBe("");
      expect(await readFile(join(target, "assets/app-1.js"), "utf8")).toBe("app");
      expect(await readFile(join(target, "assets/app-1.js.gz"), "utf8")).toBe("gz");
      expect(await readFile(join(target, "assets/nested/font-1.woff2"), "utf8")).toBe("font");
      expect(await readFile(join(target, "office/assets/taskpane-1.js"), "utf8")).toBe("office");
      expect(await Bun.file(join(target, "index.html")).exists()).toBe(false);
      expect(await Bun.file(join(target, "office/taskpane.html")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exits 0 when the image has no dist or the copy fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-copy-assets-"));
    try {
      const missing = await runScript({
        OPENGENI_PREVIOUS_WEB_DIST: join(root, "no-dist"),
        OPENGENI_PREVIOUS_WEB_ASSETS_TARGET: join(root, "volume/0"),
      });
      expect(missing.exitCode).toBe(0);
      expect(missing.stdout).toContain("copied 0 asset directories");

      await mkdir(join(root, "dist/assets"), { recursive: true });
      await writeFile(join(root, "dist/assets/app-1.js"), "app");
      await writeFile(join(root, "blocked"), "a file where the target directory should be");
      const blocked = await runScript({
        OPENGENI_PREVIOUS_WEB_DIST: join(root, "dist"),
        OPENGENI_PREVIOUS_WEB_ASSETS_TARGET: join(root, "blocked"),
      });
      expect(blocked.exitCode).toBe(0);
      expect(blocked.stderr).toContain("previous web assets: skipped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function ingressValues(ingress: Record<string, unknown>): Record<string, unknown> {
  return {
    ingress: {
      enabled: true,
      className: "nginx",
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt",
        "acme.cert-manager.io/http01-edit-in-place": "true",
        "kubernetes.io/tls-acme": "true",
        "nginx.ingress.kubernetes.io/auth-type": "basic",
        "nginx.ingress.kubernetes.io/auth-secret": "edge-basic-auth",
        "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
      },
      tls: [{ hosts: ["app.example.test"], secretName: "app-tls" }],
      hosts: [
        {
          host: "app.example.test",
          paths: [
            { path: "/", pathType: "Prefix", service: "web" },
            { path: "/v1", pathType: "Prefix", service: "api" },
          ],
        },
        { host: "api.example.test", paths: [{ path: "/v1", pathType: "Prefix", service: "api" }] },
      ],
      ...ingress,
    },
  };
}

function ingress(manifests: Manifest[], name: string): Manifest | undefined {
  return manifests.find(
    (manifest) => manifest.kind === "Ingress" && manifest.metadata.name === name,
  );
}

function rulePaths(manifest: Manifest | undefined): Record<string, string[]> {
  return Object.fromEntries(
    (manifest?.spec.rules ?? []).map((rule: any) => [
      rule.host,
      rule.http.paths.map(
        (path: any) =>
          `${path.path} ${path.pathType} ${path.backend.service.name}:${path.backend.service.port.name}`,
      ),
    ]),
  );
}

describe.skipIf(!helm)("web asset ingress", () => {
  test("retries a hashed asset 404 on another web pod with the primary class, TLS and annotations", async () => {
    const manifests = await render(ingressValues({}));
    const assets = ingress(manifests, "skew-opengeni-web-assets");
    expect(assets?.metadata.annotations).toEqual({
      "nginx.ingress.kubernetes.io/auth-type": "basic",
      "nginx.ingress.kubernetes.io/auth-secret": "edge-basic-auth",
      "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
      "nginx.ingress.kubernetes.io/proxy-next-upstream": "error timeout http_404",
      "nginx.ingress.kubernetes.io/proxy-next-upstream-tries": "3",
    });
    expect(assets?.spec.ingressClassName).toBe("nginx");
    expect(assets?.spec.tls).toEqual([{ hosts: ["app.example.test"], secretName: "app-tls" }]);
    expect(rulePaths(assets)).toEqual({
      "app.example.test": [
        "/assets Prefix skew-opengeni-web:http",
        "/office/assets Prefix skew-opengeni-web:http",
        "/react-demo/assets Prefix skew-opengeni-web:http",
      ],
    });
  });

  test("leaves the primary Ingress unchanged", async () => {
    const withAssets = await render(ingressValues({}));
    const without = await render(ingressValues({ webAssetsIngress: { enabled: false } }));
    expect(ingress(without, "skew-opengeni-web-assets")).toBeUndefined();
    expect(ingress(withAssets, "skew-opengeni")).toEqual(ingress(without, "skew-opengeni"));
    expect(
      withAssets.filter((manifest) => manifest.metadata.name !== "skew-opengeni-web-assets"),
    ).toEqual(without);
  });

  test("covers only asset paths that the primary Ingress already sends to web", async () => {
    const assets = ingress(
      await render(
        ingressValues({
          hosts: [
            {
              host: "app.example.test",
              paths: [
                { path: "/", pathType: "Prefix", service: "web", portName: "web-http" },
                // Explicit asset routes stay with the primary Ingress.
                { path: "/assets", pathType: "Prefix", service: "web" },
                { path: "/office/", pathType: "Prefix", service: "api" },
                { path: "/react-demo/assets/exact", pathType: "Exact", service: "api" },
              ],
            },
            {
              host: "prefixed.example.test",
              paths: [{ path: "/console", pathType: "Prefix", service: "web" }],
            },
            {
              host: "legacy.example.test",
              paths: [{ path: "/", pathType: "ImplementationSpecific", service: "web" }],
            },
            {
              host: "api.example.test",
              paths: [{ path: "/", pathType: "Prefix", service: "api" }],
            },
          ],
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(rulePaths(assets)).toEqual({
      "app.example.test": ["/react-demo/assets Prefix skew-opengeni-web:web-http"],
      "legacy.example.test": [
        "/assets Prefix skew-opengeni-web:http",
        "/office/assets Prefix skew-opengeni-web:http",
        "/react-demo/assets Prefix skew-opengeni-web:http",
      ],
    });
  });

  test("judges a host listed in several entries as ingress-nginx merges it", async () => {
    const assets = ingress(
      await render(
        ingressValues({
          hosts: [
            {
              host: "app.example.test",
              paths: [{ path: "/", pathType: "Prefix", service: "web" }],
            },
            {
              host: "app.example.test",
              paths: [{ path: "/assets", pathType: "Prefix", service: "api" }],
            },
            {
              host: "split.example.test",
              paths: [{ path: "/v1", pathType: "Prefix", service: "api" }],
            },
            {
              host: "split.example.test",
              paths: [{ path: "/", pathType: "Prefix", service: "web" }],
            },
          ],
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(rulePaths(assets)).toEqual({
      "app.example.test": [
        "/office/assets Prefix skew-opengeni-web:http",
        "/react-demo/assets Prefix skew-opengeni-web:http",
      ],
      "split.example.test": [
        "/assets Prefix skew-opengeni-web:http",
        "/office/assets Prefix skew-opengeni-web:http",
        "/react-demo/assets Prefix skew-opengeni-web:http",
      ],
    });
    expect(assets?.spec.rules).toHaveLength(2);
  });

  test("keeps a host-less catch-all rule host-less", async () => {
    const assets = ingress(
      await render(
        ingressValues({
          hosts: [
            { paths: [{ path: "/", pathType: "Prefix", service: "web" }] },
            {
              host: "app.example.test",
              paths: [{ path: "/", pathType: "Prefix", service: "web" }],
            },
          ],
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(assets?.spec.rules).toHaveLength(2);
    expect(Object.hasOwn(assets?.spec.rules[0], "host")).toBe(false);
    expect(assets?.spec.rules[0].http.paths.map((path: any) => path.path)).toEqual([
      "/assets",
      "/office/assets",
      "/react-demo/assets",
    ]);
    expect(assets?.spec.rules[1].host).toBe("app.example.test");
  });

  test("keeps rewrites, canaries, server-level settings and DNS ownership off the asset Ingress", async () => {
    const assets = ingress(
      await render(
        ingressValues({
          annotations: {
            "nginx.ingress.kubernetes.io/auth-url": "https://auth.example.test/check",
            "nginx.ingress.kubernetes.io/whitelist-source-range": "10.0.0.0/8",
            "nginx.ingress.kubernetes.io/rewrite-target": "/$1",
            "nginx.ingress.kubernetes.io/app-root": "/console",
            "nginx.ingress.kubernetes.io/canary": "true",
            "nginx.ingress.kubernetes.io/canary-weight": "10",
            "nginx.ingress.kubernetes.io/server-snippet": "location /x { return 404; }",
            "nginx.ingress.kubernetes.io/server-alias": "www.example.test",
            "external-dns.alpha.kubernetes.io/hostname": "app.example.test",
            "cert-manager.io/cluster-issuer": "letsencrypt",
          },
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(assets?.metadata.annotations).toEqual({
      "nginx.ingress.kubernetes.io/auth-url": "https://auth.example.test/check",
      "nginx.ingress.kubernetes.io/whitelist-source-range": "10.0.0.0/8",
      "nginx.ingress.kubernetes.io/proxy-next-upstream": "error timeout http_404",
      "nginx.ingress.kubernetes.io/proxy-next-upstream-tries": "3",
    });
  });

  test("accepts the legacy ingress class annotation as the class", async () => {
    const legacy = ingress(
      await render(
        ingressValues({
          className: "",
          annotations: { "kubernetes.io/ingress.class": "nginx" },
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(legacy?.spec.ingressClassName).toBeUndefined();
    expect(legacy?.metadata.annotations?.["kubernetes.io/ingress.class"]).toBe("nginx");
    expect(
      ingress(
        await render(
          ingressValues({
            className: "",
            annotations: { "kubernetes.io/ingress.class": "traefik" },
          }),
        ),
        "skew-opengeni-web-assets",
      ),
    ).toBeUndefined();
  });

  test("renders only for ingress-nginx unless configured otherwise", async () => {
    for (const values of [
      ingressValues({ className: "traefik" }),
      ingressValues({ className: "" }),
      ingressValues({ enabled: false }),
      ingressValues({ webAssetsIngress: { enabled: false } }),
      { ...ingressValues({}), web: { enabled: false } },
      ingressValues({
        hosts: [
          {
            host: "api.example.test",
            paths: [{ path: "/v1", pathType: "Prefix", service: "api" }],
          },
        ],
      }),
    ]) {
      expect(ingress(await render(values), "skew-opengeni-web-assets")).toBeUndefined();
    }
    expect(
      ingress(
        await render(ingressValues({ className: "nginx-internal" })),
        "skew-opengeni-web-assets",
      ),
    ).toBeDefined();
    const custom = ingress(
      await render(
        ingressValues({
          className: "webapprouting.kubernetes.azure.com",
          webAssetsIngress: {
            requireNginxClassName: false,
            nextUpstreamTries: 4,
            annotations: { "nginx.ingress.kubernetes.io/proxy-next-upstream-timeout": "10" },
          },
        }),
      ),
      "skew-opengeni-web-assets",
    );
    expect(custom?.spec.ingressClassName).toBe("webapprouting.kubernetes.azure.com");
    expect(custom?.metadata.annotations).toMatchObject({
      "nginx.ingress.kubernetes.io/proxy-next-upstream-tries": "4",
      "nginx.ingress.kubernetes.io/proxy-next-upstream-timeout": "10",
    });
  });
});
