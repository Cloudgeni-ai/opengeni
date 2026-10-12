import { z } from "zod";
import { NativeBrokerArtifactPinSchema } from "./native-command-broker-bootstrap";

const planSchema = z
  .object({
    version: z.literal(1),
    brokerId: z.uuid().regex(/^[a-f0-9-]+$/),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    imageId: z.string().regex(/^im-[A-Za-z0-9_-]{1,200}$/),
    artifact: NativeBrokerArtifactPinSchema,
  })
  .strict();

/** Internal creation recipe, never qualification or user command authority.
 * The caller must independently select its release pin and frozen cohort, then
 * persist the exact plan with physical-create admission before dispatch. */
export type ModalNativeBrokerCreatePlan = Readonly<
  Omit<z.infer<typeof planSchema>, "artifact"> & {
    artifact: Readonly<z.infer<typeof NativeBrokerArtifactPinSchema>>;
  }
>;

export function parseModalNativeBrokerCreatePlan(input: unknown): ModalNativeBrokerCreatePlan {
  const plan = planSchema.parse(input);
  return Object.freeze({ ...plan, artifact: Object.freeze(plan.artifact) });
}

export function modalNativeBrokerInitialCommand(plan: ModalNativeBrokerCreatePlan): string[] {
  // No user argv, shell, PATH lookup, provider TaskExec or restored guest path.
  return ["/usr/local/bin/opengeni-command-supervisor", "broker", "--broker-id", plan.brokerId];
}

type Intent = Readonly<{
  operationId: string;
  imageId: string;
  requestSha256: string;
}>;
type Proof = Readonly<{
  plan: ModalNativeBrokerCreatePlan;
  operationId: string;
  requestSha256: string;
  /** This describes the selected wire request, not authenticated bootstrap. */
  commandAdmission: false;
}>;
const issued = new WeakMap<object, Proof>();

/** Called only at the existing physical SandboxCreate middleware boundary.
 * Verifies the pinned SDK's actual command/workdir/image envelope before the
 * existing persisted admission callback. A copied intent has no issuance. */
export function bindModalNativeBrokerCreate(
  intent: Intent,
  definition: Readonly<Record<string, unknown>>,
  selected: ModalNativeBrokerCreatePlan,
): void {
  const plan = parseModalNativeBrokerCreatePlan(selected);
  const expected = modalNativeBrokerInitialCommand(plan);
  const args = definition.entrypointArgs;
  if (
    definition.imageId !== plan.imageId ||
    intent.imageId !== plan.imageId ||
    definition.workdir !== "/" ||
    !Array.isArray(args) ||
    args.length !== expected.length ||
    args.some((value, index) => value !== expected[index]) ||
    // Initial stdout is the framed protocol, never a PTY or readiness exec.
    definition.ptyInfo != null ||
    definition.readinessProbe != null ||
    // Mount provenance is not part of this initial image-only recipe. Even a
    // read-only guest mount can shadow the selected executable before boot.
    (definition.volumeMounts != null &&
      (!Array.isArray(definition.volumeMounts) || definition.volumeMounts.length !== 0)) ||
    (definition.cloudBucketMounts != null &&
      (!Array.isArray(definition.cloudBucketMounts) || definition.cloudBucketMounts.length !== 0))
  )
    throw new Error("Modal native broker creation disagrees with its selected initial process");
  issued.set(
    intent,
    Object.freeze({
      plan,
      operationId: intent.operationId,
      requestSha256: intent.requestSha256,
      commandAdmission: false,
    }),
  );
}

/** Receipt identity remains tied to the same pre-dispatch wire proof. */
export function retainModalNativeBrokerCreateReceipt(intent: Intent, receipt: Intent): void {
  const proof = issued.get(intent);
  if (!proof) return;
  if (
    receipt.operationId !== proof.operationId ||
    receipt.imageId !== proof.plan.imageId ||
    receipt.requestSha256 !== proof.requestSha256
  )
    throw new Error("Modal native broker receipt changed its creation identity");
  issued.set(receipt, proof);
}

export function readModalNativeBrokerCreate(intent: Intent): Proof | undefined {
  return issued.get(intent);
}
