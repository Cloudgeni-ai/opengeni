import { z } from "zod";

export const SessionGoalReportRequirement = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    title: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 512,
        "Report title exceeds 512 UTF-8 bytes",
      ),
  })
  .strict();
export type SessionGoalReportRequirement = z.infer<typeof SessionGoalReportRequirement>;

export const SessionGoalReportRequirements = z
  .array(SessionGoalReportRequirement)
  .max(16)
  .superRefine((requirements, context) => {
    if (new Set(requirements.map((item) => item.id)).size !== requirements.length) {
      context.addIssue({ code: "custom", message: "Duplicate report requirement IDs" });
    }
  });

export const SessionGoalReportDelivery = z
  .object({
    requirementId: SessionGoalReportRequirement.shape.id,
    artifactId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .refine((value) => !/^0+$/.test(value)),
    inspectionReceiptId: z.string().uuid(),
  })
  .strict();
export type SessionGoalReportDelivery = z.infer<typeof SessionGoalReportDelivery>;
export const SessionGoalReportDeliveries = z
  .array(SessionGoalReportDelivery)
  .max(16)
  .superRefine((deliveries, context) => {
    if (new Set(deliveries.map((item) => item.requirementId)).size !== deliveries.length) {
      context.addIssue({ code: "custom", message: "Duplicate report delivery requirement IDs" });
    }
  });
