import { expect, test } from "bun:test";
import { createObservability } from "../src";

test("structured logs keep database credential event attributes within their grammars", () => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => lines.push(line);
  try {
    const observability = createObservability(
      { observabilityStructuredLogs: true, serviceName: "opengeni", environment: "test" } as never,
      { component: "worker" },
    );
    observability.warn("switched database credential candidate", {
      databasePool: "worker-activities-notifications",
      credentialFromIndex: 0,
      credentialToIndex: 1,
      credentialCandidates: 2,
    });
    observability.warn("database credential candidate refused", {
      databasePool: "worker",
      credentialIndex: 1,
      credentialCandidates: 2,
      credentialStale: true,
    });
    observability.warn("database password file unreadable; treating it as missing", {
      databasePool: "api",
      credentialFile: "previous",
      credentialFileErrorCode: "EACCES",
    });
    // Anything outside the grammars is dropped, never published.
    observability.warn("database credential candidate refused", {
      databasePool: "postgres://user:secret@db/x",
      credentialFile: "/var/run/secrets/db/password",
      credentialFileErrorCode: "secret value",
    });
  } finally {
    console.warn = original;
  }
  const [switched, refused, unreadable, rejected] = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(switched).toMatchObject({
    databasePool: "worker-activities-notifications",
    credentialFromIndex: 0,
    credentialToIndex: 1,
    credentialCandidates: 2,
  });
  expect(refused).toMatchObject({
    databasePool: "worker",
    credentialIndex: 1,
    credentialCandidates: 2,
    credentialStale: true,
  });
  expect(unreadable).toMatchObject({
    databasePool: "api",
    credentialFile: "previous",
    credentialFileErrorCode: "EACCES",
  });
  expect(rejected).not.toHaveProperty("databasePool");
  expect(rejected).not.toHaveProperty("credentialFile");
  expect(rejected).not.toHaveProperty("credentialFileErrorCode");
});
