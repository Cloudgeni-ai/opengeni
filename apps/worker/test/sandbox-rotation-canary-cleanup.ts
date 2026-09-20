export type CanaryCleanupStage = { name: string; run: () => Promise<unknown> };

/** A failed cleanup stage never prevents another exact-owned resource cleanup. */
export async function runCanaryCleanupStages(stages: readonly CanaryCleanupStage[]): Promise<void> {
  const errors: unknown[] = [];
  for (const stage of stages) {
    try {
      await stage.run();
    } catch (cause) {
      errors.push(new Error(`Canary cleanup failed: ${stage.name}`, { cause }));
    }
  }
  if (errors.length) throw new AggregateError(errors, "Canary cleanup stages failed");
}

/** Acquisition owns its own partial-failure cleanup. Once it returns, even
 * initialization/validation errors are inside this outer release guard. */
export async function withCanaryFixture<T extends { release: () => Promise<void> }, R>(
  acquire: () => Promise<T>,
  use: (fixture: T, defer: (name: string, run: () => Promise<unknown>) => void) => Promise<R>,
): Promise<R> {
  const fixture = await acquire();
  const stages: CanaryCleanupStage[] = [];
  const errors: unknown[] = [];
  let result!: R;
  try {
    result = await use(fixture, (name, run) => {
      stages.push({ name, run });
    });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await runCanaryCleanupStages(stages.reverse());
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await fixture.release();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Canary execution and cleanup failed");
  return result;
}
