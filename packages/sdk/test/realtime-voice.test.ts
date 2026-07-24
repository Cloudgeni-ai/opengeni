import { describe, expect, test } from "bun:test";
import {
  CreateSessionVoiceGrantResponse as ContractCreateSessionVoiceGrantResponse,
  SessionVoiceCapability as ContractSessionVoiceCapability,
  SessionVoiceGrant as ContractSessionVoiceGrant,
  WorkspaceRealtimeVoicePolicy as ContractWorkspaceRealtimeVoicePolicy,
} from "@opengeni/contracts";
import type { z } from "zod";
import type {
  CreateSessionVoiceGrantResponse,
  SessionVoiceCapability,
  SessionVoiceGrant,
  WorkspaceRealtimeVoicePolicy,
} from "../src/realtime-voice";

describe("SDK realtime voice contract parity", () => {
  test("accepts every contract-produced public voice shape", () => {
    const acceptCapability = (
      value: z.infer<typeof ContractSessionVoiceCapability>,
    ): SessionVoiceCapability => value;
    const acceptGrant = (value: z.infer<typeof ContractSessionVoiceGrant>): SessionVoiceGrant =>
      value;
    const acceptResponse = (
      value: z.infer<typeof ContractCreateSessionVoiceGrantResponse>,
    ): CreateSessionVoiceGrantResponse => value;
    const acceptPolicy = (
      value: z.infer<typeof ContractWorkspaceRealtimeVoicePolicy>,
    ): WorkspaceRealtimeVoicePolicy => value;
    expect([acceptCapability, acceptGrant, acceptResponse, acceptPolicy]).toHaveLength(4);
  });
});
