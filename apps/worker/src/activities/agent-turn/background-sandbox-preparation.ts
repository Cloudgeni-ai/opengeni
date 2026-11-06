import type { TurnEventPublisher, TurnBackgroundEventPublisher } from "./model-usage";
import type { TurnSandboxProvisioner } from "./sandbox-provision";

/**
 * How long the first model request may wait for a box that was already warm
 * to finish its per-turn preparation, so its repository skills can be indexed.
 * A warm, already prepared box finishes well inside this; a box that still
 * needs its full setup does not, and the model starts without waiting.
 */
export const WARM_PREPARATION_INDEX_BUDGET_MS = 3_000;

/**
 * Box, environment and repository preparation for a turn whose first model
 * request does not wait for it. It starts as soon as the provisioner exists,
 * runs behind the model request, and the first sandbox tool call joins the
 * same single-flight provision (so setup never runs twice and a failure
 * surfaces on that call). A turn that ends without needing the box abandons
 * what is still running: its progress is no longer published and its setup
 * is stopped with the turn's other sandbox writers.
 */
export type BackgroundSandboxPreparation<T = unknown> = {
  /** The provisioner every turn consumer uses; a `get()` marks it joined. */
  readonly provisioner: TurnSandboxProvisioner<T>;
  /** Starts preparation in the background. Idempotent. */
  start(): void;
  /** Whether repository skills can be indexed from the live workspace for
   * this turn. Decided once and then frozen for the turn. */
  indexReady(): Promise<boolean>;
  /** Called when the turn ends: abandons preparation nothing asked for.
   * Returns true when it was still running and is now abandoned. */
  abandonIfUnjoined(): boolean;
  readonly joined: boolean;
  readonly settled: boolean;
  readonly abandoned: boolean;
};

export function createBackgroundSandboxPreparation<T>(input: {
  provisioner: TurnSandboxProvisioner<T>;
  /** Whether the session's box was already running when the turn started. */
  homeBoxWarm: () => Promise<boolean>;
  indexBudgetMs?: number;
  onBackgroundFailure?: (error: unknown) => void;
}): BackgroundSandboxPreparation<T> {
  const budgetMs = input.indexBudgetMs ?? WARM_PREPARATION_INDEX_BUDGET_MS;
  let joined = false;
  let settled = false;
  let abandoned = false;
  let background: Promise<"ready" | "failed"> | null = null;
  let decision: Promise<boolean> | null = null;
  // Read early so the decision does not add a database round trip later.
  let warm: Promise<boolean> | null = null;
  const homeBoxWarm = (): Promise<boolean> =>
    (warm ??= input.homeBoxWarm().then(
      (value) => value,
      () => false,
    ));

  const start = (): void => {
    if (background) return;
    void homeBoxWarm();
    background = input.provisioner.get().then(
      () => {
        settled = true;
        return "ready" as const;
      },
      (error: unknown) => {
        settled = true;
        if (!abandoned) input.onBackgroundFailure?.(error);
        return "failed" as const;
      },
    );
  };

  const decide = async (): Promise<boolean> => {
    if (!(await homeBoxWarm())) return false;
    start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        background!,
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), budgetMs);
        }),
      ]);
      return outcome === "ready";
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const provisioner: TurnSandboxProvisioner<T> = {
    get() {
      joined = true;
      return input.provisioner.get();
    },
    hasStarted: () => input.provisioner.hasStarted(),
    waitForSettled: (timeoutMs) => input.provisioner.waitForSettled(timeoutMs),
  };

  return {
    provisioner,
    start,
    indexReady: () => (decision ??= decide()),
    abandonIfUnjoined() {
      if (!background || joined || settled || abandoned) return false;
      abandoned = true;
      return true;
    },
    get joined() {
      return joined;
    },
    get settled() {
      return settled;
    },
    get abandoned() {
      return abandoned;
    },
  };
}

const NOTHING_PUBLISHED: Awaited<ReturnType<TurnEventPublisher>> = {
  events: [],
  accepted: true,
  canonicalStartupMilestones: [],
};

/** Drops preparation progress once the preparation was abandoned, so a turn
 * that already ended never gains new "started" or false "failed" steps. */
export function preparationPublisher(
  preparation: Pick<BackgroundSandboxPreparation, "abandoned"> | null,
  publish: TurnEventPublisher | null,
): TurnEventPublisher | null {
  if (!publish || !preparation) return publish;
  return async (events, immediate, mutate) =>
    preparation.abandoned ? NOTHING_PUBLISHED : await publish(events, immediate, mutate);
}

export function preparationBackgroundPublisher(
  preparation: Pick<BackgroundSandboxPreparation, "abandoned"> | null,
  publish: TurnBackgroundEventPublisher | null,
): TurnBackgroundEventPublisher | null {
  if (!publish || !preparation) return publish;
  return (events, options) => {
    if (!preparation.abandoned) publish(events, options);
  };
}
