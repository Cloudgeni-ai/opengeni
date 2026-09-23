import { describe, expect, test } from "bun:test";
import { appendGoalReportRequirements, goalReportRequirements } from "../src/session-goal-reports";

describe("versioned goal report metadata", () => {
  test("appends secondary reports, preserving unrelated metadata and existing declarations", () => {
    const original = {
      custom: "preserve",
      reportRequirementsV1: [{ id: "direct", title: "Direct report" }],
    };
    const next = appendGoalReportRequirements(original, [
      { id: "secondary", title: "Secondary report" },
    ]);
    expect(goalReportRequirements(next)).toEqual([
      ...original.reportRequirementsV1,
      { id: "secondary", title: "Secondary report" },
    ]);
    expect(next.custom).toBe("preserve");
    expect(original.reportRequirementsV1).toHaveLength(1);
  });
  test("exact redeclaration is idempotent; title replacement and malformed state fail closed", () => {
    const report = { id: "report", title: "Report" };
    const metadata = appendGoalReportRequirements({}, [report]);
    expect(appendGoalReportRequirements(metadata, [report])).toEqual(metadata);
    expect(() =>
      appendGoalReportRequirements(metadata, [{ ...report, title: "Replacement" }]),
    ).toThrow("immutable");
    expect(() => goalReportRequirements({ reportRequirementsV1: true })).toThrow();
    expect(() => goalReportRequirements({ reportRequirementsV1: null })).toThrow();
    expect(() => appendGoalReportRequirements({}, [report, report])).toThrow();
  });
  test("omitted and empty declarations cannot clear requirements", () => {
    const metadata = appendGoalReportRequirements({}, [{ id: "report", title: "Report" }]);
    expect(appendGoalReportRequirements(metadata)).toEqual(metadata);
    expect(appendGoalReportRequirements(metadata, [])).toEqual(metadata);
  });
});
