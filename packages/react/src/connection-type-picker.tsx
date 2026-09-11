import { useId } from "react";
export type ConnectionType = "mcp" | "openapi" | "graphql";
export function ConnectionTypePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ConnectionType;
  onChange: (value: ConnectionType) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="og-connection-type-picker" disabled={disabled}>
      <legend>Connection type</legend>
      {(
        [
          ["mcp", "MCP server"],
          ["openapi", "OpenAPI"],
          ["graphql", "GraphQL"],
        ] as const
      ).map(([type, label]) => (
        <label key={type} data-selected={value === type}>
          <input
            type="radio"
            name={name}
            value={type}
            checked={value === type}
            onChange={() => onChange(type)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
