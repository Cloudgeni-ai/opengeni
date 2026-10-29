import type { Settings } from "@opengeni/config";

/**
 * File turns still establish their box and deliver verified files before the
 * model sees any paths. Only independent metadata/tool preparation overlaps
 * managed-box startup; it never uses the box, and agent build joins both.
 */
export async function prepareFileTurnStartup<T>(input: {
  establishPolicy: "eager" | "on-demand";
  machinePrimary: boolean;
  backend: Settings["sandboxBackend"];
  hasFileResources: boolean;
  establish: () => Promise<void>;
  prepare: () => Promise<T>;
}): Promise<T> {
  const overlap =
    input.establishPolicy === "eager" &&
    !input.machinePrimary &&
    input.backend !== "none" &&
    input.backend !== "selfhosted" &&
    input.hasFileResources;
  if (!overlap) {
    await input.establish();
    return await input.prepare();
  }
  // Join both even on failure: outer turn cleanup must see the settled box
  // and tool environment, rather than racing a late lease or MCP preparation.
  // Keep the previous failure priority when both branches fail.
  const [established, prepared] = await Promise.allSettled([
    Promise.resolve().then(input.establish),
    Promise.resolve().then(input.prepare),
  ]);
  if (established.status === "rejected") throw established.reason;
  if (prepared.status === "rejected") throw prepared.reason;
  return prepared.value;
}
