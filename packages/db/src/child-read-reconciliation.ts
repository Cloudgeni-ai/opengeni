import { isDeepStrictEqual } from "node:util";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;

/** Historical tool output is a potentially lossy audit lane. Accept only known
 * complete envelopes, then compare each returned item with its retained source.
 * Tool names, cursors and terminal status are never content evidence alone. */
export function historicalChildReadItems(
  name: unknown,
  argsValue: unknown,
  outputValue: unknown,
): Array<{ sessionId: string; item: RecordValue; view: string }> {
  const decode = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    if (Buffer.byteLength(value) > 256 * 1024) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  const args = record(decode(argsValue));
  let output = decode(outputValue);
  const envelope = record(output);
  if (envelope?.isError === true) return [];
  const content = envelope?.content ?? (Array.isArray(output) ? output : null);
  if (content !== null) {
    if (!Array.isArray(content) || content.length !== 1) return [];
    const text = record(content[0]);
    if (text?.type !== "text") return [];
    output = decode(text.text);
  }
  const page = record(output);
  if (
    !args ||
    !page ||
    page.truncated === true ||
    record(page.truncation)?.truncated === true ||
    page.sourceExact === false
  )
    return [];
  if (name === "opengeni__session_wait") {
    if (page.aborted === true || !Array.isArray(page.changed) || !Array.isArray(args.targets))
      return [];
    const targets = new Set(args.targets.map((target) => record(target)?.sessionId));
    return page.changed.flatMap((value) => {
      const target = record(value);
      if (
        !target ||
        typeof target.sessionId !== "string" ||
        !targets.has(target.sessionId) ||
        !Array.isArray(target.events)
      )
        return [];
      return target.events.flatMap((eventValue) => {
        const item = record(eventValue);
        return item ? [{ sessionId: target.sessionId as string, item, view: "wait" }] : [];
      });
    });
  }
  if (name !== "opengeni__session_events" || typeof args.sessionId !== "string") return [];
  if (Array.isArray(page.events)) {
    const view =
      page.view === "conversation" || page.view === "results"
        ? page.view
        : page.payloadMode === "full"
          ? "debug"
          : null;
    if (!view || (view !== "debug" && page.sourceExact !== true)) return [];
    return page.events.flatMap((value) => {
      const item = record(value);
      const fragment = record(item?.fragment);
      if (
        !item ||
        item.sourceOmitted ||
        (item.fragment !== undefined &&
          (!fragment || fragment.offset !== 0 || fragment.complete !== true))
      )
        return [];
      return [{ sessionId: args.sessionId as string, item, view }];
    });
  }
  if (page.version === 1 && record(page.truncation)?.truncated === false) {
    return [{ sessionId: args.sessionId, item: page, view: "compact" }];
  }
  return [];
}

export function historicalChildReadMatches(
  candidate: ReturnType<typeof historicalChildReadItems>[number],
  event: { id: string; sequence: number; type: string; payload: unknown },
): boolean {
  const { item, view } = candidate;
  const retained = record(event.payload);
  if (record(retained?.truncation)?.truncated === true || retained?.sourceOmitted === true)
    return false;
  if (
    item.sequence !== event.sequence ||
    (item.id !== undefined && item.id !== event.id) ||
    (item.type !== undefined && item.type !== event.type)
  )
    return false;
  if (view === "debug") return isDeepStrictEqual(item.payload, event.payload);
  const payload = record(event.payload);
  if (!payload) return false;
  if (view === "conversation") {
    return (
      event.type === "agent.message.completed" &&
      typeof payload.text === "string" &&
      item.text === payload.text
    );
  }
  if (view === "results") {
    const value = event.type === "turn.completed" ? (payload.output ?? payload.result) : payload;
    return (
      value !== undefined &&
      item.text === (typeof value === "string" ? value : JSON.stringify(value))
    );
  }
  // Compact/wait summaries cannot prove that omitted questions, errors or goal
  // fields were consumed. Restrict historical reconciliation to exact answers.
  if (event.type !== "turn.completed" && event.type !== "agent.message.completed") return false;
  const answer =
    event.type === "turn.completed" ? (payload.output ?? payload.result) : payload.text;
  return (
    typeof answer === "string" &&
    answer.length > 0 &&
    (item.text === answer ||
      item.result === answer ||
      (view === "compact" && item.output === answer))
  );
}
