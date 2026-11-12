import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { useEffect, useState } from "react";
import {
  normalizeVoiceCommandName,
  parseVoiceCommands,
  voiceCommandForSession,
  type VoiceCommand,
} from "./voice-command-model";

export type { VoiceCommand } from "./voice-command-model";

/**
 * Voice commands per account on this device. Only the active, signed-in
 * account's commands are loaded (and offered to Siri and the launcher by the
 * call provider); signing out forgets that account's.
 */
const KEY = "opengeni.voice-commands.v1:";

type State = { accountId: string | null; commands: VoiceCommand[] };
let state: State = { accountId: null, commands: [] };
const listeners = new Set<(value: State) => void>();
// Loads overlap when accounts switch quickly; only the latest may apply.
let activation = 0;

function publish(next: State): void {
  state = next;
  for (const listener of listeners) listener(state);
}

function save(next: VoiceCommand[]): void {
  const accountId = state.accountId;
  if (!accountId) return;
  publish({ accountId, commands: next });
  void AsyncStorage.setItem(`${KEY}${accountId}`, JSON.stringify(next)).catch(() => undefined);
}

/** Load the signed-in account's commands; null (signed out) offers none. */
export async function activateVoiceCommands(accountId: string | null): Promise<void> {
  const generation = ++activation;
  if (!accountId) {
    publish({ accountId: null, commands: [] });
    return;
  }
  if (state.accountId === accountId) return;
  const raw = await AsyncStorage.getItem(`${KEY}${accountId}`).catch(() => null);
  if (generation !== activation) return;
  publish({ accountId, commands: parseVoiceCommands(raw) });
}

/** Forget an account's commands (it signed out of this device). */
export async function forgetVoiceCommands(accountId: string): Promise<void> {
  if (state.accountId === accountId) {
    activation++;
    publish({ accountId: null, commands: [] });
  }
  await AsyncStorage.removeItem(`${KEY}${accountId}`).catch(() => undefined);
}

export function getVoiceCommands(): readonly VoiceCommand[] {
  return state.commands;
}

export function createVoiceCommand(input: {
  workspaceId: string;
  sessionId: string;
  name: string;
  chatTitle: string;
}): VoiceCommand | null {
  if (!state.accountId) return null;
  const existing = voiceCommandForSession(state.commands, input.workspaceId, input.sessionId);
  if (existing) return existing;
  const command: VoiceCommand = {
    id: Crypto.randomUUID(),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    name: normalizeVoiceCommandName(input.name),
    chatTitle: input.chatTitle,
    createdAt: new Date().toISOString(),
  };
  save([...state.commands, command]);
  return command;
}

export function renameVoiceCommand(id: string, name: string): void {
  save(
    state.commands.map((each) =>
      each.id === id ? { ...each, name: normalizeVoiceCommandName(name) } : each,
    ),
  );
}

export function removeVoiceCommand(id: string): void {
  save(state.commands.filter((each) => each.id !== id));
}

/**
 * The chat behind a command is gone: the command stops calling (it leaves
 * Siri and the launcher) but stays listed, so the person sees why and can
 * remove it. Returns the command, or null when the chat had none.
 */
export function markVoiceCommandMissing(
  workspaceId: string,
  sessionId: string,
): VoiceCommand | null {
  const command = voiceCommandForSession(state.commands, workspaceId, sessionId);
  if (!command) return null;
  if (!command.missing) {
    save(
      state.commands.map((each) => (each.id === command.id ? { ...each, missing: true } : each)),
    );
  }
  return command;
}

/** The active account's commands, kept current. */
export function useVoiceCommands(): readonly VoiceCommand[] {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    setValue(state);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value.commands;
}

/**
 * Follow whose commands are loaded and what they are, for example to write
 * them to the system. `accountId` is null while signed out.
 */
export function subscribeVoiceCommands(
  listener: (value: { accountId: string | null; commands: readonly VoiceCommand[] }) => void,
): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}
