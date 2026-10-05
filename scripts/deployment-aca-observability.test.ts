import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateProbeCommand, privateProbeEvidence } from "./deployment-aca-observability";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const kind = "opengeni-aca-private-observability-v1";
const nonce = "22222222-2222-4222-8222-222222222222";
const fixtureKey = "fixture-private-metrics-access-key";
const privateMarker = "private-cli-and-metric-body-marker";
const subscription = "11111111-1111-4111-8111-111111111111";

function evidence(role: "api" | "control" | "turn") {
  return {
    kind,
    nonce,
    role,
    metricsStatus: 200,
    anonymousMetricsStatus: role === "api" ? 401 : null,
    healthStatus: role === "api" ? null : 200,
    readyStatus: role === "api" ? null : 200,
    familyCount: 3,
    requiredFamilies:
      role === "api"
        ? [
            { name: "opengeni_http_requests_total", type: "counter", samples: 1 },
            { name: "opengeni_http_request_duration_seconds", type: "histogram", samples: 1 },
          ]
        : [{ name: "opengeni_build_info", type: "gauge", samples: 1 }],
  };
}

describe("ACA private observability evidence", () => {
  for (const role of ["api", "control", "turn"] as const) {
    test(`requires exact fresh status and metric-family evidence for ${role}`, () => {
      const proof = evidence(role);
      expect(privateProbeEvidence(JSON.stringify(proof), role, nonce).role).toBe(role);
      for (const invalid of [
        { ...proof, nonce: crypto.randomUUID() },
        { ...proof, role: "foreign" },
        { ...proof, metricsStatus: 401 },
        { ...proof, familyCount: 0 },
        { ...proof, requiredFamilies: [] },
        {
          ...proof,
          requiredFamilies: proof.requiredFamilies.map((family) => ({ ...family, samples: 0 })),
        },
        { ...proof, privateSecret: privateMarker },
        ...(role === "api"
          ? [{ ...proof, anonymousMetricsStatus: 200 }]
          : [
              { ...proof, healthStatus: 503 },
              { ...proof, readyStatus: 503 },
            ]),
      ]) {
        expect(() => privateProbeEvidence(JSON.stringify(invalid), role, nonce)).toThrow(
          "No valid private observability evidence",
        );
      }
      expect(() => privateProbeEvidence("ClusterExecFailure", role, nonce)).toThrow();
      expect(() =>
        privateProbeEvidence(`${JSON.stringify(proof)}\n${JSON.stringify(proof)}`, role, nonce),
      ).toThrow();
    });

    test(`runs whitespace-free Bun code against actual loopback HTTP fixtures (${role})`, async () => {
      const headers: (string | null)[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/healthz" || path === "/readyz") return Response.json({ ok: true });
          const key = request.headers.get("x-opengeni-access-key");
          headers.push(key);
          if (role === "api" && key !== fixtureKey)
            return new Response(privateMarker, { status: 401 });
          return new Response(
            [
              "# TYPE opengeni_build_info gauge",
              `opengeni_build_info{private="${privateMarker}"} 1`,
              "# TYPE opengeni_http_requests_total counter",
              'opengeni_http_requests_total{method="GET"} 2',
              "# TYPE opengeni_http_request_duration_seconds histogram",
              'opengeni_http_request_duration_seconds_bucket{le="+Inf"} 2',
              "",
            ].join("\n"),
          );
        },
      });
      try {
        const command = privateProbeCommand(role, nonce, {
          metrics: server.port!,
          health: server.port!,
        });
        const pieces = command.split(" ");
        expect(pieces).toHaveLength(3);
        expect(pieces.slice(0, 2)).toEqual(["bun", "-e"]);
        expect(pieces[2]).not.toMatch(/\s/);
        expect(command).not.toContain(fixtureKey);
        const child = Bun.spawn([process.execPath, "--no-env-file", "-e", pieces[2]!], {
          env: { OPENGENI_ACCESS_KEY: fixtureKey, OPENGENI_WORKER_ROLE: role },
          stdout: "pipe",
          stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 10_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(exitCode).toBe(0);
          expect(stdout + stderr).not.toContain(fixtureKey);
          expect(stdout + stderr).not.toContain(privateMarker);
          const proof = privateProbeEvidence(stdout, role, nonce);
          expect(proof.familyCount).toBe(3);
          expect(proof.requiredFamilies.every((family) => family.samples === 1)).toBe(true);
          expect(headers).toEqual(role === "api" ? [null, fixtureKey] : [null]);
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        server.stop(true);
      }
    });
  }
});

describe("ACA private observability CLI", () => {
  for (const scenario of [
    "ready",
    "cluster-exec-failure",
    "wrong-nonce",
    "worker-not-ready",
    "missing-family",
    "terraform-failure",
    "wrong-app-group",
  ] as const) {
    test(`uses native Terraform identities and never treats exit zero alone as proof (${scenario})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "opengeni-aca-observability-"));
      try {
        const log = join(dir, "commands.log");
        writeFileSync(
          join(dir, "terraform"),
          `#!/bin/sh
test "$1" = '-chdir=deploy/terraform/azure-container-apps' || exit 1
printf '%s\\n' "terraform $*" >> "$ACA_TEST_LOG"
if [ "$ACA_TEST_SCENARIO" = terraform-failure ]; then printf '${privateMarker}\\n' >&2; exit 19; fi
case "$*" in
  *resource_group_name) printf '"test-rg"\\n' ;;
  *serving_app_ids) printf '%s\\n' "$ACA_TEST_IDS" ;;
  *) exit 19 ;;
esac
`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(dir, "az"),
          `#!${process.execPath}
const args=process.argv.slice(2);
await Bun.write(process.env.ACA_TEST_LOG,(await Bun.file(process.env.ACA_TEST_LOG).text())+"az "+args.join(" ")+"\\n");
if(args[1]==="show"){console.log(JSON.stringify(["native-container"]));process.exit(0);}
if(args[1]!=="exec")process.exit(19);
const command=args[args.indexOf("--command")+1];
const pieces=command.split(" ");
if(pieces.length!==3||pieces[0]!=="bun"||pieces[1]!=="-e"||/\\s/.test(pieces[2]))process.exit(19);
const source=pieces[2];
const config=JSON.parse(source.slice(source.indexOf("let[s]=[")+8,source.indexOf("];let[base]")));
let proof={kind:config.kind,nonce:config.nonce,role:config.role,metricsStatus:200,anonymousMetricsStatus:config.role==="api"?401:null,healthStatus:config.role==="api"?null:200,readyStatus:config.role==="api"?null:200,familyCount:3,requiredFamilies:config.required.map(f=>({name:f.name,type:f.type,samples:1}))};
const scenario=process.env.ACA_TEST_SCENARIO;
console.error("${privateMarker}");
if(scenario==="cluster-exec-failure"){console.log("ClusterExecFailure: ${privateMarker}");process.exit(0);}
if(scenario==="wrong-nonce")proof.nonce="33333333-3333-4333-8333-333333333333";
if(scenario==="worker-not-ready"&&config.role==="turn")proof.readyStatus=503;
if(scenario==="missing-family")proof.requiredFamilies=[];
console.log(JSON.stringify(proof));
`,
          { mode: 0o755 },
        );
        const ids = Object.fromEntries(
          ["api", "control", "turn"].map((role) => [
            role,
            `/subscriptions/${subscription}/resourceGroups/${scenario === "wrong-app-group" ? "foreign-rg" : "test-rg"}/providers/Microsoft.App/containerApps/exact-${role}`,
          ]),
        );
        const result = spawnSync(
          process.execPath,
          [
            "--no-env-file",
            "scripts/deployment-aca-observability.ts",
            "--terraform-root",
            "deploy/terraform/azure-container-apps",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 15_000,
            env: {
              PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
              ACA_TEST_LOG: log,
              ACA_TEST_SCENARIO: scenario,
              ACA_TEST_IDS: JSON.stringify(ids),
              OPENGENI_ACCESS_KEY: fixtureKey,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.stdout + result.stderr).not.toContain(privateMarker);
        expect(result.stdout + result.stderr).not.toContain(fixtureKey);
        const output = JSON.parse(result.stdout);
        expect(result.status).toBe(scenario === "ready" ? 0 : 1);
        expect(output.ok).toBe(scenario === "ready");
        if (scenario === "ready") {
          expect(output.results.map((entry: { role: string }) => entry.role)).toEqual([
            "api",
            "control",
            "turn",
          ]);
          expect(output.gaps.join(" ")).toContain("require separate verification");
          const commands = readFileSync(log, "utf8");
          for (const role of ["api", "control", "turn"])
            expect(commands).toContain(`--name exact-${role}`);
          expect(commands).toContain(`--subscription ${subscription}`);
          expect(commands).toContain("--container native-container");
          expect(commands).not.toContain(fixtureKey);
          expect(commands).not.toMatch(/(?:kubectl|helm)/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
