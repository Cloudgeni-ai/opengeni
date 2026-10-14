import {
  DaytonaSandboxSession,
  type DaytonaSandboxClient,
} from "@openai/agents-extensions/sandbox/daytona";
import { normalizeSandboxClientCreateArgs } from "@openai/agents/sandbox";
import { assertHostPathGrantsRebound } from "@openai/agents-core/sandbox/internal";
import type { Daytona, Process as NativeProcess } from "@daytonaio/sdk";

type Options = NonNullable<ConstructorParameters<typeof DaytonaSandboxClient>[0]>;
type Route = Readonly<{ apiKey: string; apiUrl: string; target?: string }>;
export type DaytonaCommandProcess = Pick<
  NativeProcess,
  | "createSession"
  | "getSession"
  | "executeSessionCommand"
  | "getSessionCommand"
  | "getSessionCommandLogs"
  | "deleteSession"
>;
type Binding = {
  sandboxId: string;
  route: Route;
  client: Daytona;
  process?: Promise<DaytonaCommandProcess>;
};
const bindings = new WeakMap<DaytonaSandboxSession, Binding>();

function data(value: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function selectedClient(options: Options) {
  if (!options.apiKey) throw new Error("Daytona command binding requires explicit credentials");
  const { Daytona: NativeDaytona } = await import("@daytonaio/sdk");
  const client = new NativeDaytona({
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.target ? { target: options.target } : {}),
  });
  // The pinned constructor resolves native defaults once, before SDK lifecycle
  // dispatch. Capture only known own data fields, not getters or later ambient
  // credentials. No credential or endpoint is rendered into command output.
  const apiKey = data(client, "apiKey");
  const apiUrl = data(client, "apiUrl");
  const target = data(client, "target");
  if (
    apiKey !== options.apiKey ||
    typeof apiUrl !== "string" ||
    !apiUrl ||
    (target !== undefined && typeof target !== "string")
  )
    throw new Error("Unsupported native Daytona route binding");
  const route: Route = Object.freeze({
    apiKey: options.apiKey,
    apiUrl,
    ...(target !== undefined ? { target } : {}),
  });
  return { client, route };
}

function attach(
  session: DaytonaSandboxSession,
  selected: Awaited<ReturnType<typeof selectedClient>>,
) {
  if (!session.state.sandboxId) throw new Error("Missing exact Daytona sandbox identity");
  bindings.set(session, { sandboxId: session.state.sandboxId, ...selected });
  return session;
}

function selectedResumeOptions(options: Options, state: DaytonaSandboxSession["state"]): Options {
  return {
    ...options,
    ...(state.apiKey !== undefined ? { apiKey: state.apiKey } : {}),
    ...(state.apiUrl !== undefined ? { apiUrl: state.apiUrl } : {}),
    ...(state.target !== undefined ? { target: state.target } : {}),
  };
}

/** Preserve the SDK lifecycle. Its native facade erases the public Process
 * session methods, so keep one authenticated same-instance lookup binding in
 * runtime custody instead of requiring repository-only SDK patches. */
export function withDaytonaCommandBinding(client: DaytonaSandboxClient, initial: Options) {
  const options = Object.freeze({ ...initial });
  const create = client.create.bind(client);
  const resume = client.resume.bind(client);
  client.create = async (args, manifestOptions) => {
    const normalized = normalizeSandboxClientCreateArgs(args, manifestOptions);
    const selected = await selectedClient({ ...options, ...normalized.options });
    const session = await create({
      ...normalized,
      options: { ...normalized.options, ...selected.route },
    });
    return attach(session, selected);
  };
  client.resume = async (state, resumeOptions) => {
    const selected = await selectedClient(selectedResumeOptions(options, state));
    return attach(await resume({ ...state, ...selected.route }, resumeOptions), selected);
  };
  // The unpatched SDK's ordinary resume can recreate after an uncertain get.
  // Use only public native/session APIs for exact resume, never that fallback.
  client.resumeExact = async (state) => {
    assertHostPathGrantsRebound(state);
    const selected = await selectedClient(selectedResumeOptions(options, state));
    const sandbox = await selected.client.get(state.sandboxId);
    if (data(sandbox, "id") !== state.sandboxId)
      throw new Error("Daytona exact resume returned a different sandbox");
    assertTarget(sandbox, selected.route);
    await sandbox.start(state.startTimeoutSec);
    const session = new DaytonaSandboxSession({
      // Agents declares PTY id optional although its native call always supplies
      // one. The public native Sandbox otherwise implements this same facade.
      sandbox: sandbox as unknown as ConstructorParameters<
        typeof DaytonaSandboxSession
      >[0]["sandbox"],
      state: { ...state, ...selected.route },
      ...(options.archiveLimits !== undefined ? { archiveLimits: options.archiveLimits } : {}),
    });
    await session.prepareWorkspaceRoot();
    await session.rematerializeMountEntries();
    attach(session, selected);
    // This is the same exact native get used by resume, not a second lookup.
    bindings.get(session)!.process = Promise.resolve(selectProcess(sandbox.process));
    return session;
  };
  return client;
}

function selectProcess(process: NativeProcess): DaytonaCommandProcess {
  const bound: Record<string, unknown> = {};
  for (const method of [
    "createSession",
    "getSession",
    "executeSessionCommand",
    "getSessionCommand",
    "getSessionCommandLogs",
    "deleteSession",
  ] as const) {
    let current: object | null = process;
    let descriptor: PropertyDescriptor | undefined;
    while (current && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(current, method);
      current = Object.getPrototypeOf(current) as object | null;
    }
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
      throw new Error("Unsupported native Daytona command-session method binding");
    bound[method] = descriptor.value.bind(process);
  }
  return Object.freeze(bound) as DaytonaCommandProcess;
}

function assertTarget(sandbox: object, route: Route) {
  // An omitted target retains the provider's default placement for the already
  // selected exact ID. An explicitly selected target must match that instance.
  if (route.target !== undefined && data(sandbox, "target") !== route.target)
    throw new Error("Daytona command lookup returned a different target");
}

/** Resolve before the original command Start. Reads and control keep this
 * same selected Process forever; neither pointer moves nor state mutation can
 * create a new connection for an already-dispatched invocation. */
export async function boundDaytonaCommandProcess(session: DaytonaSandboxSession) {
  const binding = bindings.get(session);
  if (
    !binding ||
    session.state.sandboxId !== binding.sandboxId ||
    session.state.apiKey !== binding.route.apiKey ||
    session.state.apiUrl !== binding.route.apiUrl ||
    session.state.target !== binding.route.target
  )
    throw new Error("Missing or changed exact Daytona command route binding");
  binding.process ??= binding.client.get(binding.sandboxId).then((sandbox) => {
    if (data(sandbox, "id") !== binding.sandboxId)
      throw new Error("Daytona command lookup returned a different sandbox");
    assertTarget(sandbox, binding.route);
    return selectProcess(sandbox.process);
  });
  return await binding.process;
}
