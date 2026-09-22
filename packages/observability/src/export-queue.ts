/** One bounded lane per observer. A hung custom transport holds one slot, not an unbounded retry fanout. */
export class ExportQueue {
  private readonly queue: Array<() => Promise<void>> = [];
  private running: Promise<void> | undefined;
  constructor(
    private readonly observer: (outcome: "exported" | "retried" | "failed" | "dropped") => void,
    private readonly capacity = 256,
  ) {}

  private observe(outcome: "exported" | "retried" | "failed" | "dropped"): void {
    try {
      this.observer(outcome);
    } catch {
      /* Health reporting must not retry a successful export. */
    }
  }

  enqueue(send: () => Promise<void>): void {
    if (this.queue.length >= this.capacity) {
      this.observe("dropped");
      return;
    }
    this.queue.push(send);
    this.start();
  }

  private start(): void {
    if (!this.running) {
      this.running = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.running = undefined;
          if (this.queue.length) this.start();
        });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const send = this.queue.shift()!;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await send();
          this.observe("exported");
          break;
        } catch {
          if (attempt === 2) this.observe("failed");
          else {
            this.observe("retried");
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
          }
        }
      }
    }
  }

  async flush(timeoutMs = 1_000): Promise<void> {
    if (!this.running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.running,
        new Promise<void>((resolve) => {
          timer = setTimeout(
            resolve,
            Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 5_000)) : 1_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
