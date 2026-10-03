import { expect, test } from "bun:test";
import { createObservability } from "../src";

type Resource = { attributes: Array<{ key: string; value: { stringValue: string } }> };
type Payload = {
  resourceSpans?: Array<{ resource: Resource }>;
  resourceLogs?: Array<{ resource: Resource }>;
};

const settings = {
  serviceName: "test-service",
  environment: "test",
  deploymentRevision: "a".repeat(40),
  observabilityStructuredLogs: false,
  observabilityMetricsEnabled: false,
  observabilityOtlpEndpoint: "http://collector.invalid",
  observabilityOtlpHeaders: "",
  observabilityDiagnosticsEndpoint: "http://restricted.invalid",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attributes(resource: Resource) {
  return Object.fromEntries(resource.attributes.map(({ key, value }) => [key, value.stringValue]));
}

async function observe(deploymentRevision: string | undefined) {
  const exports: Payload[] = [];
  const observer = createObservability(
    { ...settings, deploymentRevision },
    {
      component: "api",
      exporter: async (_url, body) => {
        exports.push(body as Payload);
      },
    },
  );
  observer
    .startSpan("resource-test", {
      "service.instance.id": "CALLER_CONTROLLED_INSTANCE",
      "opengeni.deployment_revision": "CALLER_CONTROLLED_REVISION",
    })
    .end();
  observer.recordFailureDiagnostic({
    code: "api_uncaught_exception",
    stage: "running",
    error: new Error("synthetic resource identity test"),
  });
  await observer.flush();
  const trace = exports.find((body) => body.resourceSpans)?.resourceSpans?.[0]?.resource;
  const diagnostic = exports.find((body) => body.resourceLogs)?.resourceLogs?.[0]?.resource;
  expect(trace).toBeDefined();
  expect(diagnostic).toBeDefined();
  expect(JSON.stringify(exports)).not.toContain("CALLER_CONTROLLED");
  return { trace: attributes(trace!), diagnostic: attributes(diagnostic!) };
}

test("traces and protected diagnostics share configured revision and opaque process identity", async () => {
  const first = await observe(settings.deploymentRevision);
  const second = await observe("rollout-b");
  expect(first.trace).toMatchObject({
    "service.name": "test-service",
    "deployment.environment": "test",
    "opengeni.component": "api",
    "opengeni.deployment_revision": settings.deploymentRevision,
  });
  expect(first.trace["service.instance.id"]).toMatch(uuid);
  expect(first.diagnostic).toEqual(first.trace);
  expect(second.trace["service.instance.id"]).toBe(first.trace["service.instance.id"]);
  expect(second.trace["opengeni.deployment_revision"]).toBe("rollout-b");
  expect(second.diagnostic).toEqual(second.trace);
  // A configured deployment label is not an independently attested binary version.
  expect(first.trace).not.toHaveProperty("service.version");
});

for (const revision of [undefined, ""]) {
  test(`an unconfigured revision (${String(revision)}) is absent rather than fabricated`, async () => {
    const observed = await observe(revision);
    expect(observed.trace).not.toHaveProperty("opengeni.deployment_revision");
    expect(observed.diagnostic).not.toHaveProperty("opengeni.deployment_revision");
    expect(observed.trace["service.instance.id"]).toMatch(uuid);
  });
}

test("separate runtime processes do not share an instance identity", async () => {
  const source = new URL("../src/index.ts", import.meta.url).href;
  const code = `
    import { createObservability } from ${JSON.stringify(source)};
    const observer = createObservability(${JSON.stringify(settings)}, {
      component: "api",
      exporter: async (_url, body) => {
        process.stdout.write(JSON.stringify(body.resourceSpans[0].resource));
      },
    });
    observer.startSpan("process-identity").end();
    await observer.flush();
  `;
  const results: string[] = [];
  for (let index = 0; index < 2; index++) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [text, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    const identity = attributes(JSON.parse(text) as Resource)["service.instance.id"]!;
    expect(identity).toMatch(uuid);
    results.push(identity);
  }
  expect(results[0]).not.toBe(results[1]);
});
