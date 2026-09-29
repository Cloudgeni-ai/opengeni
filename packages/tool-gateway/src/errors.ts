import { formatToolGatewayInputIssues, type ToolGatewayInputIssue } from "./input-issues";

export class ToolGatewayCatalogStaleError extends Error {
  readonly code = "catalog_stale";

  constructor() {
    super("Tool catalog is stale for the active gateway");
    this.name = "ToolGatewayCatalogStaleError";
  }
}

export class ToolGatewayToolNotFoundError extends Error {
  readonly code = "tool_not_found";

  constructor() {
    super("Tool is not present in the active gateway catalog");
    this.name = "ToolGatewayToolNotFoundError";
  }
}

export class ToolGatewayApprovalRequiredError extends Error {
  readonly code = "approval_required";

  constructor() {
    super("Tool requires human approval");
    this.name = "ToolGatewayApprovalRequiredError";
  }
}

export class ToolGatewayCatalogIntegrityError extends Error {
  readonly code = "catalog_integrity_failed";

  constructor() {
    super("Tool catalog digest does not match its authoritative content");
    this.name = "ToolGatewayCatalogIntegrityError";
  }
}

export class ToolGatewayCatalogTooLargeError extends Error {
  readonly code = "catalog_too_large";

  constructor() {
    super("Tool catalog exceeds the maximum serialized size");
    this.name = "ToolGatewayCatalogTooLargeError";
  }
}

export class ToolGatewayPathCollisionError extends Error {
  readonly code = "tool_path_collision";

  constructor(path: readonly string[], kind: "collision" | "extends_leaf") {
    super(
      kind === "extends_leaf"
        ? `Tool path ${path.join(".")} extends a tool leaf`
        : `Tool path ${path.join(".")} collides`,
    );
    this.name = "ToolGatewayPathCollisionError";
  }
}

export class ToolGatewayInputValidationError extends Error {
  readonly code = "invalid_tool_arguments";
  /** Value-free problems, capped at `TOOL_GATEWAY_INPUT_ISSUES_MAX`. */
  readonly issues: readonly ToolGatewayInputIssue[];
  /** Distinct problems found beyond the reported cap. */
  readonly omittedIssueCount: number;
  /** One-line summary of `issues`, or an empty string when none were captured. */
  readonly summary: string;

  constructor(issues: readonly ToolGatewayInputIssue[] = [], omittedIssueCount = 0) {
    const summary = formatToolGatewayInputIssues(issues, omittedIssueCount);
    super(
      summary
        ? `Tool arguments do not match the tool's input schema: ${summary}`
        : "Tool arguments do not match the tool's input schema",
    );
    this.name = "ToolGatewayInputValidationError";
    this.issues = issues;
    this.omittedIssueCount = omittedIssueCount;
    this.summary = summary;
  }
}

export class ToolGatewayOutputValidationError extends Error {
  readonly code = "invalid_tool_result";

  constructor() {
    super("Tool result does not match the gateway catalog output schema");
    this.name = "ToolGatewayOutputValidationError";
  }
}
