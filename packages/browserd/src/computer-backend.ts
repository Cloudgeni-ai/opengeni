import type {
  ComputerAction,
  ComputerActionBatch,
  ComputerNativeCallRequest,
  ComputerNativeResult,
  ComputerClipboard,
  ComputerSessionCapabilities,
  InteractionRect,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";

/** Placement-local desktop backend. Authority, receipts and media stay in the controller. */
export type ComputerBackendTarget = {
  id: string;
  targetGeneration: string;
  kind: "app" | "window" | "screen";
  applicationId: string | null;
  processId: number | null;
  title: string;
  bounds: InteractionRect | null;
  focused: boolean;
  /** A window that cannot be captured or read until it is back on screen. */
  offScreen?: true;
};

export type ComputerBackendObservation = {
  observationId: string;
  target: ComputerBackendTarget;
  frameId: string | null;
  roots: InteractionSemanticNodeValue[];
  nodeCount: number;
  /** The platform stopped reading the tree early; listed nodes are real. */
  incomplete?: { reason: "time_budget" | "node_budget"; unreadCount: number } | undefined;
  /** No elements were read because native CUA tools own this session's reads. */
  readByNativeTools?: true | undefined;
  focusedRef: string | null;
  changedRegions: InteractionRect[];
};

export type ComputerBackendActionCommand = {
  /** Durable controller operation identity. Older ordinary commands may omit it. */
  operationId?: string;
  targetId: string;
  expectedTargetGeneration: string;
  expectedObservationId: string | null;
  expectedFrameId: string | null;
  /** A batch reaches only a backend whose capabilities include actionBatches. */
  action: ComputerAction | ComputerActionBatch;
};

export type ComputerBackendFrame = {
  frameId: string;
  targetId: string;
  targetGeneration: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  data: Uint8Array;
};

export type ComputerBackendCaptureOptions = {
  format: "png" | "jpeg";
  quality: number;
  maxWidth: number;
  maxHeight: number;
};

export type ComputerBackendClipboard = Pick<ComputerClipboard, "text" | "truncated">;

export type ComputerBackendErrorCode =
  | "target_not_found"
  | "target_stale"
  | "observation_stale"
  | "frame_stale"
  | "locator_not_found"
  | "locator_ambiguous"
  | "unsupported"
  | "permission_denied"
  | "unavailable"
  | "machine_locked"
  | "invalid_action"
  | "timeout"
  | "driver_failed"
  | "outcome_unknown";

export class ComputerBackendError extends Error {
  /** Optional structured facts about the failure, kept in the receipt's
   * error (for a batch, how many of its actions completed). */
  details: Record<string, string | number | boolean> | undefined = undefined;

  constructor(
    readonly code: ComputerBackendErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly dispatched: boolean,
  ) {
    super(message);
    this.name = "ComputerBackendError";
  }
}

export interface ComputerBackend {
  validateNative?(request: ComputerNativeCallRequest): Promise<void>;
  callNative?(
    request: ComputerNativeCallRequest,
  ): Promise<Pick<ComputerNativeResult, "result" | "outcome" | "error">>;
  readonly identity: { adapterId: string; platform: "linux" | "macos" | "windows" };
  readonly initialCapabilities: ComputerSessionCapabilities;
  capabilities(): Promise<ComputerSessionCapabilities>;
  targets(): Promise<ComputerBackendTarget[]>;
  observe(targetId: string): Promise<ComputerBackendObservation>;
  capture(targetId: string, options?: ComputerBackendCaptureOptions): Promise<ComputerBackendFrame>;
  captureStill(
    targetId: string,
    options: ComputerBackendCaptureOptions,
  ): Promise<ComputerBackendFrame>;
  startCapture(targetId: string, options: ComputerBackendCaptureOptions): Promise<void>;
  stopCapture(targetId: string): Promise<void>;
  clipboard(): Promise<ComputerBackendClipboard>;
  validate(command: ComputerBackendActionCommand): Promise<void>;
  /** A backend that can act on an element of another role than the one an
   * action's locator named reports each such action to `standIn`. A backend
   * whose delivery of a single click or key press was not confirmed (the
   * app gives no sign it acted on raw input) calls `unconfirmed`. */
  dispatch(
    command: ComputerBackendActionCommand,
    standIn?: (standIn: ComputerBackendRoleStandIn) => void,
    unconfirmed?: () => void,
  ): Promise<ComputerBackendObservation | null>;
  close(): Promise<void>;
}

/** An action that acted on the one element of a role pressed alike (a link
 * for a button, or a button for a link) with the exact name its locator gave,
 * because nothing of the role named had that name. */
export type ComputerBackendRoleStandIn = {
  actionIndex: number;
  requestedRole: string;
  role: string;
  name: string;
};
