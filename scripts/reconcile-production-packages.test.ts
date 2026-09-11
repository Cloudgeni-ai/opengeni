import { expect, test } from "bun:test";
import { candidatePackages, deployedSource, reconcile } from "./reconcile-production-packages";

const sha = "a".repeat(40);
test("registry outages fail visibly rather than dispatching or declaring success", async () => {
  const request = (async (url: string) =>
    url.endsWith("/healthz")
      ? Response.json({ ok: true, service: "opengeni", deploymentRevision: sha })
      : new Response("unavailable", { status: 503 })) as typeof fetch;
  const gh = (...args: string[]) => {
    expect(args[0]).toBe("release");
    return JSON.stringify({
      schemaVersion: 2,
      sourceSha: sha,
      packages: [{ name: "@opengeni/sdk", version: "5.0.3" }],
    });
  };
  await expect(reconcile(gh, request)).rejects.toThrow("Registry probe failed: HTTP 503");
});
test("requires a healthy exact production revision", () => {
  expect(deployedSource({ ok: true, service: "opengeni", deploymentRevision: sha })).toBe(sha);
  for (const value of [
    null,
    {},
    { ok: false },
    { ok: true, service: "opengeni", deploymentRevision: "main" },
  ]) {
    expect(() => deployedSource(value)).toThrow();
  }
});

test("retries failed publication, avoids active duplicates, and stops when available", async () => {
  for (const [registryStatus, status, shouldDispatch] of [
    [404, "completed", true],
    [404, "in_progress", false],
    [200, "completed", false],
  ] as const) {
    const calls: string[][] = [];
    const gh = (...args: string[]) => {
      calls.push(args);
      if (args[0] === "release")
        return JSON.stringify({
          schemaVersion: 2,
          sourceSha: sha,
          packages: [{ name: "@opengeni/sdk", version: "5.0.3" }],
        });
      if (args[0] === "api")
        return JSON.stringify({
          workflow_runs: [
            { display_title: `publish-packages:${sha}`, status, conclusion: "failure" },
          ],
        });
      return "";
    };
    const request = (async (url: string) =>
      url.endsWith("/healthz")
        ? Response.json({ ok: true, service: "opengeni", deploymentRevision: sha })
        : new Response("{}", { status: registryStatus })) as typeof fetch;
    await reconcile(gh, request);
    const dispatch = calls.find((args) => args[0] === "workflow");
    expect(Boolean(dispatch)).toBe(shouldDispatch);
    if (dispatch) {
      expect(dispatch).toContain(`source_sha=${sha}`);
      expect(dispatch).toContain("expected_packages=@opengeni/sdk@5.0.3");
    }
  }
});
test("publication uses immutable candidate versions, not latest tags", () => {
  const candidate = {
    schemaVersion: 2,
    sourceSha: sha,
    packages: [{ name: "@opengeni/sdk", version: "5.0.3" }],
  };
  expect(candidatePackages(candidate, sha)).toEqual(["@opengeni/sdk@5.0.3"]);
  expect(() => candidatePackages(candidate, "b".repeat(40))).toThrow();
  for (const version of ["latest", "5.0.3-canary.0", "^5.0.3"]) {
    expect(() =>
      candidatePackages({ ...candidate, packages: [{ name: "@opengeni/sdk", version }] }, sha),
    ).toThrow();
  }
  expect(() =>
    candidatePackages(
      { ...candidate, packages: [...candidate.packages, ...candidate.packages] },
      sha,
    ),
  ).toThrow();
});
