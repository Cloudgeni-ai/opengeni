export type ModelPickerOption = Readonly<{
  id: string;
  label?: string;
  disabled?: boolean;
}>;

export type ToolPolicyOption = Readonly<{
  id: string;
  label: string;
  description?: string;
  state?:
    | "available"
    | "enabled"
    | "connection-required"
    | "approval-required"
    | "denied"
    | "unavailable";
}>;
