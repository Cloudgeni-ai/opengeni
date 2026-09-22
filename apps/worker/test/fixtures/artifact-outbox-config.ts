import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// Isolated process: no mock can change another test's production imports.
let composition: Record<string, unknown> | undefined;
mock.module("../../src/editable-artifact-outbox-dispatcher", () => ({
  EDITABLE_ARTIFACT_OUTBOX_DATABASE_URL_ENV: "OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL",
  EDITABLE_ARTIFACT_OUTBOX_DISPATCHER_DATABASE_ROLE: "opengeni_artifact_outbox_dispatcher",
  createEditableArtifactOutboxWorker: async (options: Record<string, unknown>) => {
    composition = options;
    return {
      start: async () => {},
      drain: () => true,
      stop: async () => {},
      check: async () => {},
      dispatcher: { dispatchOnce: async () => ({}) },
    };
  },
}));
const { createOutboxSidecarFromEnvironment } = await import("../../src/editable-artifact-outbox-service");
const environment = {
  OPENGENI_ENVIRONMENT: "production",
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_SANDBOX_BACKEND: "modal",
  OPENGENI_ARTIFACT_OUTBOX_ENABLED: "true",
  OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE: "opengeni_artifact_outbox_dispatcher",
  OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL: "postgres://opengeni_artifact_outbox_dispatcher:fixture@db.example.test/outbox",
  OPENGENI_DB_SCHEMA: "artifact_test",
  OPENGENI_NATS_URL: "nats://broker.example.test:4222",
  OPENGENI_SELFHOSTED_NATS_CONTROL_USER: "outbox",
  OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD: "synthetic-password",
};
const result = await createOutboxSidecarFromEnvironment(environment);
assert(result);
assert(composition);
assert.equal(composition.dispatcherDatabaseUrl, environment.OPENGENI_ARTIFACT_OUTBOX_DATABASE_URL);
assert.equal(composition.databaseSearchPath, "artifact_test,opengeni_private,public");
assert.equal(composition.natsUrl, environment.OPENGENI_NATS_URL);
assert.deepEqual(composition.natsAuth, { kind: "user-password", user: "outbox", pass: "synthetic-password" });
assert.equal(result.service.state(), "starting");
await result.service.close();
console.log("explicit sidecar environment composed without API or sandbox secrets");