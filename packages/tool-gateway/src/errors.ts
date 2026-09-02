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

export class ToolGatewayInputValidationError extends Error {
  readonly code = "invalid_tool_arguments";

  constructor() {
    super("Tool arguments do not match the gateway catalog input schema");
    this.name = "ToolGatewayInputValidationError";
  }
}

export class ToolGatewayOutputValidationError extends Error {
  readonly code = "invalid_tool_result";

  constructor() {
    super("Tool result does not match the gateway catalog output schema");
    this.name = "ToolGatewayOutputValidationError";
  }
}
