import type { Session, SessionListEntry } from "@opengeni/sdk";
/** Rail state may merge compact pages with complete mutation/detail responses. */
export type RailSession = Session | SessionListEntry;
