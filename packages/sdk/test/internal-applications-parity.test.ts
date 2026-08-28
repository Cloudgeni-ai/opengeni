import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  ApplyInternalApplicationDeploymentRequest as ContractApply,
  CreateInternalApplicationAiSessionRequest as ContractAiSession,
  CreateInternalApplicationBuildSessionRequest as ContractBuildSession,
  CreateInternalApplicationRequest as ContractCreate,
  InternalApplicationDeploymentActionResponse as ContractActionResponse,
  InternalApplicationBuildSessionReceipt as ContractBuildReceipt,
  InternalApplicationDetail as ContractDetail,
  InternalApplicationEvent as ContractEvent,
  PlanInternalApplicationDeploymentRequest as ContractPlan,
  ReconcileInternalApplicationDeploymentOperationRequest as ContractReconcile,
  RetireInternalApplicationDeploymentRequest as ContractRetire,
  UpsertInternalApplicationDataSourceRequest as ContractDataSource,
  UpsertInternalApplicationDeploymentTargetRequest as ContractTarget,
} from "@opengeni/contracts/internal-applications";
import type {
  ApplyInternalApplicationDeploymentRequest,
  CreateInternalApplicationAiSessionRequest,
  CreateInternalApplicationBuildSessionRequest,
  CreateInternalApplicationRequest,
  InternalApplicationDeploymentActionResponse,
  InternalApplicationBuildSessionReceipt,
  InternalApplicationDetail,
  InternalApplicationEvent,
  PlanInternalApplicationDeploymentRequest,
  ReconcileInternalApplicationDeploymentOperationRequest,
  RetireInternalApplicationDeploymentRequest,
  UpsertInternalApplicationDataSourceRequest,
  UpsertInternalApplicationDeploymentTargetRequest,
} from "../src/internal-applications";

describe("internal application SDK / contract parity", () => {
  test("keeps request and response shapes mutually assignable", () => {
    const contractCreateToSdk = (
      value: z.input<typeof ContractCreate>,
    ): CreateInternalApplicationRequest => value;
    const sdkCreateToContract = (
      value: CreateInternalApplicationRequest,
    ): z.input<typeof ContractCreate> => value;
    const contractDataToSdk = (
      value: z.input<typeof ContractDataSource>,
    ): UpsertInternalApplicationDataSourceRequest => value;
    const sdkDataToContract = (
      value: UpsertInternalApplicationDataSourceRequest,
    ): z.input<typeof ContractDataSource> => value;
    const contractTargetToSdk = (
      value: z.input<typeof ContractTarget>,
    ): UpsertInternalApplicationDeploymentTargetRequest => value;
    const sdkTargetToContract = (
      value: UpsertInternalApplicationDeploymentTargetRequest,
    ): z.input<typeof ContractTarget> => value;
    const contractPlanToSdk = (
      value: z.infer<typeof ContractPlan>,
    ): PlanInternalApplicationDeploymentRequest => value;
    const sdkPlanToContract = (
      value: PlanInternalApplicationDeploymentRequest,
    ): z.infer<typeof ContractPlan> => value;
    const contractApplyToSdk = (
      value: z.infer<typeof ContractApply>,
    ): ApplyInternalApplicationDeploymentRequest => value;
    const sdkApplyToContract = (
      value: ApplyInternalApplicationDeploymentRequest,
    ): z.infer<typeof ContractApply> => value;
    const contractDetailToSdk = (
      value: z.infer<typeof ContractDetail>,
    ): InternalApplicationDetail => value;
    const sdkDetailToContract = (
      value: InternalApplicationDetail,
    ): z.infer<typeof ContractDetail> => value;
    const contractActionToSdk = (
      value: z.infer<typeof ContractActionResponse>,
    ): InternalApplicationDeploymentActionResponse => value;
    const sdkActionToContract = (
      value: InternalApplicationDeploymentActionResponse,
    ): z.infer<typeof ContractActionResponse> => value;
    const contractAiToSdk = (
      value: z.input<typeof ContractAiSession>,
    ): CreateInternalApplicationAiSessionRequest => value;
    const sdkAiToContract = (
      value: CreateInternalApplicationAiSessionRequest,
    ): z.input<typeof ContractAiSession> => value;
    const contractRetireToSdk = (
      value: z.infer<typeof ContractRetire>,
    ): RetireInternalApplicationDeploymentRequest => value;
    const sdkRetireToContract = (
      value: RetireInternalApplicationDeploymentRequest,
    ): z.infer<typeof ContractRetire> => value;
    const contractEventToSdk = (value: z.infer<typeof ContractEvent>): InternalApplicationEvent =>
      value;
    const sdkEventToContract = (value: InternalApplicationEvent): z.infer<typeof ContractEvent> =>
      value;
    const contractBuildToSdk = (
      value: z.input<typeof ContractBuildSession>,
    ): CreateInternalApplicationBuildSessionRequest => value;
    const sdkBuildToContract = (
      value: CreateInternalApplicationBuildSessionRequest,
    ): z.input<typeof ContractBuildSession> => value;
    const contractBuildReceiptToSdk = (
      value: z.infer<typeof ContractBuildReceipt>,
    ): InternalApplicationBuildSessionReceipt => value;
    const sdkBuildReceiptToContract = (
      value: InternalApplicationBuildSessionReceipt,
    ): z.infer<typeof ContractBuildReceipt> => value;
    const contractReconcileToSdk = (
      value: z.infer<typeof ContractReconcile>,
    ): ReconcileInternalApplicationDeploymentOperationRequest => value;
    const sdkReconcileToContract = (
      value: ReconcileInternalApplicationDeploymentOperationRequest,
    ): z.infer<typeof ContractReconcile> => value;
    expect([
      contractCreateToSdk,
      sdkCreateToContract,
      contractDataToSdk,
      sdkDataToContract,
      contractTargetToSdk,
      sdkTargetToContract,
      contractPlanToSdk,
      sdkPlanToContract,
      contractApplyToSdk,
      sdkApplyToContract,
      contractDetailToSdk,
      sdkDetailToContract,
      contractActionToSdk,
      sdkActionToContract,
      contractAiToSdk,
      sdkAiToContract,
      contractRetireToSdk,
      sdkRetireToContract,
      contractEventToSdk,
      sdkEventToContract,
      contractBuildToSdk,
      sdkBuildToContract,
      contractBuildReceiptToSdk,
      sdkBuildReceiptToContract,
      contractReconcileToSdk,
      sdkReconcileToContract,
    ]).toHaveLength(26);
  });
});
