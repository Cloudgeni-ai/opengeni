import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** Auth, billing or credit failures stop every paid call in the run; they are never retried. */
export class BudgetStop extends Error {
  constructor(
    readonly reason: "cap" | "auth" | "credit" | "unpriced",
    message: string,
  ) {
    super(message);
    this.name = "BudgetStop";
  }
}

export function classifyProviderError(
  error: unknown,
): "auth" | "credit" | null {
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  } | null;
  const status = Number(e?.status ?? e?.statusCode);
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  if (
    status === 402 ||
    /insufficient (funds|credit|balance)|credit|billing|quota|payment/.test(
      message,
    )
  )
    return "credit";
  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|forbidden|invalid api key|authentication/.test(message)
  )
    return "auth";
  return null;
}

type Entry = {
  at: string;
  arm: string;
  taskId: string;
  kind: "reserve" | "settle" | "stop";
  usd: number;
  note?: string;
};

/**
 * A hard cash cap for one run. Each paid call reserves its worst-case cost first and settles the
 * billed cost after; the cap holds even with concurrent calls. The ledger file survives restarts,
 * so a resumed run continues from what was already spent rather than an empty budget.
 */
export class BudgetLedger {
  private spent = 0;
  private reserved = 0;
  private stopped: BudgetStop | null = null;

  constructor(
    readonly capUsd: number,
    private readonly path?: string,
  ) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as Entry;
        if (entry.kind === "settle") this.spent += entry.usd;
        if (
          entry.kind === "stop" &&
          (entry.note === "auth" || entry.note === "credit")
        )
          this.stopped = new BudgetStop(
            entry.note,
            `run stopped earlier: ${entry.note}`,
          );
      }
    }
  }

  get spentUsd() {
    return this.spent;
  }
  get stop() {
    return this.stopped;
  }

  private write(entry: Omit<Entry, "at">) {
    if (this.path)
      appendFileSync(
        this.path,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
  }

  /** Throws before the call when it could exceed the cap or the run has stopped. */
  reserve(
    arm: string,
    taskId: string,
    worstCaseUsd: number,
  ): { settle(usd: number): void; release(): void } {
    if (this.stopped) throw this.stopped;
    if (this.spent + this.reserved + worstCaseUsd > this.capUsd)
      throw new BudgetStop(
        "cap",
        `cap $${this.capUsd} would be exceeded (spent $${this.spent.toFixed(4)})`,
      );
    this.reserved += worstCaseUsd;
    let open = true;
    const close = () => {
      if (open) this.reserved -= worstCaseUsd;
      open = false;
    };
    return {
      settle: (usd: number) => {
        close();
        this.spent += usd;
        this.write({ arm, taskId, kind: "settle", usd });
      },
      release: close,
    };
  }

  /** Record a provider failure; auth and credit failures stop the run. Returns the stop, if any. */
  fail(arm: string, taskId: string, error: unknown): BudgetStop | null {
    const kind = classifyProviderError(error);
    if (!kind) return null;
    this.stopped = new BudgetStop(
      kind,
      `provider ${kind} error; stopping all paid calls`,
    );
    this.write({ arm, taskId, kind: "stop", usd: 0, note: kind });
    return this.stopped;
  }
}
