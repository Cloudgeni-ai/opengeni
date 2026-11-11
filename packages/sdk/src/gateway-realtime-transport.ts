import { createRealtimeWebsocketTransportStarter } from "./realtime-websocket-transport";
import type { RealtimeControllerTransportStarter } from "./codex-realtime-controller";

export { createRealtimeWebsocketTransportStarter };

/** @deprecated Use createRealtimeWebsocketTransportStarter; one transport serves every WebSocket provider. */
export function createGatewayRealtimeTransportStarter(): RealtimeControllerTransportStarter {
  return createRealtimeWebsocketTransportStarter();
}

/** @deprecated Use createRealtimeWebsocketTransportStarter; one transport serves every WebSocket provider. */
export function createXaiSubscriptionRealtimeTransportStarter(): RealtimeControllerTransportStarter {
  return createRealtimeWebsocketTransportStarter();
}
