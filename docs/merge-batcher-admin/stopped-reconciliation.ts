/** Read-only settlement; no transport mutation, claim reset or controller invocation. */
export interface StoppedProof {
  outcome: "stable-state-observed";
  stateSha: string;
  mainSha: string;
  candidateRefs: { ref: string; sha: string }[];
  effects: number;
}
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
export function settledEffect(e: any): boolean {
  // These REST effects cannot move main/state/candidate refs. Preserve their
  // original status and uncertainty, but they do not block exact Manual after
  // genuine writer drain and stable ref/state proof. Never replay them here.
  return object(e) && ["rerun", "comment", "followup", "disable-auto-merge"].includes(e.kind);
}
export async function reconcileStopped(
  mode: string,
  expectedState: string,
  get: (path: string) => Promise<any>,
): Promise<StoppedProof> {
  if (!["active", "ci-shadow", "read-only"].includes(mode) || !sha(expectedState))
    throw Error("Invalid stopped reconciliation scope");
  const active = mode === "active",
    stateRef = active ? "batcher-state" : "batcher-shadow-traffic-state";
  const prefix = active ? "queue/live/" : "queue/shadow-traffic/";
  async function snapshot() {
    const state = await get(`git/ref/heads/${stateRef}`),
      main = await get("git/ref/heads/main"),
      refs = await get(`git/matching-refs/heads/${prefix}`);
    if (
      state?.object?.sha !== expectedState ||
      !sha(main?.object?.sha) ||
      !Array.isArray(refs) ||
      refs.length > 10000
    )
      throw Error("Incomplete stopped snapshot");
    const candidates = refs
      .map((r: any) => {
        if (
          typeof r.ref !== "string" ||
          !r.ref.startsWith(`refs/heads/${prefix}`) ||
          !/^[a-f0-9]{64}$/.test(r.ref.slice(`refs/heads/${prefix}`.length)) ||
          !sha(r.object?.sha)
        )
          throw Error("Invalid stopped candidate ref");
        return { ref: r.ref, sha: r.object.sha as string };
      })
      .sort((a, b) => a.ref.localeCompare(b.ref));
    if (new Set(candidates.map((r) => r.ref)).size !== candidates.length)
      throw Error("Duplicate ref");
    return {
      stateSha: expectedState,
      mainSha: main.object.sha as string,
      candidateRefs: candidates,
    };
  }
  const before = await snapshot();
  // Git blobs avoid the Contents API's 1MiB base64 response limit.
  const commit = await get(`git/commits/${expectedState}`);
  if (!sha(commit?.tree?.sha)) throw Error("Missing state commit tree");
  const tree = await get(`git/trees/${commit.tree.sha}`);
  const entries = tree?.tree;
  if (tree?.truncated || !Array.isArray(entries)) throw Error("Incomplete state tree");
  const stateFiles = entries.filter((entry: any) => entry.path === "state.json");
  if (stateFiles.length !== 1 || stateFiles[0].type !== "blob" || !sha(stateFiles[0].sha))
    throw Error("Missing state blob");
  const content = await get(`git/blobs/${stateFiles[0].sha}`);
  if (
    content?.encoding !== "base64" ||
    typeof content.content !== "string" ||
    content.content.length > 22000000
  )
    throw Error("Invalid bounded state content");
  const text = Buffer.from(content.content.replaceAll("\n", ""), "base64").toString("utf8");
  if (text.length > 16000000) throw Error("State exceeds bound");
  const state = JSON.parse(text);
  if (
    !object(state) ||
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.epoch) ||
    !Array.isArray(state.landed) ||
    !Array.isArray(state.invalidated) ||
    !object(state.effects)
  )
    throw Error("Unsupported state ledger");
  const effects = Object.values(state.effects);
  if (effects.length > 10000 || effects.some((e) => !settledEffect(e)))
    throw Error("Unresolved durable effect");
  if (!active) {
    const traffic = state.trafficShadow;
    if (
      !object(traffic) ||
      traffic.kind !== "merged-traffic-shadow" ||
      !object(traffic.records ?? {}) ||
      !object(traffic.settled ?? {})
    )
      throw Error("Missing traffic ledger");
    const tips = new Map<string, string>();
    for (const [id, record] of Object.entries(traffic.records ?? {}) as [string, any][]) {
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        !sha(record?.tipSha) ||
        !["pending", "terminal", "blocked", "recovered"].includes(record.status)
      )
        throw Error("Invalid publication record");
      tips.set(id, record.tipSha);
    }
    for (const [id, tip] of Object.entries(traffic.settled ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(id) || !sha(tip) || (tips.has(id) && tips.get(id) !== tip))
        throw Error("Conflicting settled tip");
      tips.set(id, tip);
    }
    if (
      before.candidateRefs.length !== tips.size ||
      before.candidateRefs.some(
        (r) => tips.get(r.ref.slice(`refs/heads/${prefix}`.length)) !== r.sha,
      )
    )
      throw Error("Publication state/ref disagreement");
  }
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("Stopped snapshot changed");
  return { outcome: "stable-state-observed", ...after, effects: effects.length };
}
