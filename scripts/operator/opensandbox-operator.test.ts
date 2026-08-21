import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseOpenSandboxConformanceArgs } from "./opensandbox-conformance";
import {
  executeBounded,
  loadProfilePassed,
  parseOpenSandboxLoadArgs,
  percentile,
} from "./opensandbox-load-profile";
import {
  forbiddenEnvironmentNames,
  parseOpenSandboxClusterVerificationArgs,
} from "./verify-opensandbox-cluster";

const IMAGE = `registry.example.test/sandbox@sha256:${"a".repeat(64)}`;

describe("OpenSandbox operator harnesses", () => {
  test("parses immutable conformance and bounded load inputs", () => {
    expect(
      parseOpenSandboxConformanceArgs(["--api-key", "key", "--image", IMAGE], {}),
    ).toMatchObject({ ttlSeconds: 3600, image: IMAGE, signedEndpoints: false });
    expect(
      parseOpenSandboxConformanceArgs(
        ["--api-key", "key", "--image", IMAGE, "--signed-endpoints"],
        {},
      ),
    ).toMatchObject({ signedEndpoints: true });
    expect(
      parseOpenSandboxLoadArgs(
        ["--profile", "500", "--tier", "cold-node", "--api-key", "key", "--image", IMAGE],
        {},
      ),
    ).toMatchObject({ profile: "500", count: 500, tier: "cold-node" });
    expect(() =>
      parseOpenSandboxLoadArgs(["--api-key", "key", "--image", "moving:latest"], {}),
    ).toThrow("immutable OCI digest");
    expect(
      parseOpenSandboxLoadArgs(
        [
          "--tier",
          "warm-pool",
          "--pool-ref",
          "opengeni-warm",
          "--api-key",
          "key",
          "--image",
          IMAGE,
        ],
        {},
      ),
    ).toMatchObject({ tier: "warm-pool", poolRef: "opengeni-warm" });
    expect(() =>
      parseOpenSandboxLoadArgs(["--tier", "warm-pool", "--api-key", "key", "--image", IMAGE], {}),
    ).toThrow("requires --pool-ref");
    expect(() =>
      parseOpenSandboxLoadArgs(
        ["--pool-ref", "opengeni-warm", "--api-key", "key", "--image", IMAGE],
        {},
      ),
    ).toThrow("requires --tier warm-pool");
  });

  test("bounds load concurrency and computes nearest-rank percentiles", async () => {
    let active = 0;
    let peak = 0;
    await executeBounded(31, 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active -= 1;
    });
    expect(peak).toBe(4);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
  });

  test("cannot pass a load profile while exact cleanup failed or retained sessions remain", () => {
    expect(
      loadProfilePassed({
        successRate: 1,
        minimumSuccessRate: 0.99,
        exactDeleteAttempted: 50,
        exactDeleteSucceeded: 49,
        retainedSessions: 1,
      }),
    ).toBe(false);
    expect(
      loadProfilePassed({
        successRate: 0.998,
        minimumSuccessRate: 0.99,
        exactDeleteAttempted: 500,
        exactDeleteSucceeded: 500,
        retainedSessions: 0,
      }),
    ).toBe(true);
  });

  test("detects forbidden control-plane credentials in sandbox Pod env", () => {
    expect(
      forbiddenEnvironmentNames({
        items: [
          {
            spec: {
              containers: [{ env: [{ name: "SAFE" }, { name: "OPENGENI_DATABASE_URL" }] }],
            },
          },
        ],
      }),
    ).toEqual(["OPENGENI_DATABASE_URL"]);
    expect(parseOpenSandboxClusterVerificationArgs(["--expect-zero"])).toMatchObject({
      expectZero: true,
      namespace: "opensandbox",
    });
  });

  test("chart preparation reserves stdout for the packaged chart path", async () => {
    const script = await readFile(resolve(import.meta.dir, "prepare-opensandbox-chart.sh"), "utf8");

    expect(script.match(/sha256sum -c - >&2/g)).toHaveLength(5);
    expect(script).toContain('helm lint "$chart_dir" >&2');
    expect(script.trimEnd()).toEndWith("printf '%s\\n' \"$chart_archive\"");
  });

  test("post-renderer pins the ingress digest alongside controller and server", async () => {
    const lock = await readFile(
      resolve(import.meta.dir, "../../deploy/stacks/opensandbox-source.lock"),
      "utf8",
    );
    expect(lock).toContain(
      "OPENSANDBOX_INGRESS_IMAGE=docker.io/opensandbox/ingress@sha256:450cdae23c7987e6b4974e56577f9569cc0eb7e48e54eff88c11f023db3b35b4",
    );
    const rendered = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn("bash", [resolve(import.meta.dir, "opensandbox-image-post-renderer.sh")], {
        cwd: resolve(import.meta.dir, "../.."),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout);
        else reject(new Error(stderr || `post-renderer exited ${String(code)}`));
      });
      child.stdin.end(
        "image: docker.io/opensandbox/ingress:v1.0.10\nother: sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/ingress:v1.0.10\n",
      );
    });
    expect(rendered).toContain(
      "docker.io/opensandbox/ingress@sha256:450cdae23c7987e6b4974e56577f9569cc0eb7e48e54eff88c11f023db3b35b4",
    );
    expect(rendered).not.toContain("ingress:v1.0.10");
  });

  test("materializes secure-access TOML from env without logging secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osb-secure-"));
    const source = join(dir, "config.toml");
    const dest = join(dir, "runtime.toml");
    await writeFile(
      source,
      `[ingress]\nmode = "gateway"\n\ngateway.address = "gw.example"\ngateway.route.mode = "uri"\n`,
    );
    const child = spawn("python3", [resolve(import.meta.dir, "opensandbox-materialize-secure-access-config.py")], {
      cwd: dir,
      env: {
        ...process.env,
        SANDBOX_CONFIG_PATH: source,
        OPENSANDBOX_RUNTIME_CONFIG_PATH: dest,
        OPENSANDBOX_SECURE_ACCESS_KEYS: "a=dGVzdC1rZXktYnl0ZXMtZm9yLXVuaXQ=",
        OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY: "a",
      },
    });
    const stderr = await new Promise<string>((resolvePromise, reject) => {
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(err + out);
        else reject(new Error(err || `materializer exited ${String(code)}`));
      });
    });
    expect(stderr).toContain("materialized");
    expect(stderr).not.toContain("dGVzdC1rZXktYnl0ZXMtZm9yLXVuaXQ=");
    const rendered = await readFile(dest, "utf8");
    expect(rendered).toContain("[ingress.secure_access]");
    expect(rendered).toContain('active_key = "a"');
    expect(rendered).toContain('key = "dGVzdC1rZXktYnl0ZXMtZm9yLXVuaXQ="');
    expect(rendered).toContain('mode = "gateway"');
  });

  test("post-renderer injects a secure-access runtime-config initContainer", async () => {
    const fixture = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opensandbox-server
spec:
  template:
    spec:
      containers:
        - name: main
          image: docker.io/opensandbox/server:v0.2.2
          args: ["--config", "/etc/opensandbox/config.toml"]
          env:
            - name: SANDBOX_CONFIG_PATH
              value: /etc/opensandbox/config.toml
            - name: OPENSANDBOX_SECURE_ACCESS_KEYS
              valueFrom:
                secretKeyRef:
                  name: opensandbox-secure-access
                  key: keys
            - name: OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY
              valueFrom:
                secretKeyRef:
                  name: opensandbox-secure-access
                  key: active-key
          volumeMounts:
            - name: config
              mountPath: /etc/opensandbox/config.toml
              subPath: config.toml
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: opensandbox-server-config
---
apiVersion: v1
kind: Service
metadata:
  name: opensandbox-server
`;
    const rendered = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn("bash", [resolve(import.meta.dir, "opensandbox-image-post-renderer.sh")], {
        cwd: resolve(import.meta.dir, "../.."),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout);
        else reject(new Error(stderr || `post-renderer exited ${String(code)}`));
      });
      child.stdin.end(fixture);
    });
    expect(rendered).toContain("materialize-secure-access-config");
    expect(rendered).toContain("/runtime-config/config.toml");
    expect(rendered).toContain("opensandbox-secure-access-runtime-config");
    expect(rendered).toContain("kind: Service");
    expect(rendered).toContain("docker.io/opensandbox/server@sha256:");
    expect(rendered).not.toContain("value: a=");
  });

  test("ships the Channel B signed-endpoint proof as an operator script", async () => {
    const source = await readFile(
      resolve(import.meta.dir, "opensandbox-signed-endpoint-proof.ts"),
      "utf8",
    );
    expect(source).toContain("signedEndpoints: true");
    expect(source).toContain("resolveExposedPort");
    expect(source).toContain("redactOpenSandboxSignedUriPath");
    expect(source).toContain("isOpenSandboxLifecycleProxyPath");
    expect(source).toContain("parseOpenSandboxSignedUriPath");
    expect(source).not.toContain("OpenSandbox-Secure-Access");
  });
});
