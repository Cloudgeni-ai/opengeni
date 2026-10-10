/**
 * Narrow entrypoint for stateless single model calls.
 *
 * Control-plane processes (the API) import this leaf instead of the runtime
 * barrel. It exposes exactly one bounded model request (no tools, no Runner,
 * no agent loop, no sandbox) plus the provider binding resolver and usage
 * normalization needed to admit and settle it. Agent/run/Runner/RunState and
 * sandbox APIs are deliberately not re-exported here.
 */
export { MultiProviderModelProvider } from "./model-provider-routing";
export {
  runSingleModelCall,
  SingleModelCallProviderError,
  SingleModelCallUnsupportedError,
  type SingleModelCallContentPart,
  type SingleModelCallFinishReason,
  type SingleModelCallMessage,
  type SingleModelCallOptions,
  type SingleModelCallOutputFormat,
  type SingleModelCallRequest,
  type SingleModelCallResult,
  type SingleModelCallTarget,
} from "./single-model-call";
export { normalizeModelCallUsage } from "./usage-telemetry";
