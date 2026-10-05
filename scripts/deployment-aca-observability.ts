import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { deflateSync } from "node:zlib";
import { z } from "zod";

const roles = ["api", "control", "turn"] as const;
type Role = (typeof roles)[number];
const kind = "opengeni-aca-private-observability-v1";
const requiredFamilies = {
  api: [
    {
      name: "opengeni_http_requests_total",
      type: "counter",
      sample: "opengeni_http_requests_total",
    },
    {
      name: "opengeni_http_request_duration_seconds",
      type: "histogram",
      sample: "opengeni_http_request_duration_seconds_bucket",
    },
  ],
  control: [{ name: "opengeni_build_info", type: "gauge", sample: "opengeni_build_info" }],
  turn: [{ name: "opengeni_build_info", type: "gauge", sample: "opengeni_build_info" }],
} as const;

const Evidence = z.strictObject({
  kind: z.literal(kind),
  nonce: z.uuid(),
  role: z.enum(roles),
  authRequired: z.boolean().nullable(),
  metricsStatus: z.number().int(),
  anonymousMetricsStatus: z.number().int().nullable(),
  healthStatus: z.number().int().nullable(),
  readyStatus: z.number().int().nullable(),
  familyCount: z.number().int().positive(),
  requiredFamilies: z.array(
    z.strictObject({
      name: z.enum([
        "opengeni_http_requests_total",
        "opengeni_http_request_duration_seconds",
        "opengeni_build_info",
      ]),
      type: z.enum(["counter", "histogram", "gauge"]),
      samples: z.number().int().positive(),
    }),
  ),
});

/** Keep the remote Bun argument quote-free through Azure exec tokenization,
 * and the encoded command below the exec proxy's query-size limit. Operator
 * credentials are read only inside the workload, never injected here. */
export function privateProbeCommand(
  role: Role,
  nonce: string,
  ports = { metrics: role === "api" ? 9464 : 8001, health: 8001 },
): string {
  z.uuid().parse(nonce);
  for (const port of Object.values(ports)) z.number().int().min(1).max(65535).parse(port);
  const settings = JSON.stringify({
    kind,
    role,
    nonce,
    required: requiredFamilies[role],
    ...ports,
  });
  const code = [
    `(async()=>{let[s]=[${settings}];`,
    'let[base]=["http://127.0.0.1:"];let[headers]=[{}];',
    "let[authRequired,anonymousMetricsStatus,healthStatus,readyStatus]=[null,null,null,null];",
    'if(s.role==="api"){let[auth]=[process.env.OPENGENI_AUTH_REQUIRED];if(auth!=="true"&&auth!=="false")throw(Error("unknown-auth"));authRequired=auth==="true";',
    'if(authRequired){let[key]=[process.env.OPENGENI_ACCESS_KEY];if(!key)throw(Error("missing-key"));headers["x-opengeni-access-key"]=key;}',
    'anonymousMetricsStatus=(await(fetch(base+s.metrics+"/metrics",{signal:AbortSignal.timeout(10000)}))).status;}',
    'else{if(process.env.OPENGENI_WORKER_ROLE!==s.role)throw(Error("role-mismatch"));healthStatus=(await(fetch(base+s.health+"/healthz",{signal:AbortSignal.timeout(10000)}))).status;',
    'readyStatus=(await(fetch(base+s.health+"/readyz",{signal:AbortSignal.timeout(10000)}))).status;}',
    'let[m]=[await(fetch(base+s.metrics+"/metrics",{headers,signal:AbortSignal.timeout(10000)}))];',
    "let[text]=[await(m.text())];let[types]=[[...text.matchAll(/#\\x20TYPE\\x20([A-Za-z_:][A-Za-z0-9_:]*)\\x20(\\w+)/g)]];",
    'let[families]=[s.required.map((f)=>({name:f.name,type:types.find((t)=>t[1]===f.name)?.[2]??"missing",',
    'samples:[...text.matchAll(new(RegExp)("^"+f.sample+"(?:\\\\{[^\\\\r\\\\n]*\\\\})?\\\\x20(?:[0-9.+eE-]+|NaN|[+-]?Inf)(?:\\\\x20[0-9]+)?$","gm"))].length}))];',
    "console.log(JSON.stringify({kind:s.kind,nonce:s.nonce,role:s.role,authRequired,metricsStatus:m.status,anonymousMetricsStatus,healthStatus,readyStatus,familyCount:types.length,requiredFamilies:families}));",
    "})().catch(()=>{process.exitCode=1;});",
  ].join("");
  if (/\s/u.test(code)) throw new Error("Private probe code must be one whitespace-free argument");
  const compressed = deflateSync(code).toString("base64url");
  const loader = `await(eval(require(/node:zlib/.source).inflateSync(Buffer.from(/${compressed}/.source,/base64url/.source)).toString()));process.exit(process.exitCode??0)`;
  const execCommand = `bun -e ${loader}`;
  if (/[\s'"]/u.test(loader) || encodeURIComponent(execCommand).length >= 2048) {
    throw new Error("Private probe command exceeds the quote-free exec transport bounds");
  }
  return execCommand;
}

export function privateProbeEvidence(output: string, role: Role, nonce: string) {
  const matches = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        const parsed = Evidence.safeParse(JSON.parse(line.trim()));
        return parsed.success && parsed.data.role === role && parsed.data.nonce === nonce
          ? [parsed.data]
          : [];
      } catch {
        return [];
      }
    });
  const proof = matches.length === 1 ? matches[0] : undefined;
  const expected = requiredFamilies[role];
  if (
    !proof ||
    proof.metricsStatus !== 200 ||
    proof.familyCount < expected.length ||
    proof.requiredFamilies.length !== expected.length ||
    !expected.every((family) =>
      proof.requiredFamilies.some(
        (actual) => actual.name === family.name && actual.type === family.type,
      ),
    ) ||
    (role === "api"
      ? proof.authRequired === null ||
        proof.anonymousMetricsStatus !== (proof.authRequired ? 401 : 200) ||
        proof.healthStatus !== null ||
        proof.readyStatus !== null
      : proof.authRequired !== null ||
        proof.anonymousMetricsStatus !== null ||
        proof.healthStatus !== 200 ||
        proof.readyStatus !== 200)
  ) {
    throw new Error(
      `No valid private observability evidence for ${role}; inspect the workload privately`,
    );
  }
  return proof;
}

function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} read-only observation failed; inspect the result privately`);
  }
  // Arbitrary Azure/Terraform stdout and stderr never become public diagnostics.
  return result.stdout;
}

class PrivatePtyPrerequisiteError extends Error {
  constructor() {
    super(
      "Private ACA observability requires Linux/WSL2 and util-linux script with -q -e -c support",
    );
  }
}

function requirePrivatePty() {
  if (process.platform !== "linux") throw new PrivatePtyPrerequisiteError();
  const version = spawnSync("script", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024,
  });
  if (
    version.error ||
    version.status !== 0 ||
    !/^script from util-linux [0-9]/u.test(version.stdout)
  ) {
    throw new PrivatePtyPrerequisiteError();
  }
}

/** Azure CLI's exec implementation needs terminal stdin even when its output
 * is captured. Quote each local argv element for the known POSIX shell, not
 * the remote Bun code. Never retain a terminal transcript. */
export function privatePtyObservation(program: string, args: string[], timeoutMs = 80_000): string {
  z.number().int().min(1).max(80_000).parse(timeoutMs);
  requirePrivatePty();
  const invocation = [program, ...args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  const result = spawnSync("script", ["-q", "-e", "-c", invocation, "/dev/null"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SHELL: "/bin/sh" },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Private ACA exec transport failed; inspect the result privately");
  }
  return result.stdout;
}

export function inspectPrivateObservability(terraformRoot: string) {
  requirePrivatePty();
  const resourceGroup = z
    .string()
    .regex(/^[A-Za-z0-9_.()-]+$/)
    .parse(
      JSON.parse(
        command("terraform", [`-chdir=${terraformRoot}`, "output", "-json", "resource_group_name"]),
      ),
    );
  const appIds = z
    .object({ api: z.string(), control: z.string(), turn: z.string() })
    .parse(
      JSON.parse(
        command("terraform", [`-chdir=${terraformRoot}`, "output", "-json", "serving_app_ids"]),
      ),
    );
  const results = roles.map((role) => {
    const match = appIds[role].match(
      /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/containerApps\/([a-z][a-z0-9-]*)$/i,
    );
    if (!match || match[2]?.toLowerCase() !== resourceGroup.toLowerCase()) {
      throw new Error(`Invalid Terraform app identity for ${role}`);
    }
    const subscription = z
      .string()
      .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)
      .parse(match[1]);
    const name = match[3]!;
    const containers = z
      .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
      .length(1)
      .parse(
        JSON.parse(
          command("az", [
            "containerapp",
            "show",
            "--ids",
            appIds[role],
            "--query",
            "properties.template.containers[].name",
            "--output",
            "json",
            "--only-show-errors",
          ]),
        ),
      );
    const nonce = crypto.randomUUID();
    const output = privatePtyObservation("az", [
      "containerapp",
      "exec",
      "--name",
      name,
      "--resource-group",
      resourceGroup,
      "--subscription",
      subscription,
      "--container",
      containers[0]!,
      "--command",
      privateProbeCommand(role, nonce),
      "--only-show-errors",
    ]);
    const proof = privateProbeEvidence(output, role, nonce);
    return {
      role,
      status: "passed" as const,
      familyCount: proof.familyCount,
      authRequired: proof.authRequired,
      metricsStatus: proof.metricsStatus,
      anonymousMetricsStatus: proof.anonymousMetricsStatus,
      healthStatus: proof.healthStatus,
      readyStatus: proof.readyStatus,
      requiredFamilies: proof.requiredFamilies,
    };
  });
  return {
    ok: true,
    scope: "Private API/control/turn metrics scrape and worker health/readiness only",
    gaps: [
      "Collector delivery and downstream ingestion of logs, metrics, and traces require separate verification",
    ],
    results,
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--terraform-root" || !args[1]) {
      throw new Error("Use --terraform-root with the initialized native ACA root");
    }
    console.log(JSON.stringify(inspectPrivateObservability(args[1]), null, 2));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        detail:
          error instanceof PrivatePtyPrerequisiteError
            ? error.message
            : "Private ACA observability could not be verified; inspect workload/CLI access privately",
      }),
    );
    process.exitCode = 1;
  }
}
