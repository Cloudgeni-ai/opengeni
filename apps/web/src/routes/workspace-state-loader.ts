import type {
  OpenGeniClient,
  PreferenceRegistryDetailResponse,
  PreferenceRegistryListResponse,
  WorkspaceInstructionPolicyOnboardingProposalListResponse,
  WorkspaceStateResponse,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

type WorkspaceStateClient = Pick<OpenGeniClient, "getWorkspaceState">;

type WorkspaceStateLoad = {
  client: WorkspaceStateClient;
  workspaceId: string;
  attemptId: string | undefined;
  state: WorkspaceStateResponse | null;
  error: Error | null;
  loading: boolean;
};

export function useWorkspaceStateInventory(
  client: WorkspaceStateClient,
  workspaceId: string,
  attemptId?: string,
): Omit<WorkspaceStateLoad, "client" | "workspaceId" | "attemptId"> & {
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [result, setResult] = useState<WorkspaceStateLoad>(() => ({
    client,
    workspaceId,
    attemptId,
    state: null,
    error: null,
    loading: true,
  }));

  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setResult((previous) => ({
      client,
      workspaceId,
      attemptId,
      state:
        previous.client === client &&
        previous.workspaceId === workspaceId &&
        previous.attemptId === attemptId
          ? previous.state
          : null,
      error: null,
      loading: true,
    }));
    try {
      const state = await client.getWorkspaceState(workspaceId, { attemptId });
      if (generation.current !== requestGeneration) return;
      setResult({ client, workspaceId, attemptId, state, error: null, loading: false });
    } catch (loadError) {
      if (generation.current !== requestGeneration) return;
      setResult((previous) => ({
        client,
        workspaceId,
        attemptId,
        state:
          previous.client === client &&
          previous.workspaceId === workspaceId &&
          previous.attemptId === attemptId
            ? previous.state
            : null,
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
        loading: false,
      }));
    }
  }, [attemptId, client, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  if (
    result.client !== client ||
    result.workspaceId !== workspaceId ||
    result.attemptId !== attemptId
  ) {
    return { state: null, error: null, loading: true, reload };
  }
  return { state: result.state, error: result.error, loading: result.loading, reload };
}

type OnboardingProposalClient = Pick<
  OpenGeniClient,
  "listWorkspaceInstructionPolicyOnboardingProposals"
>;

type OnboardingProposalLoad = {
  client: OnboardingProposalClient;
  workspaceId: string;
  response: WorkspaceInstructionPolicyOnboardingProposalListResponse | null;
  error: Error | null;
  loading: boolean;
};

export function useWorkspaceInstructionPolicyOnboardingProposals(
  client: OnboardingProposalClient,
  workspaceId: string,
): Omit<OnboardingProposalLoad, "client" | "workspaceId"> & {
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [result, setResult] = useState<OnboardingProposalLoad>(() => ({
    client,
    workspaceId,
    response: null,
    error: null,
    loading: true,
  }));
  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setResult((previous) => ({
      client,
      workspaceId,
      response:
        previous.client === client && previous.workspaceId === workspaceId
          ? previous.response
          : null,
      error: null,
      loading: true,
    }));
    try {
      const response = await client.listWorkspaceInstructionPolicyOnboardingProposals(workspaceId, {
        limit: 50,
      });
      if (generation.current !== requestGeneration) return;
      setResult({ client, workspaceId, response, error: null, loading: false });
    } catch (loadError) {
      if (generation.current !== requestGeneration) return;
      setResult((previous) => ({
        client,
        workspaceId,
        response:
          previous.client === client && previous.workspaceId === workspaceId
            ? previous.response
            : null,
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
        loading: false,
      }));
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  if (result.client !== client || result.workspaceId !== workspaceId) {
    return { response: null, error: null, loading: true, reload };
  }
  return {
    response: result.response,
    error: result.error,
    loading: result.loading,
    reload,
  };
}

type PreferenceRegistryClient = Pick<
  OpenGeniClient,
  "getPreferenceRegistry" | "listPreferenceRegistry"
>;

type PreferenceRegistryInventoryLoad = {
  client: PreferenceRegistryClient;
  workspaceId: string;
  response: PreferenceRegistryListResponse | null;
  error: Error | null;
  loading: boolean;
};

export function usePreferenceRegistryInventory(
  client: PreferenceRegistryClient,
  workspaceId: string,
): Omit<PreferenceRegistryInventoryLoad, "client" | "workspaceId"> & {
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [result, setResult] = useState<PreferenceRegistryInventoryLoad>(() => ({
    client,
    workspaceId,
    response: null,
    error: null,
    loading: true,
  }));
  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setResult((previous) => ({
      client,
      workspaceId,
      response:
        previous.client === client && previous.workspaceId === workspaceId
          ? previous.response
          : null,
      error: null,
      loading: true,
    }));
    try {
      const response = await client.listPreferenceRegistry(workspaceId, { limit: 100 });
      if (generation.current !== requestGeneration) return;
      setResult({ client, workspaceId, response, error: null, loading: false });
    } catch (loadError) {
      if (generation.current !== requestGeneration) return;
      setResult((previous) => ({
        client,
        workspaceId,
        response:
          previous.client === client && previous.workspaceId === workspaceId
            ? previous.response
            : null,
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
        loading: false,
      }));
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  if (result.client !== client || result.workspaceId !== workspaceId) {
    return { response: null, error: null, loading: true, reload };
  }
  return {
    response: result.response,
    error: result.error,
    loading: result.loading,
    reload,
  };
}

type PreferenceRegistryDetailLoad = {
  client: PreferenceRegistryClient;
  workspaceId: string;
  preferenceId: string | null;
  response: PreferenceRegistryDetailResponse | null;
  error: Error | null;
  loading: boolean;
};

export function usePreferenceRegistryDetail(
  client: PreferenceRegistryClient,
  workspaceId: string,
  preferenceId: string | null,
): Omit<PreferenceRegistryDetailLoad, "client" | "workspaceId" | "preferenceId"> & {
  reload: () => Promise<void>;
} {
  const generation = useRef(0);
  const [result, setResult] = useState<PreferenceRegistryDetailLoad>(() => ({
    client,
    workspaceId,
    preferenceId,
    response: null,
    error: null,
    loading: preferenceId !== null,
  }));
  const reload = useCallback(async () => {
    const requestGeneration = ++generation.current;
    if (!preferenceId) {
      setResult({
        client,
        workspaceId,
        preferenceId: null,
        response: null,
        error: null,
        loading: false,
      });
      return;
    }
    setResult((previous) => ({
      client,
      workspaceId,
      preferenceId,
      response:
        previous.client === client &&
        previous.workspaceId === workspaceId &&
        previous.preferenceId === preferenceId
          ? previous.response
          : null,
      error: null,
      loading: true,
    }));
    try {
      const response = await client.getPreferenceRegistry(workspaceId, preferenceId);
      if (generation.current !== requestGeneration) return;
      setResult({ client, workspaceId, preferenceId, response, error: null, loading: false });
    } catch (loadError) {
      if (generation.current !== requestGeneration) return;
      setResult((previous) => ({
        client,
        workspaceId,
        preferenceId,
        response:
          previous.client === client &&
          previous.workspaceId === workspaceId &&
          previous.preferenceId === preferenceId
            ? previous.response
            : null,
        error: loadError instanceof Error ? loadError : new Error(String(loadError)),
        loading: false,
      }));
    }
  }, [client, preferenceId, workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  if (
    result.client !== client ||
    result.workspaceId !== workspaceId ||
    result.preferenceId !== preferenceId
  ) {
    return {
      response: null,
      error: null,
      loading: preferenceId !== null,
      reload,
    };
  }
  return {
    response: result.response,
    error: result.error,
    loading: result.loading,
    reload,
  };
}
