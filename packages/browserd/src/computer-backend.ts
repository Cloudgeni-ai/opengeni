import type {
  ComputerAction,
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
};

export type ComputerBackendObservation = {
  observationId: string;
  target: ComputerBackendTarget;
  frameId: string | null;
  roots: InteractionSemanticNodeValue[];
  nodeCount: number;
  focusedRef: string | null;
  changedRegions: InteractionRect[];
};

export type ComputerBackendActionCommand = {
  targetId: string;
  expectedTargetGeneration: string;
  expectedObservationId: string | null;
  expectedFrameId: string | null;
  action: ComputerAction;
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
  dispatch(command: ComputerBackendActionCommand): Promise<ComputerBackendObservation | null>;
  close(): Promise<void>;
}
