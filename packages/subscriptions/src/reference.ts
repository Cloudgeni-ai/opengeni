/**
 * The independent reference model of the subscription contract and the bridge
 * that lets it judge production decisions. Separate from the package's main
 * entry point: placement never imports it.
 */
export * from "./reference-model";
export { checkPlacementDecision, toReferenceDecision, toReferenceWorld } from "./reference-bridge";
