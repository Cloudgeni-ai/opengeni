import {
  nativeBrokerTransportStore,
  type NativeBrokerTransportBinding,
} from "@opengeni/db/native-command-broker-transport";
import { type Database } from "@opengeni/db";
import { durableNativeBrokerTransport } from "@opengeni/runtime/sandbox";

/** Package-boundary composition only; no API route or runtime admission uses
 * this before the complete broker protocol and artifact are qualified. */
export function createDurableNativeBrokerTransport(
  db: Database,
  encryptionKey: Uint8Array,
  binding: NativeBrokerTransportBinding,
) {
  return durableNativeBrokerTransport(
    nativeBrokerTransportStore(db, encryptionKey, binding),
    binding,
  );
}
