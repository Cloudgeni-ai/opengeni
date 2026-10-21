import { compareText, digest, SHA, type Pull, type ReadyBinding } from "./model";
export interface Comment {
  id: string;
  body: unknown;
  updatedAt: string;
  authorAssociation: string;
}
export interface ReadyEvent {
  id: string;
  at: string;
  source: ReadyBinding["source"];
  enabled: boolean;
}
export interface PullInput {
  number: number;
  headSha: string;
  headRef: string;
  draft: boolean;
  autoMerge: boolean;
  queueReady: boolean;
  events: ReadyEvent[];
  comments: Comment[];
  controlPlane?: boolean;
}
export type Admission = { ready: Pull; reason: null } | { ready: null; reason: string };
// Human prose is an attestation, never executable instructions. No formal approval required.
export function admit(input: PullInput): Admission {
  const no = (reason: string): Admission => ({ ready: null, reason });
  if (!SHA.test(input.headSha)) return no("invalid exact head");
  if (input.draft) return no("draft");
  if (!input.autoMerge && !input.queueReady) return no("no ready signal");
  const events = [...input.events]
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || compareText(a.id, b.id));
  const active = new Map<ReadyBinding["source"], ReadyEvent>();
  for (const e of events) {
    if (!e.enabled) active.delete(e.source);
    else if (!active.has(e.source)) active.set(e.source, e);
  }
  const event = [...active.values()]
    .filter((e) => (e.source === "auto-merge" ? input.autoMerge : input.queueReady))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || compareText(a.id, b.id))[0];
  if (!event) return no("missing actual ready-event timestamp (not PR creation time)");
  for (const comment of [...input.comments].sort(
    (a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || compareText(b.id, a.id),
  )) {
    if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.authorAssociation)) continue;
    if (typeof comment.body !== "string") continue;
    const text = comment.body;
    // Our status/ejection receipts quote SHAs but are not VM/review attestations.
    // In PAT mode their author can be MEMBER; do not revoke a human's evidence
    // merely by posting the promised changed-head reconciliation comment.
    if (
      /^(?:Merge batcher (?:landed|excluded)|Tested snapshot)\b/.test(text) &&
      /<!-- batcher-effect:[a-f0-9]{64} -->/.test(text)
    )
      continue;
    if (
      !(text.match(/\b[a-f0-9]{40}\b/gi) ?? []).some((sha) => sha.toLowerCase() === input.headSha)
    )
      continue;
    // The newest collaborator statement about this exact head is authoritative:
    // an incomplete or negative update revokes an older passing attestation.
    if (text.length > 100_000) return no("latest exact-head evidence is oversized");
    const vm = /\bVM\b|virtual machine|connected machine/i.test(text);
    const tests =
      /\b(test|tests|suite|suites|typecheck)\b/i.test(text) &&
      /\b(pass|passed|green|successful|success)\b/i.test(text);
    const review = /independent[\s-]+(?:agent[\s-]+)?review|reviewer[\s-]+session/i.test(text);
    const reviewer = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text);
    const negative =
      /\b(?:not|never|no)\s+(?:yet\s+)?(?:passed|green|reviewed|tested)|\b(?:pending|awaiting)\s+(?:independent\s+)?review|\b(?:tests?|suites?)\s+(?:failed|failing)/i.test(
        text,
      ) ||
      /\breview\s*(?::|[-–—])?\s*(?:(?:is|was|has|still)\s+)*(?:failed|failing|pending|incomplete|blocked|awaiting|did\s+not\s+pass|didn't\s+pass|not\s+(?:yet\s+)?(?:passed|complete|completed|done|successful))\b|\b(?:failed|failing|pending|incomplete|blocked|awaiting|did\s+not\s+pass|didn't\s+pass|not\s+(?:yet\s+)?(?:passed|completed?))\s+(?:the\s+)?(?:independent[\s-]+)?(?:agent[\s-]+)?review\b/i.test(
        text,
      );
    if (
      vm &&
      tests &&
      review &&
      reviewer &&
      !negative &&
      (!input.controlPlane || /control[ -]plane/i.test(text))
    )
      return {
        reason: null,
        ready: {
          number: input.number,
          headSha: input.headSha,
          headRef: input.headRef,
          ...(input.controlPlane ? { controlPlane: true } : {}),
          binding: {
            eventId: event.id,
            at: event.at,
            source: event.source,
            evidenceId: comment.id,
            evidenceDigest: digest({
              body: text,
              updatedAt: comment.updatedAt,
              authorAssociation: comment.authorAssociation,
            }),
          },
        },
      };
    return no(
      input.controlPlane
        ? "latest exact-head evidence lacks passing VM/independent control-plane review"
        : "latest exact-head evidence is incomplete or negative; earlier pass revoked",
    );
  }
  return no(
    input.controlPlane
      ? "missing explicit control-plane review in exact-head VM/independent-review evidence"
      : "missing exact-head VM test and independent-review evidence comment from a repository collaborator",
  );
}
