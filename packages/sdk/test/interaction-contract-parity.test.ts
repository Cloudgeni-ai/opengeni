import { describe, expect, test } from "bun:test";
import {
  BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES as CONTRACT_FRAME_HEADER_BYTES,
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX as CONTRACT_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL as CONTRACT_WEBSOCKET_PROTOCOL,
  AttachedBrowserDevice as ContractAttachedBrowserDevice,
  AttachedBrowserDeviceListResponse as ContractAttachedBrowserDeviceListResponse,
  BrowserActionReceipt as ContractBrowserActionReceipt,
  BrowserActionRequest as ContractBrowserActionRequest,
  BrowserDiagnosticBatch as ContractBrowserDiagnosticBatch,
  BrowserIdentity as ContractBrowserIdentity,
  BrowserIdentityListResponse as ContractBrowserIdentityListResponse,
  BrowserIdentityMutationResponse as ContractBrowserIdentityMutationResponse,
  BrowserObservation as ContractBrowserObservation,
  BrowserRevision as ContractBrowserRevision,
  BrowserRevisionListResponse as ContractBrowserRevisionListResponse,
  BrowserSession as ContractBrowserSession,
  BrowserSessionAttachment as ContractBrowserSessionAttachment,
  BrowserSessionAttachmentRequest as ContractBrowserSessionAttachmentRequest,
  BrowserSessionHeartbeatResponse as ContractBrowserSessionHeartbeatResponse,
  BrowserSessionListResponse as ContractBrowserSessionListResponse,
  BrowserSessionMutationResponse as ContractBrowserSessionMutationResponse,
  BrowserTargetListResponse as ContractBrowserTargetListResponse,
  CreateBrowserIdentityRequest as ContractCreateBrowserIdentityRequest,
  CreateBrowserSessionRequest as ContractCreateBrowserSessionRequest,
  ComputerAction as ContractComputerAction,
  ComputerActionReceipt as ContractComputerActionReceipt,
  ComputerActionRequest as ContractComputerActionRequest,
  ComputerObservation as ContractComputerObservation,
  ComputerSession as ContractComputerSession,
  ComputerSessionAttachment as ContractComputerSessionAttachment,
  ComputerSessionAttachmentRequest as ContractComputerSessionAttachmentRequest,
  ComputerSessionHeartbeatResponse as ContractComputerSessionHeartbeatResponse,
  ComputerSessionListResponse as ContractComputerSessionListResponse,
  ComputerSessionMutationResponse as ContractComputerSessionMutationResponse,
  ComputerTargetListResponse as ContractComputerTargetListResponse,
  CreateComputerSessionRequest as ContractCreateComputerSessionRequest,
  COMPUTER_CONTROL_WEBSOCKET_PROTOCOL as CONTRACT_COMPUTER_WEBSOCKET_PROTOCOL,
  INTERACTION_PROTOCOL_VERSION as CONTRACT_INTERACTION_PROTOCOL_VERSION,
  PublishBrowserRevisionRequest as ContractPublishBrowserRevisionRequest,
  PublishBrowserRevisionResponse as ContractPublishBrowserRevisionResponse,
} from "@opengeni/contracts";
import type { z } from "zod";
import {
  BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES,
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  INTERACTION_PROTOCOL_VERSION,
  type AttachedBrowserDevice,
  type AttachedBrowserDeviceListResponse,
  type BrowserActionReceipt,
  type BrowserActionRequest,
  type BrowserDiagnosticBatch,
  type BrowserIdentity,
  type BrowserIdentityListResponse,
  type BrowserIdentityMutationResponse,
  type BrowserObservation,
  type BrowserRevision,
  type BrowserRevisionListResponse,
  type BrowserSession,
  type BrowserSessionAttachment,
  type BrowserSessionAttachmentRequest,
  type BrowserSessionHeartbeatResponse,
  type BrowserSessionListResponse,
  type BrowserSessionMutationResponse,
  type BrowserTargetListResponse,
  type CreateBrowserIdentityRequest,
  type CreateBrowserSessionRequest,
  COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
  type ComputerAction,
  type ComputerActionReceipt,
  type ComputerActionRequest,
  type ComputerObservation,
  type ComputerSession,
  type ComputerSessionAttachment,
  type ComputerSessionAttachmentRequest,
  type ComputerSessionHeartbeatResponse,
  type ComputerSessionListResponse,
  type ComputerSessionMutationResponse,
  type ComputerTargetListResponse,
  type CreateComputerSessionRequest,
  type PublishBrowserRevisionRequest,
  type PublishBrowserRevisionResponse,
} from "../src/interaction";

describe("SDK interaction / contracts parity", () => {
  test("pins the public frame constants", () => {
    expect(INTERACTION_PROTOCOL_VERSION).toBe(CONTRACT_INTERACTION_PROTOCOL_VERSION);
    expect(BROWSER_CONTROL_WEBSOCKET_PROTOCOL).toBe(CONTRACT_WEBSOCKET_PROTOCOL);
    expect(BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX).toBe(CONTRACT_BEARER_PREFIX);
    expect(BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES).toBe(CONTRACT_FRAME_HEADER_BYTES);
    expect(COMPUTER_CONTROL_WEBSOCKET_PROTOCOL).toBe(CONTRACT_COMPUTER_WEBSOCKET_PROTOCOL);
  });

  test("pins ComputerSession read and mutation response shapes bidirectionally", () => {
    const checks = [
      exact<ComputerSession, z.infer<typeof ContractComputerSession>>(true),
      exact<ComputerSessionListResponse, z.infer<typeof ContractComputerSessionListResponse>>(true),
      exact<
        ComputerSessionMutationResponse,
        z.infer<typeof ContractComputerSessionMutationResponse>
      >(true),
      exact<ComputerTargetListResponse, z.infer<typeof ContractComputerTargetListResponse>>(true),
      exact<ComputerAction, z.infer<typeof ContractComputerAction>>(true),
      exact<ComputerSessionAttachment, z.infer<typeof ContractComputerSessionAttachment>>(true),
      exact<
        ComputerSessionHeartbeatResponse,
        z.infer<typeof ContractComputerSessionHeartbeatResponse>
      >(true),
    ];
    const contractObservationToSdk = (
      value: z.infer<typeof ContractComputerObservation>,
    ): ComputerObservation => value;
    const sdkObservationToContract = (
      value: ComputerObservation,
    ): z.infer<typeof ContractComputerObservation> => value;
    const contractReceiptToSdk = (
      value: z.infer<typeof ContractComputerActionReceipt>,
    ): ComputerActionReceipt => value;
    const sdkReceiptToContract = (
      value: ComputerActionReceipt,
    ): z.infer<typeof ContractComputerActionReceipt> => value;
    expect(
      [
        ...checks,
        contractObservationToSdk,
        sdkObservationToContract,
        contractReceiptToSdk,
        sdkReceiptToContract,
      ].every(Boolean),
    ).toBe(true);
  });

  test("pins BrowserSession read and mutation response shapes bidirectionally", () => {
    const checks = [
      exact<AttachedBrowserDevice, z.infer<typeof ContractAttachedBrowserDevice>>(true),
      exact<
        AttachedBrowserDeviceListResponse,
        z.infer<typeof ContractAttachedBrowserDeviceListResponse>
      >(true),
      exact<BrowserSession, z.infer<typeof ContractBrowserSession>>(true),
      exact<BrowserSessionListResponse, z.infer<typeof ContractBrowserSessionListResponse>>(true),
      exact<BrowserSessionMutationResponse, z.infer<typeof ContractBrowserSessionMutationResponse>>(
        true,
      ),
      exact<BrowserTargetListResponse, z.infer<typeof ContractBrowserTargetListResponse>>(true),
      exact<BrowserDiagnosticBatch, z.infer<typeof ContractBrowserDiagnosticBatch>>(true),
      exact<BrowserIdentity, z.infer<typeof ContractBrowserIdentity>>(true),
      exact<BrowserIdentityListResponse, z.infer<typeof ContractBrowserIdentityListResponse>>(true),
      exact<
        BrowserIdentityMutationResponse,
        z.infer<typeof ContractBrowserIdentityMutationResponse>
      >(true),
      exact<BrowserRevision, z.infer<typeof ContractBrowserRevision>>(true),
      exact<BrowserRevisionListResponse, z.infer<typeof ContractBrowserRevisionListResponse>>(true),
      exact<PublishBrowserRevisionResponse, z.infer<typeof ContractPublishBrowserRevisionResponse>>(
        true,
      ),
      exact<BrowserSessionAttachment, z.infer<typeof ContractBrowserSessionAttachment>>(true),
      exact<
        BrowserSessionHeartbeatResponse,
        z.infer<typeof ContractBrowserSessionHeartbeatResponse>
      >(true),
    ];
    const contractObservationToSdk = (
      value: z.infer<typeof ContractBrowserObservation>,
    ): BrowserObservation => value;
    const sdkObservationToContract = (
      value: BrowserObservation,
    ): z.infer<typeof ContractBrowserObservation> => value;
    const contractReceiptToSdk = (
      value: z.infer<typeof ContractBrowserActionReceipt>,
    ): BrowserActionReceipt => value;
    const sdkReceiptToContract = (
      value: BrowserActionReceipt,
    ): z.infer<typeof ContractBrowserActionReceipt> => value;
    expect(
      [
        ...checks,
        contractObservationToSdk,
        sdkObservationToContract,
        contractReceiptToSdk,
        sdkReceiptToContract,
      ].every(Boolean),
    ).toBe(true);
  });

  test("pins BrowserSession request input shapes bidirectionally", () => {
    const checks = [
      exact<CreateBrowserSessionRequest, z.input<typeof ContractCreateBrowserSessionRequest>>(true),
      exact<CreateBrowserIdentityRequest, z.input<typeof ContractCreateBrowserIdentityRequest>>(
        true,
      ),
      exact<PublishBrowserRevisionRequest, z.input<typeof ContractPublishBrowserRevisionRequest>>(
        true,
      ),
      exact<
        BrowserSessionAttachmentRequest,
        z.input<typeof ContractBrowserSessionAttachmentRequest>
      >(true),
      exact<BrowserActionRequest, z.input<typeof ContractBrowserActionRequest>>(true),
    ];
    expect(checks.every(Boolean)).toBe(true);
  });

  test("pins ComputerSession request input shapes bidirectionally", () => {
    const checks = [
      exact<CreateComputerSessionRequest, z.input<typeof ContractCreateComputerSessionRequest>>(
        true,
      ),
      exact<
        ComputerSessionAttachmentRequest,
        z.input<typeof ContractComputerSessionAttachmentRequest>
      >(true),
      exact<ComputerActionRequest, z.input<typeof ContractComputerActionRequest>>(true),
    ];
    expect(checks.every(Boolean)).toBe(true);
  });
});

type Exact<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : never) : never;

/** Compile-time bidirectional assignability, with a tiny runtime witness. */
function exact<Left, Right>(_value: Exact<Left, Right>): true {
  return true;
}
