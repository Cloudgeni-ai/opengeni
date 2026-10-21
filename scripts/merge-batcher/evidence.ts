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
  for (const comment of [...input.comments].reverse()) {
    if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.authorAssociation)) continue;
    if (typeof comment.body !== "string" || comment.body.length > 100_000) continue;
    const text = comment.body;
    if (
      !(text.match(/\b[a-f0-9]{40}\b/gi) ?? []).some((sha) => sha.toLowerCase() === input.headSha)
    )
      continue;
    const vm = /\bVM\b|virtual machine|connected machine/i.test(text);
    const tests =
      /\b(test|tests|suite|suites|typecheck)\b/i.test(text) &&
      /\b(pass|passed|green|successful|success)\b/i.test(text);
    const review = /independent[\s-]+(?:agent[\s-]+)?review|reviewer[\s-]+session/i.test(text);
    const reviewer = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text);
    const negative =
      /\b(?:not|never|no)\s+(?:yet\s+)?(?:passed|green|reviewed|tested)|\b(?:pending|awaiting)\s+(?:independent\s+)?review|\b(?:tests?|suites?)\s+(?:failed|failing)/i.test(
        text,
      );
    if (vm && tests && review && reviewer && !negative)
      return {
        reason: null,
        ready: {
          number: input.number,
          headSha: input.headSha,
          headRef: input.headRef,
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
  }
  return no(
    "missing exact-head VM test and independent-review evidence comment from a repository collaborator",
  );
}
