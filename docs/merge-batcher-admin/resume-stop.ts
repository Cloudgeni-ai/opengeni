import { reconcileStopped } from "./stopped-reconciliation";
/** Prove the existing STOP again using GETs only. Never issue STOP/START or save over its receipt. */
export async function reconcileRetainedStop(
  original: any,
  receipt: any,
  target: any,
  service: string,
  controlSecret: string,
  api: (url: string) => Promise<any>,
  get: (path: string) => Promise<any>,
) {
  const w = original?.drainWitness;
  if (
    original?.command !== "stop" ||
    !original.disabled ||
    !original.manualZero ||
    !original.stopPersisted ||
    original.forced ||
    original.taggedRevisionsMayRemain ||
    !original.drainProven ||
    !w ||
    w.uid !== target.uid ||
    JSON.stringify(w) !== JSON.stringify(receipt.drainWitness) ||
    original.writer?.state !== "stopped" ||
    original.writer.instance !== w.instance ||
    original.writer.control?.generation !== w.controlGeneration ||
    original.writer.writerActive !== false ||
    original.writer.writerPid !== null ||
    original.writer.unprovenWriterPid ||
    original.stateBefore !== original.stateAfter
  )
    throw Error("No exact retained drain; no STOP replay");
  if (!/^[a-z0-9-]+$/.test(service) || !/^[a-z0-9-]+$/.test(controlSecret))
    throw Error("Invalid pinned control scope");
  async function current() {
    const live = await api(
      `https://run.googleapis.com/v2/projects/cloudgeni-gecko/locations/europe-west1/services/${service}`,
    );
    const secret = await api(
      `https://secretmanager.googleapis.com/v1/projects/511938371043/secrets/${controlSecret}/versions/latest:access`,
    );
    const control = JSON.parse(Buffer.from(secret.payload.data, "base64").toString());
    if (
      live.uid !== target.uid ||
      live.uri !== target.uri ||
      live.template?.containers?.[0]?.image !== target.image ||
      String(live.generation) !== String(w.generation) ||
      String(live.observedGeneration) !== String(w.generation) ||
      live.reconciling ||
      live.scaling?.scalingMode !== "MANUAL" ||
      live.scaling.manualInstanceCount !== 0 ||
      control.state !== "stopped" ||
      control.generation !== w.controlGeneration ||
      !Array.isArray(live.traffic) ||
      live.traffic.length !== 1 ||
      live.traffic[0].type !== "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" ||
      live.traffic[0].percent !== 100 ||
      live.traffic[0].tag
    )
      throw Error("Stopped binding/control changed");
    return { generation: live.generation, etag: live.etag, control: secret.name };
  }
  const before = await current();
  const proof = await reconcileStopped(w.mode, original.stateBefore, get);
  if (JSON.stringify(before) !== JSON.stringify(await current()))
    throw Error("Stopped identity moved");
  return {
    result: {
      ...original,
      outcome: "reconciled-disabled",
      priorDrainProof: false,
      stoppedReconciliation: proof,
    },
    receipt: {
      ...receipt,
      stoppedReconciliation: { uid: w.uid, generation: w.generation, mode: w.mode, proof },
    },
    originalOutcome: original.outcome,
  };
}
