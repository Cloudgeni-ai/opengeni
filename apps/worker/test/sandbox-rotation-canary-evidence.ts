/** Pure acceptance checks shared by the opt-in provider harness and cheap unit tests. */
export function requireCanary(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Sandbox rotation canary: ${message}`);
}

/** Only non-secret descriptor identity may enter canary output. The nonce is a
 * control capability, not evidence to print. This test assertion intentionally
 * works before/after parent integration of the new contract export. */
export function assertSupervisedCanaryCommand(value: unknown): {
  protocol: "native-subreaper-v1";
  invocationId: string;
} {
  requireCanary(value && typeof value === "object", "retained provider command is missing");
  const command = value as Record<string, unknown>;
  requireCanary(
    command.kind === "modal-router-v1" && command.pty !== true,
    "canary requires the stock Modal nonTTY router protocol",
  );
  const supervision = command.supervision;
  requireCanary(
    supervision && typeof supervision === "object",
    "retained command has no supervision descriptor",
  );
  const descriptor = supervision as Record<string, unknown>;
  requireCanary(
    descriptor.protocol === "native-subreaper-v1",
    "wrong command supervision protocol",
  );
  requireCanary(
    typeof descriptor.invocationId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        descriptor.invocationId,
      ),
    "missing durable supervision invocation identity",
  );
  requireCanary(
    typeof descriptor.nonce === "string" && /^[a-f0-9]{64}$/.test(descriptor.nonce),
    "missing supervision control capability",
  );
  requireCanary(
    typeof descriptor.controlPath === "string" &&
      /^\/tmp\/opengeni-supervision\/[a-f0-9-]{36}\.sock$/.test(descriptor.controlPath),
    "invalid supervisor control endpoint",
  );
  return { protocol: "native-subreaper-v1", invocationId: descriptor.invocationId };
}

export function canaryConfiguration(env: Record<string, string | undefined>) {
  requireCanary(env.OPENGENI_SANDBOX_ROTATION_CANARY === "1", "explicit live opt-in is required");
  requireCanary(
    env.OPENGENI_SANDBOX_ROTATION_CANARY_AUTHORIZATION === "ISOLATED_MODAL_CANARY_ONLY",
    "isolated provider authorization is required",
  );
  const sourceSha = env.OPENGENI_SANDBOX_ROTATION_SOURCE_SHA ?? "";
  const image = env.OPENGENI_SANDBOX_ROTATION_IMAGE_REF ?? "";
  const environment = env.OPENGENI_SANDBOX_ROTATION_MODAL_ENVIRONMENT ?? "";
  requireCanary(/^[a-f0-9]{40}$/.test(sourceSha), "pin the integrated source SHA");
  requireCanary(
    /^ghcr\.io\/cloudgeni-ai\/opengeni-sandbox@sha256:[a-f0-9]{64}$/.test(image),
    "pin the canonical GHCR sandbox image digest",
  );
  requireCanary(
    /^sandbox-rotation-canary-[a-z0-9-]{8,48}$/.test(environment),
    "use a pre-provisioned dedicated sandbox-rotation-canary-* Modal environment",
  );
  requireCanary(
    !env.OPENGENI_TEST_POSTGRES_ADMIN_URL && !env.OPENGENI_TEST_POSTGRES_APP_URL,
    "external database overrides are forbidden; use the isolated native PG17 fixture",
  );
  requireCanary(
    env.OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES === "LOCAL_DISPOSABLE_55434",
    "native database opt-in must name LOCAL_DISPOSABLE_55434; Docker fallback is disabled",
  );
  requireCanary(
    env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET,
    "explicit Modal credentials are required",
  );
  return { sourceSha, image, environment };
}

export type RotationEvidence = {
  cycle: number;
  predecessor: string;
  successor: string;
  predecessorEpoch: number;
  successorEpoch: number;
  providerCreatedAt: number;
  providerDeadlineAt: number;
  rotationRequestedAt: number;
  rotationReason: string | null;
  completedAt: number;
  rotationLeadMs: number;
  processState: string;
  processProof: string | null;
  processSettledAt: number;
  remainingProcessHolders: number;
  baselineGeneration: number;
  writtenGeneration: number;
  publishedGeneration: number;
  checkpointArtifactId: string | null;
  checkpointVerified: boolean;
  checkpointCapturedAt: number;
  captureReleased: boolean;
  expectedHashes: Record<string, string>;
  restoredHashes: Record<string, string>;
};

export function assertRotationEvidence(e: RotationEvidence): void {
  requireCanary(e.cycle === 1 || e.cycle === 2, "unexpected rotation ordinal");
  for (const [name, value] of Object.entries(e)) {
    if (typeof value === "number") requireCanary(Number.isFinite(value), `invalid ${name}`);
  }
  requireCanary(
    e.predecessor && e.successor && e.predecessor !== e.successor,
    "physical instance did not change",
  );
  requireCanary(e.successorEpoch > e.predecessorEpoch, "lease epoch did not advance");
  requireCanary(
    e.rotationReason === "provider_deadline",
    "rotation was not a natural provider deadline",
  );
  requireCanary(e.providerDeadlineAt > e.providerCreatedAt, "invalid provider creation clock");
  requireCanary(
    e.rotationLeadMs > 0 && e.rotationLeadMs < e.providerDeadlineAt - e.providerCreatedAt,
    "invalid rotation lead",
  );
  requireCanary(
    e.rotationRequestedAt >= e.providerDeadlineAt - e.rotationLeadMs,
    "rotation was forced early",
  );
  requireCanary(
    e.completedAt < e.providerDeadlineAt,
    "hard expiry substituted for orderly rotation",
  );
  requireCanary(
    e.processState === "exited" && e.processProof === "exited",
    "retained process lacks positive exit proof (loss is not success)",
  );
  requireCanary(
    e.processSettledAt >= e.rotationRequestedAt,
    "server was settled before deadline admission",
  );
  requireCanary(e.remainingProcessHolders === 0, "retained-process holder remains");
  requireCanary(
    e.writtenGeneration > e.baselineGeneration,
    "no write after the preceding checkpoint",
  );
  requireCanary(e.publishedGeneration >= e.writtenGeneration, "checkpoint omitted later writes");
  requireCanary(
    e.checkpointArtifactId && e.checkpointVerified,
    "checkpoint publication is unverified",
  );
  requireCanary(
    e.checkpointCapturedAt >= e.processSettledAt,
    "checkpoint predates writer settlement",
  );
  requireCanary(e.captureReleased, "capture admission remains held");
  requireCanary(
    Object.keys(e.expectedHashes).length >= e.cycle + 1,
    "marker evidence is incomplete",
  );
  for (const [path, hash] of Object.entries(e.expectedHashes)) {
    requireCanary(/^[a-f0-9]{64}$/.test(hash), "invalid expected hash");
    requireCanary(e.restoredHashes[path] === hash, `restored marker mismatch: ${path}`);
  }
}
