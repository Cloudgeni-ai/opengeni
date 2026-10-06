import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { shell, filesystem, type SandboxSessionLike } from "@openai/agents/sandbox";
import { applyDiff, tool as sdkTool, type Tool } from "@openai/agents";
import { z } from "zod";
import {
  executeSandboxV2AcceptedToolAction,
  type createSandboxV2BackgroundCommandTools,
} from "@opengeni/core";
import type { Database, SandboxJournalTurnAuthority } from "@opengeni/db";
import type { SandboxV2PreparationFile, SandboxV2PreparationRepository } from "@opengeni/contracts";
import { SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES } from "@opengeni/contracts";
import { buildSandboxV2PreparedFileManifest } from "@opengeni/runtime";
import {
  JournalBindingError,
  SandboxV2FilesystemFailure,
  SandboxV2TextFilesystem,
  SANDBOX_V2_EDITOR_FILE_BYTES,
  withRunCredentialEnvironment,
  type ChannelAExecArgs,
  type MachineSandboxSession,
} from "@opengeni/runtime/sandbox";

type SessionOptions = Omit<
  ConstructorParameters<typeof MachineSandboxSession>[0],
  "persistence"
> & {
  useRunCredentials?: boolean;
  preparedFiles?: readonly SandboxV2PreparationFile[];
  preparedRepositories?: readonly SandboxV2PreparationRepository[];
  authorizeResources?: () => Promise<void>;
  backgroundCommands?: ReturnType<typeof createSandboxV2BackgroundCommandTools>;
};
type Invocation = {
  session: MachineSandboxSession;
  operation: (key: string) => MachineSandboxSession;
  signal?: AbortSignal;
  failure?: { error: unknown };
  imageFailure?: string;
};
const patchPath = z.string().min(1).max(4096);
const patchDiff = z.string().max(SANDBOX_V2_EDITOR_FILE_BYTES);
const patchParameters = z
  .object({
    operation: z.discriminatedUnion("type", [
      z.object({ type: z.literal("create_file"), path: patchPath, diff: patchDiff }).strict(),
      z
        .object({
          type: z.literal("update_file"),
          path: patchPath,
          diff: patchDiff,
          moveTo: patchPath.optional(),
        })
        .strict(),
      z.object({ type: z.literal("delete_file"), path: patchPath }).strict(),
    ]),
  })
  .strict();

/** Trusted command and bounded text-edit SDK composition. This does not establish a machine,
 * grant new attempt authority, or install a qualified turn adapter. Each SDK
 * call is registered before execution; its complete reply is retained before
 * acknowledgment. Legacy command correlation/cancellation wrappers must not be
 * installed around this capability: native journal/control ownership applies. */
export function createSandboxV2ShellBinding(
  db: Database,
  authority: Omit<SandboxJournalTurnAuthority, "acceptedActionId">,
  options: SessionOptions,
  outputPolicy: { modelToolOutputTruncationTokens?: number } = {},
) {
  authority = structuredClone(authority);
  options = {
    ...options,
    instance: structuredClone(options.instance),
    capabilities: { ...options.capabilities },
    ...(options.journal ? { journal: { ...options.journal } } : {}),
  };
  outputPolicy = { ...outputPolicy };
  const invocation = new AsyncLocalStorage<Invocation>();
  const current = () => {
    const value = invocation.getStore();
    if (!value)
      throw new JournalBindingError("Sandbox SDK command requires an accepted tool action");
    value.signal?.throwIfAborted();
    return value.session;
  };
  const root = posix.resolve(options.workspaceRoot ?? "/workspace");
  if (root === "/") throw new JournalBindingError("A workspace root is required");
  const preparedFiles = Object.freeze(
    structuredClone(options.preparedFiles ?? []).map((file) => Object.freeze(file)),
  );
  const manifest = buildSandboxV2PreparedFileManifest(preparedFiles, root);
  const preparedRepositories = Object.freeze(
    structuredClone(options.preparedRepositories ?? []).map((repository) =>
      Object.freeze(repository),
    ),
  );
  const commandArgs = (args: ChannelAExecArgs): ChannelAExecArgs =>
    options.useRunCredentials
      ? { ...args, cmd: withRunCredentialEnvironment(args.cmd, authority.sessionId) }
      : args;
  const edit = async (
    runAs: string | undefined,
    action: (files: SandboxV2TextFilesystem) => Promise<void>,
  ) => {
    current();
    if (!options.capabilities.stdin)
      return { status: "failed" as const, output: "Native text editing requires stdin support" };
    const value = invocation.getStore()!;
    try {
      await action(
        new SandboxV2TextFilesystem(root, value.operation, {
          ...(runAs ? { runAs } : {}),
          ...(value.signal ? { signal: value.signal } : {}),
        }),
      );
      return {};
    } catch (error) {
      if (error instanceof SandboxV2FilesystemFailure)
        return { status: "failed" as const, output: error.message };
      // The SDK editor renders thrown errors as text. Save uncertain native
      // failures and rethrow outside that renderer before retaining a reply.
      value.failure = { error };
      throw error;
    }
  };
  const session: SandboxSessionLike = {
    state: Object.freeze({
      manifest,
      workspaceReady: false,
      kind: "machine-v2",
      machineId: options.machineId,
      instance: Object.freeze(structuredClone(options.instance)),
    }),
    exec: async (args) => current().exec(commandArgs(args)),
    execCommand: async (args) => current().execCommand(commandArgs(args)),
    writeStdin: async (args) =>
      current().writeStdin({
        ...args,
        ...(invocation.getStore()?.signal ? { signal: invocation.getStore()!.signal! } : {}),
      }),
    supportsPty: () => options.capabilities.pty,
    viewImage: async (args) => {
      current();
      const value = invocation.getStore()!;
      try {
        const url = await new SandboxV2TextFilesystem(root, value.operation, {
          ...(args.runAs ? { runAs: args.runAs } : {}),
          ...(value.signal ? { signal: value.signal } : {}),
        }).readImage(args.path);
        await options.authorizeResources?.();
        value.signal?.throwIfAborted();
        return { type: "image", image: { url } };
      } catch (error) {
        // SDK image errors become text. Preserve an uncertain native outcome
        // outside that renderer, just as for text editing.
        if (error instanceof SandboxV2FilesystemFailure) value.imageFailure = error.message;
        else value.failure = { error };
        throw error;
      }
    },
    createEditor: (runAs) => ({
      createFile: async (operation) => {
        current();
        let content: string;
        try {
          content = applyDiff("", operation.diff, "create");
        } catch {
          return { status: "failed", output: "Invalid create-file diff" };
        }
        return edit(runAs, (files) => files.create(operation.path, content));
      },
      updateFile: (operation) =>
        edit(runAs, async (files) => {
          const base = await files.readText(operation.path);
          let content: string;
          try {
            content = applyDiff(base, operation.diff);
          } catch {
            throw new SandboxV2FilesystemFailure("Patch does not match the retained file text");
          }
          await files.update(operation.path, content, base, operation.moveTo);
        }),
      deleteFile: (operation) => edit(runAs, (files) => files.delete(operation.path)),
    }),
  };
  const retainTools = (
    tools: Tool<unknown>[],
    environment = options.environment,
    outputWindowBytes?: number,
  ) =>
    tools.map((tool) => {
      if (tool.type !== "function")
        throw new JournalBindingError("Unexpected native sandbox tool transport");
      const invoke = tool.invoke;
      return {
        ...tool,
        invoke: async (
          context: Parameters<typeof invoke>[0],
          input: string,
          details: Parameters<typeof invoke>[2],
        ) => {
          const call = details?.toolCall;
          if (
            !call ||
            call.type !== "function_call" ||
            typeof call.callId !== "string" ||
            !call.callId ||
            call.name !== tool.name ||
            call.arguments !== input
          )
            throw new JournalBindingError(
              "Sandbox SDK call requires its exact accepted input and identity",
            );
          details.signal?.throwIfAborted();
          if (tool.name === "exec_command" && !options.backgroundCommands) {
            const args = z
              .object({ background: z.boolean().default(false) })
              .passthrough()
              .parse(JSON.parse(input));
            if (args.background)
              throw new JournalBindingError(
                "Independent background command ownership is unavailable",
              );
          }
          await options.authorizeResources?.();
          details.signal?.throwIfAborted();
          return executeSandboxV2AcceptedToolAction(
            db,
            { ...authority, acceptedActionId: call.callId },
            {
              ...options,
              transport,
              environment,
              ...(outputWindowBytes === undefined ? {} : { outputWindowBytes }),
            },
            call,
            (accepted, operation) =>
              invocation.run(
                {
                  session: accepted,
                  operation,
                  ...(details.signal ? { signal: details.signal } : {}),
                },
                async () => {
                  const output = await invoke(context, input, details);
                  const state = invocation.getStore()!;
                  if (state.failure) throw state.failure.error;
                  if (state.imageFailure !== undefined) return state.imageFailure;
                  if (typeof output !== "string")
                    throw new JournalBindingError("Sandbox tool result must be a retained string");
                  return output;
                },
              ),
            outputPolicy,
          );
        },
      };
    });
  const transport: SessionOptions["transport"] = {
    exec: (request) => {
      const signal = invocation.getStore()?.signal;
      signal?.throwIfAborted();
      return options.transport.exec({
        ...request,
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
          ...(request.signal ? [request.signal] : []),
        ]),
      });
    },
  };
  const capability = shell({
    // An uncertain start cannot be turned into a successful retry instruction
    // and acknowledged as the call's durable result by the SDK error wrapper.
    execCommandErrorFunction: (_context, error) => {
      throw error;
    },
    configureTools: (sdkTools) => {
      // The SDK shell only exposes stdin for PTYs, and its stdin error wrapper
      // renders uncertainty as retry advice. Native pipe commands also need
      // polling. Use the supported tool factory with an explicit error policy.
      const background = options.backgroundCommands;
      const originalExec = sdkTools.find(
        (tool) => tool.type === "function" && tool.name === "exec_command",
      );
      if (background && originalExec?.type !== "function")
        throw new JournalBindingError("Native background commands require the ordinary shell tool");
      const commandParameters = z.object({
        command_id: z.string().uuid(),
        cursor: z.string().min(1).max(128).optional(),
        max_output_bytes: z.number().int().min(4).max(65_536).default(16_384),
      });
      const commandInput = (args: z.infer<typeof commandParameters>) => ({
        commandId: args.command_id,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        maxOutputBytes: args.max_output_bytes,
      });
      const tools = [
        ...sdkTools.filter(
          (tool) =>
            tool.type !== "function" ||
            (tool.name !== "write_stdin" && (!background || tool.name !== "exec_command")),
        ),
        ...(background
          ? [
              sdkTool({
                name: "exec_command",
                description:
                  "Runs a shell command. Set background=true for a retained job that can continue after the turn; use command_read, command_wait and command_cancel with its commandId. Background jobs have no PTY or stdin.",
                parameters: z.object({
                  cmd: z.string().min(1),
                  workdir: z.string().optional(),
                  shell: z.string().optional(),
                  login: z.boolean().default(true),
                  tty: z.boolean().default(false),
                  yield_time_ms: z.number().int().min(0).default(10_000),
                  max_output_tokens: z.number().int().min(1).optional(),
                  background: z.boolean().default(false),
                }),
                errorFunction: (_context, error) => {
                  throw error;
                },
                execute: async (args, context, details) => {
                  current();
                  if (!context || !details?.toolCall)
                    throw new JournalBindingError("Missing accepted command input or context");
                  if (!args.background) {
                    if (originalExec?.type !== "function")
                      throw new JournalBindingError("Ordinary shell tool unavailable");
                    return originalExec.invoke(context, details.toolCall.arguments, details);
                  }
                  return JSON.stringify(
                    await background.start(
                      details.toolCall.callId,
                      {
                        cmd: args.cmd,
                        ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
                        ...(args.shell === undefined ? {} : { shell: args.shell }),
                        login: args.login,
                        tty: args.tty,
                        yieldTimeMs: args.yield_time_ms,
                        ...(args.max_output_tokens === undefined
                          ? {}
                          : { maxOutputTokens: args.max_output_tokens }),
                      },
                      details.signal,
                    ),
                  );
                },
              }),
              sdkTool({
                name: "command_read",
                description: "Reads retained background job output and status from a cursor.",
                parameters: commandParameters,
                errorFunction: (_context, error) => {
                  throw error;
                },
                execute: async (args, _context, details) => {
                  current();
                  return JSON.stringify(await background.read(commandInput(args), details?.signal));
                },
              }),
              sdkTool({
                name: "command_wait",
                description:
                  "Waits up to 50 seconds for background job output or completion, then returns a retained page and cursor.",
                parameters: commandParameters.extend({
                  wait_ms: z.number().int().min(0).max(50_000).default(10_000),
                }),
                errorFunction: (_context, error) => {
                  throw error;
                },
                execute: async (args, _context, details) => {
                  current();
                  return JSON.stringify(
                    await background.wait(
                      { ...commandInput(args), waitMs: args.wait_ms },
                      details?.signal,
                    ),
                  );
                },
              }),
              sdkTool({
                name: "command_cancel",
                description:
                  "Requests cancellation of one retained background job; output and physical completion remain observable.",
                parameters: commandParameters,
                errorFunction: (_context, error) => {
                  throw error;
                },
                execute: async (args, _context, details) => {
                  current();
                  return JSON.stringify(
                    await background.cancel(commandInput(args), details?.signal),
                  );
                },
              }),
            ]
          : []),
        sdkTool({
          name: "write_stdin",
          description:
            "Polls a retained command or writes to its stdin; returns output and current status.",
          parameters: z.object({
            session_id: z.number().int().min(1),
            chars: z.string().default(""),
            yield_time_ms: z.number().int().min(0).default(250),
            max_output_tokens: z.number().int().min(1).optional(),
          }),
          errorFunction: (_context, error) => {
            throw error;
          },
          execute: async (args) =>
            session.writeStdin!({
              sessionId: args.session_id,
              chars: args.chars,
              yieldTimeMs: args.yield_time_ms,
              ...(args.max_output_tokens !== undefined
                ? { maxOutputTokens: args.max_output_tokens }
                : {}),
            }),
        }),
      ];
      return retainTools(tools);
    },
  });
  if (options.backgroundCommands) {
    const bindRunAs = capability.bindRunAs;
    capability.bindRunAs = function (runAs) {
      if (runAs)
        throw new JournalBindingError("Background command alternate user ownership is unavailable");
      return bindRunAs.call(this, runAs);
    };
    const instructions = capability.instructions;
    capability.instructions = function () {
      return (
        instructions.call(this) +
        "\nUse background=true only for work that should continue after this turn. Retain its commandId; command_read, command_wait and command_cancel accept that UUID. write_stdin uses foreground session IDs."
      );
    };
  }
  const filesystemCapability = filesystem({
    configureTools: (tools) => {
      const original = tools.find(
        (tool) => tool.type === "function" && tool.name === "apply_patch",
      );
      if (original?.type !== "function")
        throw new JournalBindingError("Native text editing requires function tool transport");
      // Exactly one structured operation per accepted call gives every read,
      // publication and stdin action a fixed causal key. The SDK still parses
      // and renders its own editor result.
      const restricted = sdkTool({
        name: "apply_patch",
        description:
          "Applies one structured create, update, move, or delete operation to a UTF-8 workspace file (maximum 128 KiB).",
        parameters: patchParameters,
        errorFunction: (_context, error) => {
          throw error;
        },
        execute: async (args, context, details) => {
          // Validation does not rewrite the registered accepted call. The SDK
          // receives the same original input after strict shape validation.
          const input = details?.toolCall?.arguments;
          if (typeof input !== "string" || !context)
            throw new JournalBindingError("Missing accepted patch input or context");
          patchParameters.parse(args);
          return await original.invoke(context, input, details);
        },
      });
      // File editing needs no broker environment. The helper receives only its
      // immutable file payload; even a fresh edit must not resolve credentials.
      const originalImage = tools.find(
        (tool) => tool.type === "function" && tool.name === "view_image",
      );
      if (originalImage?.type !== "function")
        throw new JournalBindingError("Native images require function tool transport");
      const imageParameters = z.object({ path: patchPath }).strict();
      const imageTool = sdkTool({
        name: "view_image",
        description:
          "Views a PNG, JPEG or WebP workspace file (maximum 2 MiB). Returns the retained original pixels on replay.",
        parameters: imageParameters,
        errorFunction: (_context, error) => {
          throw error;
        },
        execute: async (args, context, details) => {
          const input = details?.toolCall?.arguments;
          if (typeof input !== "string" || !context)
            throw new JournalBindingError("Missing accepted image input or context");
          imageParameters.parse(args);
          return await originalImage.invoke(context, input, details);
        },
      });
      return [
        ...retainTools([restricted], async () => ({})),
        ...retainTools([imageTool], async () => ({}), SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES),
      ];
    },
  });
  // Match the runtime's function-transport rule. Use `this`: SDK cloning must
  // preserve the clone's bound editor and runAs rather than return the original.
  filesystemCapability.bindModel = function () {
    (this as unknown as Record<string, unknown>)._modelInstance = undefined;
    return this;
  };
  return {
    session,
    capability,
    filesystemCapability,
    files: preparedFiles,
    repositories: preparedRepositories,
    ...(options.authorizeResources ? { authorizeResources: options.authorizeResources } : {}),
    capabilities: options.capabilities.stdin ? [capability, filesystemCapability] : [capability],
  };
}
