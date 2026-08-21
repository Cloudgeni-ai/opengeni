export type WorkspaceOwnedState<Value> = {
  workspaceId: string;
  value: Value;
};

export function workspaceOwnedValue<Value>(
  state: WorkspaceOwnedState<Value>,
  workspaceId: string,
  fallback: Value,
): Value {
  return state.workspaceId === workspaceId ? state.value : fallback;
}

export function updateWorkspaceOwnedState<Value>(
  state: WorkspaceOwnedState<Value>,
  workspaceId: string,
  update: (value: Value) => Value,
): WorkspaceOwnedState<Value> {
  return state.workspaceId === workspaceId ? { workspaceId, value: update(state.value) } : state;
}
