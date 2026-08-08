import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createSharedActivityServices } from "./activity-services";
import { createRunAgentTurnActivity } from "./activities/agent-turn";
import type { ActivityDependencies, TurnActivityServices } from "./activities/types";
import { runtimeMetricsHooksForObservability } from "./observability-metrics";

function createTurnActivityServices(
  dependencies: ActivityDependencies,
): () => Promise<TurnActivityServices> {
  const shared = createSharedActivityServices(dependencies);
  let servicesPromise: Promise<TurnActivityServices> | null = null;
  return async () => {
    servicesPromise ??= (async () => {
      const services = await shared();
      return {
        ...services,
        runtime:
          dependencies.runtime ??
          createProductionAgentRuntime({
            metrics: runtimeMetricsHooksForObservability(services.observability),
          }),
      };
    })();
    return await servicesPromise;
  };
}

export function createTurnActivities(dependencies: ActivityDependencies = {}) {
  return createTurnActivitiesFromServices(createTurnActivityServices(dependencies));
}

export function createTurnActivitiesFromServices(services: () => Promise<TurnActivityServices>) {
  return {
    runAgentTurn: createRunAgentTurnActivity(services),
  };
}
