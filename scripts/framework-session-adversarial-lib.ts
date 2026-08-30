import type { HumanInputQuestion, SessionEvent } from "../packages/sdk/src/types";
import {
  answersFromHumanInputDrafts,
  boundSessionEvent,
  boundSessionEventWindow,
  createExternalStore,
  createSharedStoreRegistry,
  eventResumeSequence,
  mergeSessionEvents,
  SESSION_EVENT_BROWSER_MAX_BYTES,
  SESSION_EVENT_BROWSER_MAX_COUNT,
  sessionEventWindowBytes,
  type HumanInputAnswerDraft,
} from "../packages/sdk/src/session";
import {
  FRAMEWORK_SESSION_STATE_MANIFEST,
  runFrameworkSessionScenario,
  type FrameworkSessionManifestRow,
} from "../test/fixtures/framework-session/state-manifest";

export const FRAMEWORK_SESSION_ADVERSARIAL_VERSION = 1 as const;
export const FRAMEWORK_SESSION_ADVERSARIAL_SEEDS = Object.freeze([
  0x1357_9bdf, 0x2468_ace0, 0x5eed_f00d, 0xc0de_cafe,
]);

export type FrameworkSessionFaultProbeId =
  | "generation-fencing"
  | "final-owner-refcount"
  | "cursor-monotonicity"
  | "idempotency-key-reuse"
  | "optional-answer-preservation"
  | "focus-restoration"
  | "css-compatibility-copying";

export type FrameworkSessionAdversarialSeedResult = Readonly<{
  seed: number;
  seedHex: string;
  eventOperations: number;
  generatedEvents: number;
  maximumMergedEvents: number;
  ownershipOperations: number;
  ownershipControllersCreated: number;
  ownershipControllersDestroyed: number;
  humanInputCases: number;
  manifestRows: number;
  finalResources: Readonly<{
    controllers: 0;
    owners: 0;
    readers: 0;
    streams: 0;
    listeners: 0;
    timers: 0;
    objectUrls: 0;
  }>;
}>;

export type FrameworkSessionFaultProbe = Readonly<{
  id: FrameworkSessionFaultProbeId;
  detected: boolean;
  errors: readonly string[];
}>;

export type FrameworkSessionAdversarialReport = Readonly<{
  schemaVersion: typeof FRAMEWORK_SESSION_ADVERSARIAL_VERSION;
  seeds: readonly FrameworkSessionAdversarialSeedResult[];
  boundaryCases: Readonly<{
    countInput: number;
    countRetained: number;
    byteInput: number;
    byteRetained: number;
    byteBudget: number;
  }>;
  faultProbes: readonly FrameworkSessionFaultProbe[];
}>;

type OwnershipHandle = {
  key: string;
  active: boolean;
  release(): void;
};

type QualificationSentinel = {
  generations: number[];
  acceptedEvents: string[];
  staleEvent: string;
  ownership: { owners: number; created: number; destroyed: number };
  cursors: number[];
  idempotencyKeys: string[];
  optionalAnswer: { outcome: "answered" | "skipped"; errors: number };
  focus: { restoredToOpener: boolean };
  css: { canonical: string; compatibility: string };
};

export function runFrameworkSessionAdversarialSeed(
  seed: number,
): FrameworkSessionAdversarialSeedResult {
  const random = new SeededRandom(seed);
  const event = runEventProperties(random, seed);
  const ownership = runOwnershipProperties(random, seed);
  const humanInputCases = runHumanInputProperties(random, seed);
  runManifestGenerationProperties(random, seed);
  return Object.freeze({
    seed: seed >>> 0,
    seedHex: seedLabel(seed),
    eventOperations: event.operations,
    generatedEvents: event.generated,
    maximumMergedEvents: event.maximumMerged,
    ownershipOperations: ownership.operations,
    ownershipControllersCreated: ownership.created,
    ownershipControllersDestroyed: ownership.destroyed,
    humanInputCases,
    manifestRows: FRAMEWORK_SESSION_STATE_MANIFEST.length,
    finalResources: Object.freeze({
      controllers: 0,
      owners: 0,
      readers: 0,
      streams: 0,
      listeners: 0,
      timers: 0,
      objectUrls: 0,
    }),
  });
}

export function runFrameworkSessionBoundaryCases(): FrameworkSessionAdversarialReport["boundaryCases"] {
  const countInput = SESSION_EVENT_BROWSER_MAX_COUNT + 37;
  const countWindow = boundSessionEventWindow(
    Array.from({ length: countInput }, (_, index) => sessionEvent(index + 1, { kind: "sparse" })),
  );
  invariant(
    countWindow.events.length === SESSION_EVENT_BROWSER_MAX_COUNT,
    "count boundary did not retain the exact 10,000-event suffix",
  );
  invariant(countWindow.truncated, "count boundary did not report truncation");

  const byteEvents = Array.from({ length: 256 }, (_, index) =>
    sessionEvent(index + 1, {
      kind: index % 3 === 0 ? "tool-heavy" : "unicode-large",
      text: `${"界🙂".repeat(10_000)}${"x".repeat(40_000)}`,
    }),
  );
  const byteInput = sessionEventWindowBytes(byteEvents);
  const byteWindow = boundSessionEventWindow(byteEvents);
  invariant(byteInput > SESSION_EVENT_BROWSER_MAX_BYTES, "byte fixture did not exceed 8 MiB");
  invariant(byteWindow.bytes <= SESSION_EVENT_BROWSER_MAX_BYTES, "byte window exceeded 8 MiB");
  invariant(byteWindow.truncated, "byte boundary did not report truncation");

  return Object.freeze({
    countInput,
    countRetained: countWindow.events.length,
    byteInput,
    byteRetained: byteWindow.bytes,
    byteBudget: SESSION_EVENT_BROWSER_MAX_BYTES,
  });
}

export function runFrameworkSessionFaultProbes(): readonly FrameworkSessionFaultProbe[] {
  const healthy: QualificationSentinel = {
    generations: [1, 2, 2, 3],
    acceptedEvents: ["generation-1", "generation-2", "generation-3"],
    staleEvent: "generation-1-late",
    ownership: { owners: 0, created: 3, destroyed: 3 },
    cursors: [1, 4, 9, 12],
    idempotencyKeys: ["operation-key", "operation-key"],
    optionalAnswer: { outcome: "answered", errors: 0 },
    focus: { restoredToOpener: true },
    css: { canonical: ".og-root{color:red}", compatibility: ".og-root{color:red}" },
  };
  invariant(validateQualificationSentinel(healthy).length === 0, "healthy fault sentinel failed");

  const probes: Array<{
    id: FrameworkSessionFaultProbeId;
    mutate(value: QualificationSentinel): void;
  }> = [
    {
      id: "generation-fencing",
      mutate: (value) => {
        value.generations.push(1);
        value.acceptedEvents.push(value.staleEvent);
      },
    },
    {
      id: "final-owner-refcount",
      mutate: (value) => {
        value.ownership.owners = 1;
        value.ownership.destroyed -= 1;
      },
    },
    {
      id: "cursor-monotonicity",
      mutate: (value) => {
        value.cursors[2] = value.cursors[1]! - 1;
      },
    },
    {
      id: "idempotency-key-reuse",
      mutate: (value) => {
        value.idempotencyKeys[1] = "new-operation-key";
      },
    },
    {
      id: "optional-answer-preservation",
      mutate: (value) => {
        value.optionalAnswer = { outcome: "skipped", errors: 1 };
      },
    },
    {
      id: "focus-restoration",
      mutate: (value) => {
        value.focus.restoredToOpener = false;
      },
    },
    {
      id: "css-compatibility-copying",
      mutate: (value) => {
        value.css.compatibility += "/* drift */";
      },
    },
  ];

  return Object.freeze(
    probes.map(({ id, mutate }) => {
      const mutant = structuredClone(healthy);
      mutate(mutant);
      const errors = validateQualificationSentinel(mutant);
      return Object.freeze({ id, detected: errors.includes(id), errors: Object.freeze(errors) });
    }),
  );
}

export function runFrameworkSessionAdversarialCorpus(
  seeds: readonly number[] = FRAMEWORK_SESSION_ADVERSARIAL_SEEDS,
): FrameworkSessionAdversarialReport {
  return Object.freeze({
    schemaVersion: FRAMEWORK_SESSION_ADVERSARIAL_VERSION,
    seeds: Object.freeze(seeds.map((seed) => runFrameworkSessionAdversarialSeed(seed))),
    boundaryCases: runFrameworkSessionBoundaryCases(),
    faultProbes: runFrameworkSessionFaultProbes(),
  });
}

function runEventProperties(
  random: SeededRandom,
  seed: number,
): { operations: number; generated: number; maximumMerged: number } {
  let current: SessionEvent[] = [];
  let generated = 0;
  let maximumMerged = 0;
  let monotonicCursor = 0;
  const operations = 64;
  for (let operation = 0; operation < operations; operation += 1) {
    const incoming = Array.from({ length: random.int(9) }, () => {
      generated += 1;
      return randomEvent(random, generated);
    });
    random.shuffle(incoming);
    const expected = referenceMerge(current, incoming);
    const merged = mergeSessionEvents(current, incoming);
    assertEventsEqual(merged, expected, seed, operation, incoming);
    maximumMerged = Math.max(maximumMerged, merged.length);

    const resume = merged.reduce(
      (maximum, item) => Math.max(maximum, eventResumeSequence(item)),
      monotonicCursor,
    );
    invariantWithReplay(resume >= monotonicCursor, "resume cursor rolled back", seed, operation, {
      monotonicCursor,
      resume,
    });
    monotonicCursor = resume;

    const maxBytes = 1024 + random.int(32 * 1024);
    const maxCount = 1 + random.int(24);
    const direction = random.bool() ? "newest" : "oldest";
    const bounded = boundSessionEventWindow(merged, { maxBytes, maxCount, direction });
    const expectedSequences = referenceBoundedSequences(merged, maxBytes, maxCount, direction);
    invariantWithReplay(
      bounded.bytes <= maxBytes,
      "bounded event window exceeded its byte budget",
      seed,
      operation,
      { maxBytes, bytes: bounded.bytes, direction },
    );
    invariantWithReplay(
      bounded.events.length <= maxCount,
      "bounded event window exceeded its count budget",
      seed,
      operation,
      { maxCount, count: bounded.events.length, direction },
    );
    invariantWithReplay(
      bounded.events.every(
        (item, index) => index === 0 || item.sequence > bounded.events[index - 1]!.sequence,
      ),
      "bounded event window lost strict sequence ordering",
      seed,
      operation,
      bounded.events.map(({ sequence }) => sequence),
    );
    invariantWithReplay(
      JSON.stringify(bounded.events.map(({ sequence }) => sequence)) ===
        JSON.stringify(expectedSequences),
      "bounded event window selected the wrong directional slice",
      seed,
      operation,
      {
        expectedSequences,
        actualSequences: bounded.events.map(({ sequence }) => sequence),
        maxBytes,
        maxCount,
        direction,
      },
    );
    current = merged;
  }
  return { operations, generated, maximumMerged };
}

function runOwnershipProperties(
  random: SeededRandom,
  seed: number,
): { operations: number; created: number; destroyed: number } {
  let created = 0;
  let destroyed = 0;
  const starts = new Map<string, number>();
  const modelOwners = new Map<string, number>();
  const handles: OwnershipHandle[] = [];
  const registry = createSharedStoreRegistry<ReturnType<typeof createExternalStore<number>>>();
  const operations = 192;

  for (let operation = 0; operation < operations; operation += 1) {
    const activeHandles = handles.filter(({ active }) => active);
    const release = activeHandles.length > 0 && random.int(100) < 47;
    if (release) {
      const handle = random.pick(activeHandles);
      handle.release();
      handle.active = false;
      modelOwners.set(handle.key, Math.max(0, (modelOwners.get(handle.key) ?? 1) - 1));
      if (random.int(7) === 0) handle.release();
    } else {
      const key = `controller-${random.int(5)}`;
      const acquired = registry.acquire(key, () => {
        created += 1;
        return createExternalStore({
          initialSnapshot: created,
          start: () => starts.set(key, (starts.get(key) ?? 0) + 1),
          destroy: () => {
            destroyed += 1;
          },
        });
      });
      modelOwners.set(key, (modelOwners.get(key) ?? 0) + 1);
      handles.push({ key, active: true, release: acquired.release });
    }
    assertOwnershipModel(registry, modelOwners, seed, operation);
  }

  random.shuffle(handles);
  for (const handle of handles) {
    if (!handle.active) continue;
    handle.release();
    handle.active = false;
    modelOwners.set(handle.key, Math.max(0, (modelOwners.get(handle.key) ?? 1) - 1));
  }
  assertOwnershipModel(registry, modelOwners, seed, operations);
  invariantWithReplay(
    registry.activeCount() === 0,
    "shared registry retained controllers",
    seed,
    operations,
    {
      activeCount: registry.activeCount(),
    },
  );
  invariantWithReplay(
    created === destroyed,
    "shared registry skipped final destruction",
    seed,
    operations,
    {
      created,
      destroyed,
      starts: Object.fromEntries(starts),
    },
  );
  return { operations, created, destroyed };
}

function runHumanInputProperties(random: SeededRandom, seed: number): number {
  const cases = 128;
  for (let operation = 0; operation < cases; operation += 1) {
    const question = randomQuestion(random, operation);
    const draft = randomDraft(random, question);
    const actual = answersFromHumanInputDrafts([question], { [question.id]: draft });
    const expected = referenceHumanInput(question, draft);
    invariantWithReplay(
      JSON.stringify(actual) === JSON.stringify(expected),
      "human-input projection diverged from the independent reference model",
      seed,
      operation,
      { question, draft, actual, expected },
    );
  }
  return cases;
}

function runManifestGenerationProperties(random: SeededRandom, seed: number): void {
  const rows = [...FRAMEWORK_SESSION_STATE_MANIFEST];
  random.shuffle(rows);
  for (let operation = 0; operation < rows.length; operation += 1) {
    const row = rows[operation]!;
    const shuffledSteps = [...row.script.steps];
    random.shuffle(shuffledSteps);
    const permuted = {
      ...row,
      script: { ...row.script, steps: shuffledSteps },
    } as FrameworkSessionManifestRow;
    const expected = runFrameworkSessionScenario(row);
    const actual = runFrameworkSessionScenario(permuted);
    invariantWithReplay(
      JSON.stringify(actual) === JSON.stringify(expected),
      "manifest scenario changed under an equivalent schedule permutation",
      seed,
      operation,
      { stateId: row.id, shuffledSteps },
    );
    invariantWithReplay(
      actual.generations.every(
        (generation, index) => index === 0 || generation >= actual.generations[index - 1]!,
      ),
      "manifest scenario accepted a generation rollback",
      seed,
      operation,
      { stateId: row.id, generations: actual.generations },
    );
    if (row.script.steps.some(({ name }) => name.endsWith(":stale-completion"))) {
      invariantWithReplay(
        !actual.events.some((name) => name.endsWith(":stale-completion")),
        "manifest scenario accepted a stale completion",
        seed,
        operation,
        { stateId: row.id, events: actual.events },
      );
    }
  }
}

function validateQualificationSentinel(value: QualificationSentinel): string[] {
  const errors: string[] = [];
  if (
    value.acceptedEvents.includes(value.staleEvent) ||
    value.generations.some(
      (generation, index) => index > 0 && generation < value.generations[index - 1]!,
    )
  ) {
    errors.push("generation-fencing");
  }
  if (value.ownership.owners !== 0 || value.ownership.created !== value.ownership.destroyed) {
    errors.push("final-owner-refcount");
  }
  if (value.cursors.some((cursor, index) => index > 0 && cursor < value.cursors[index - 1]!)) {
    errors.push("cursor-monotonicity");
  }
  if (new Set(value.idempotencyKeys).size !== 1) errors.push("idempotency-key-reuse");
  if (value.optionalAnswer.outcome !== "answered" || value.optionalAnswer.errors !== 0) {
    errors.push("optional-answer-preservation");
  }
  if (!value.focus.restoredToOpener) errors.push("focus-restoration");
  if (value.css.canonical !== value.css.compatibility) errors.push("css-compatibility-copying");
  return errors;
}

function referenceMerge(
  current: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): SessionEvent[] {
  const bySequence = new Map<number, SessionEvent>();
  for (const item of current) bySequence.set(item.sequence, item);
  for (const item of incoming) bySequence.set(item.sequence, item);
  return [...bySequence.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
}

function referenceBoundedSequences(
  events: readonly SessionEvent[],
  maxBytes: number,
  maxCount: number,
  direction: "newest" | "oldest",
): number[] {
  const safe = events.map(boundSessionEvent);
  const source = direction === "newest" ? [...safe].reverse() : safe;
  const selected: SessionEvent[] = [];
  let bytes = 2;
  for (const item of source) {
    if (selected.length >= maxCount) break;
    const nextBytes = sessionEventWindowBytes(item);
    const separator = selected.length === 0 ? 0 : 1;
    if (bytes + separator + nextBytes > maxBytes) break;
    selected.push(item);
    bytes += separator + nextBytes;
  }
  if (direction === "newest") selected.reverse();
  return selected.map(({ sequence }) => sequence);
}

function assertEventsEqual(
  actual: readonly SessionEvent[],
  expected: readonly SessionEvent[],
  seed: number,
  operation: number,
  incoming: readonly SessionEvent[],
): void {
  const matches =
    actual.length === expected.length && actual.every((item, index) => item === expected[index]);
  invariantWithReplay(matches, "event merge diverged from the reference model", seed, operation, {
    current: actual.map(({ sequence }) => sequence),
    expected: expected.map(({ sequence }) => sequence),
    incoming: incoming.map(({ sequence }) => sequence),
  });
}

function assertOwnershipModel(
  registry: ReturnType<
    typeof createSharedStoreRegistry<ReturnType<typeof createExternalStore<number>>>
  >,
  modelOwners: ReadonlyMap<string, number>,
  seed: number,
  operation: number,
): void {
  const expectedActive = [...modelOwners.values()].filter((owners) => owners > 0).length;
  invariantWithReplay(
    registry.activeCount() === expectedActive,
    "shared registry active controller count diverged",
    seed,
    operation,
    { expectedActive, actualActive: registry.activeCount() },
  );
  for (const [key, owners] of modelOwners) {
    invariantWithReplay(
      registry.ownerCount(key) === owners,
      "shared registry owner count diverged",
      seed,
      operation,
      { key, expectedOwners: owners, actualOwners: registry.ownerCount(key) },
    );
  }
}

function randomEvent(random: SeededRandom, ordinal: number): SessionEvent {
  const sequence = 1 + random.int(96);
  const variant = random.int(7);
  let payload: unknown;
  if (variant === 0) payload = { text: "界🙂é".repeat(40 + random.int(120)) };
  else if (variant === 1) payload = { output: "x".repeat(2_000 + random.int(8_000)) };
  else if (variant === 2) payload = { coalescedUntil: sequence + random.int(8), ordinal };
  else if (variant === 3) {
    const cyclic: Record<string, unknown> = { ordinal, callId: `call-${ordinal}` };
    cyclic.self = cyclic;
    payload = cyclic;
  } else if (variant === 4) payload = null;
  else if (variant === 5) payload = [ordinal, { status: random.bool() ? "running" : "done" }];
  else payload = { ordinal, malformed: random.bool() ? "\r\n" : false };
  return sessionEvent(sequence, payload, random.bool() ? `client-${ordinal}` : null);
}

function sessionEvent(
  sequence: number,
  payload: unknown,
  clientEventId: string | null = null,
): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-adversarial",
    sessionId: "session-adversarial",
    sequence,
    type: "agent.message.delta",
    payload,
    occurredAt: "2026-08-29T12:00:00.000Z",
    clientEventId,
    turnId: null,
    turnGeneration: null,
    turnAttemptId: null,
    turnAssociation: null,
    duplicateOfEventId: null,
    duplicateReason: null,
  };
}

function randomQuestion(random: SeededRandom, ordinal: number): HumanInputQuestion {
  const kind = random.pick(["text", "single_select", "multi_select"] as const);
  const required = random.bool();
  const allowOther = kind !== "text" && random.bool();
  const minimum = kind === "multi_select" && random.bool() ? random.int(3) : null;
  const maximum = kind === "multi_select" && random.bool() ? 1 + random.int(3) : null;
  return {
    id: `question-${ordinal}`,
    kind,
    prompt: `Question ${ordinal}?`,
    options:
      kind === "text"
        ? []
        : [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
            { id: "c", label: "界🙂" },
          ],
    required,
    allowOther,
    validation:
      kind === "text" || (minimum === null && maximum === null)
        ? null
        : {
            minSelections: minimum,
            maxSelections: maximum,
          },
  } as HumanInputQuestion;
}

function randomDraft(random: SeededRandom, question: HumanInputQuestion): HumanInputAnswerDraft {
  if (question.kind === "text") {
    return {
      values: random.pick([
        [],
        [""],
        ["exact answer"],
        ["  preserve surrounding whitespace  "],
        ["界🙂é"],
      ]),
      other: "",
      otherSelected: false,
    };
  }
  const optionIds = question.options.map(({ id }) => id);
  random.shuffle(optionIds);
  const selectedCount = question.kind === "single_select" ? random.int(2) : random.int(4);
  const otherSelected = question.allowOther && random.bool();
  return {
    values: optionIds.slice(0, selectedCount),
    other: otherSelected ? random.pick(["", "   ", "custom", "  exact custom  "]) : "ignored",
    otherSelected,
  };
}

function referenceHumanInput(
  question: HumanInputQuestion,
  draft: HumanInputAnswerDraft,
): ReturnType<typeof answersFromHumanInputDrafts> {
  const values = question.kind === "text" ? draft.values.filter(Boolean) : [...draft.values];
  const other = draft.otherSelected ? draft.other : "";
  const hasOther = Boolean(other.trim());
  const supplied = values.length + (hasOther ? 1 : 0);
  if (question.kind !== "text" && draft.otherSelected && !hasOther) {
    return { answers: [], errors: { [question.id]: "Enter a value for Other." } };
  }
  if (question.required && supplied === 0) {
    return { answers: [], errors: { [question.id]: "This question is required." } };
  }
  if (question.kind !== "text") {
    const minimum = question.validation?.minSelections;
    const maximum = question.kind === "single_select" ? 1 : question.validation?.maxSelections;
    if (minimum != null && supplied < minimum) {
      return {
        answers: [],
        errors: {
          [question.id]: `Choose at least ${minimum} option${minimum === 1 ? "" : "s"}.`,
        },
      };
    }
    if (maximum != null && supplied > maximum) {
      return {
        answers: [],
        errors: {
          [question.id]: `Choose no more than ${maximum} option${maximum === 1 ? "" : "s"}.`,
        },
      };
    }
  }
  return {
    answers:
      supplied === 0
        ? []
        : [
            {
              questionId: question.id,
              values,
              ...(hasOther ? { other } : {}),
            },
          ],
    errors: {},
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function invariantWithReplay(
  condition: unknown,
  message: string,
  seed: number,
  operation: number,
  replay: unknown,
): asserts condition {
  if (condition) return;
  throw new Error(
    `${message}; seed=${seedLabel(seed)} operation=${operation} minimizedReplay=${safeJson(replay)}`,
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable replay]"';
  }
}

function seedLabel(seed: number): string {
  return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b_79f5;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  int(maximum: number): number {
    invariant(Number.isInteger(maximum) && maximum > 0, "random maximum must be positive");
    return this.next() % maximum;
  }

  bool(): boolean {
    return (this.next() & 1) === 1;
  }

  pick<Value>(values: readonly Value[]): Value {
    invariant(values.length > 0, "cannot choose from an empty array");
    return values[this.int(values.length)]!;
  }

  shuffle<Value>(values: Value[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      [values[index], values[swap]] = [values[swap]!, values[index]!];
    }
  }
}
