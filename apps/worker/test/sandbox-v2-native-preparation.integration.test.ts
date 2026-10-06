import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  functionCall,
  ScriptedModel,
  testSettings,
  MemoryEventBus,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  allocateSandboxV2BackgroundOperation,
  abandonSandboxJournalOperation,
  assertSandboxJournalCommand,
  assertSandboxJournalControl,
  reserveSandboxJournalCommand,
  loadSandboxV2BackgroundCommandForControl,
  listPendingSandboxJournalCommands,
  readSandboxJournalAttemptWriters,
  requestSandboxV2BackgroundExpiredCredentialCancellation,
  claimSessionWorkForAttempt,
  commitSessionAttemptQuiescence,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createRig,
  createRigVersion,
  createVariableSet,
  createSession,
  createFileUpload,
  completeFileUpload,
  encryptEnvironmentValue,
  findSandboxMachine,
  initializeSessionStartAtomically,
  listSessionEvents,
  listSkillDescriptors,
  loadSandboxJournalToolReply,
  loadSandboxV2PreparationPlan,
  settleSessionAttemptInterruptions,
  submitHumanPromptInTransaction,
  updateWorkspaceSettings,
  upsertWorkspaceCredentialProvider,
  withWorkspaceSubjectSessionActivityRls,
  type SessionActivityDatabase,
  type SandboxV2BackgroundCommandAuthority,
  type SandboxV2BackgroundCredentialAuthority,
} from "@opengeni/db";
import {
  buildOpenGeniAgent,
  createProductionAgentRuntime,
  runAgentStream,
  repositoryCloneCommand,
  preparedCompactionRequest,
  resolveTurnModel,
} from "@opengeni/runtime";
import {
  DockerMachineBackend,
  MachineController,
  MachineJournalClient,
  JournalStartRequest,
  runCredentialRoot,
  withRunCredentialEnvironment,
} from "@opengeni/runtime/sandbox";
import {
  createSandboxV2MachineStore,
  executeSandboxV2SetupStep,
  saveSkill,
  installSandboxV2BackgroundCredentialGeneration,
  reconcileSandboxV2BackgroundGuestCredentialCleanup,
  createSandboxV2BackgroundCommandController,
  retainSandboxV2BackgroundControlOwner,
  reconcileSandboxV2BackgroundJobs,
  reconcileSandboxV2MachineCommands,
} from "@opengeni/core";
import { mutateSessionControlInTransaction } from "../../../packages/db/src/session-control";
import {
  readSessionBackgroundCommandOutput,
  requestSessionBackgroundCommandCancellation,
} from "@opengeni/db/session-background-commands";
import type {
  ConnectionCredentialsPort,
  CredentialProviderRequest,
  Session,
  SessionTurn,
  RepositoryResourceRef,
} from "@opengeni/contracts";
import { prepareNativeTurnSandbox } from "../src/activities/agent-turn/native-preparation";
import { createTurnMediaArtifacts } from "../src/activities/agent-turn/media-artifacts";
import { retainGeneratedImage } from "../src/activities/generated-images";
import { createNativeTurnWorkspaceChannel } from "../src/activities/agent-turn/native-workspace";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import { createSandboxV2ControlActivities } from "../src/activities/sandbox-v2";
import type { ControlActivityServices } from "../src/activities/types";
import { createActivityTestHarness } from "../src/activities";
import { createSandboxV2RunCredentialOwner } from "../src/sandbox-v2-run-credentials";
import { REFRESH_CREDENTIALS_TOOL_NAME } from "../src/activities/agent-turn/refresh-credentials";
import { createSandboxV2TurnShell } from "../src/sandbox-v2-turn";
import { verifyCredentialProviderRequest } from "../../../packages/sdk/src/workspace-integrations";

const image = process.env.JOURNAL_CONFORMANCE_IMAGE;
const SYNTHETIC_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function exerciseNativePreparation(failMint: boolean) {
  const fixture = await acquireSharedTestDatabase("native-main-preparation");
  if (!fixture) throw Error("Native preparation requires disposable PostgreSQL");
  const client = createDb(fixture.appUrl);
  let ownedMachineId: string | undefined;
  let localOwner: ReturnType<typeof createTurnContext>["sandboxState"]["nativeTurn"];
  let jobCustody:
    | { authority: SandboxV2BackgroundCredentialAuthority; root: string; versionName: string }
    | undefined;
  let runningJob:
    | {
        custody: NonNullable<typeof jobCustody>;
        controller: ReturnType<typeof createSandboxV2BackgroundCommandController>;
        setAllowed: (value: boolean) => void;
        ioCount: () => number;
        expiresAt: number;
        recover: (cleanup?: boolean) => ReturnType<typeof reconcileSandboxV2BackgroundJobs>;
        authorizeJob: () => Promise<void>;
      }
    | undefined;
  const sdkCompletedJobs: string[] = [];
  let repositoryResource: RepositoryResourceRef | undefined;
  let sdkRunTool:
    | ((name: string, args: Record<string, unknown>, callId: string) => Promise<string>)
    | undefined;
  const docker = async (args: string[]) => {
    const process = Bun.spawn(["docker", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => process.kill("SIGKILL"), 25_000);
    try {
      const [output, code] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      if (code !== 0) throw Error("Owned native preparation fixture command failed");
      return output.trim();
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    configureSandboxV2AdmissionPolicy(client.db, {
      enabled: true,
      qualifiedBackends: new Set(["docker"]),
    });
    const suffix = crypto.randomUUID();
    const repositoryOrigin = `/tmp/synthetic-native-repository-${suffix}`;
    const repositoryUri = "https://repository.example.test/owner/project.git";
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Synthetic native turn",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Synthetic native turn",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: true });
    const target = { id: "synthetic-remote", url: "https://mcp.example.test/" };
    const settings = testSettings({
      sandboxBackend: "none",
      sandboxV2Enabled: false,
      environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
      mcpServers: [{ ...target, cacheToolsList: false }],
    });
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "docker",
      mcpServers: [target],
    });
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "synthetic native preparation",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    const dispatch = {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" as const },
    };
    const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, dispatch);
    if (claimed.action !== "claimed") throw Error("Synthetic native attempt was not claimed");
    const machine = await findSandboxMachine(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
    });
    if (!machine) throw Error("Synthetic native machine was not admitted");
    ownedMachineId = machine.id;
    const backend = new DockerMachineBackend({
      image: await docker(["image", "inspect", "--format", "{{.Id}}", image!]),
      networkMode: "none",
      memoryLimitBytes: 256 * 1024 ** 2,
      cpuLimit: 0.5,
    });
    let workerIo = 0;
    const workerForJob = (
      authorize?: (job: SandboxV2BackgroundCredentialAuthority) => Promise<void>,
    ) =>
      createSandboxV2ControlActivities(
        async () =>
          ({
            db: client.db,
            settings,
            bus: new MemoryEventBus(),
            sandboxV2ControlProviders: new Map([
              [
                backend.provider,
                {
                  backend,
                  transport: {
                    exec: (request: Parameters<typeof backend.transport.exec>[0]) => {
                      workerIo++;
                      return backend.transport.exec(request);
                    },
                  },
                  ...(authorize ? { authorizeBackgroundJobControl: authorize } : {}),
                },
              ],
            ]),
          }) as unknown as ControlActivityServices,
      );
    let starts = 0;
    let providerIo = 0;
    let imageReadGrantAfterIo: number | undefined;
    let generatedImageDeliveryAllowed = true;
    let sdkJobAllowed = true;
    const providers = new Map([
      [
        "docker",
        {
          backend,
          fileDownloadAudience: "public" as const,
          transport: {
            exec: async (input: Parameters<typeof backend.transport.exec>[0]) => {
              providerIo++;
              if (input.argv.includes("start")) starts++;
              return backend.transport.exec(input);
            },
          },
          ...(!failMint
            ? {
                authorizeBackgroundJobControl: async (
                  authority: SandboxV2BackgroundCredentialAuthority,
                ) => {
                  if (!sdkJobAllowed) throw Error("Synthetic current job permission withdrawn");
                  expect(authority).toMatchObject({
                    accountId: grant.accountId,
                    workspaceId,
                    sessionId: session.id,
                    attemptId: dispatch.attemptId,
                  });
                },
              }
            : {}),
        },
      ],
    ]);
    let mints = 0;
    let authorizations = 0;
    let credentialAttemptId = dispatch.attemptId;
    const connectionCredentials: ConnectionCredentialsPort = {
      runCredentialAuthority: {
        identity: "synthetic-native-host",
        authorize: async (request) => {
          authorizations++;
          if (imageReadGrantAfterIo !== undefined && providerIo > imageReadGrantAfterIo)
            throw Error("Synthetic image permission withdrawn after dispatch");
          if (!generatedImageDeliveryAllowed)
            throw Error("Synthetic generated image permission withdrawn");
          expect(request).toMatchObject({
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            attemptId: credentialAttemptId,
            sandboxEngine: "machine-v2",
            machineProvider: "docker",
            effectiveSandboxBackend: "machine-v2",
          });
        },
      },
      runCredentials: async (request) => {
        mints++;
        if (failMint) throw Error("Synthetic ordinary broker unavailable");
        if (
          request.purpose === "provision" &&
          request.attemptId === dispatch.attemptId &&
          mints !== 1
        )
          throw Error("Sealed native recovery must not mint again");
        return {
          status: "ok",
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          environment: { SYNTHETIC_SHARED: "broker" },
          mcp: [{ url: target.url, headers: { Authorization: "synthetic-header" } }],
        };
      },
    };
    const state = createTurnContext({ settings, cancellationRequestedAt: null });
    state.eventing.publish = async () => undefined;
    const deps: Parameters<typeof prepareNativeTurnSandbox>[0] = {
      context: {
        db: client.db,
        settings,
        accountId: grant.accountId,
        workspaceId,
        session: session as unknown as Session,
        turn: claimed.turn as unknown as SessionTurn,
        attemptId: dispatch.attemptId,
        variableSet: null,
        connectionCredentials,
        effectiveTools: [{ kind: "mcp", id: target.id }],
      },
      providers,
      settings,
      objectStorage: null,
      ...state,
      runtimeResources: [],
      workspaceEnvironment: {
        SYNTHETIC_BASE: "base",
        SYNTHETIC_SHARED: "workspace",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${repositoryOrigin}.insteadOf`,
        GIT_CONFIG_VALUE_0: repositoryUri,
      },
      rigVersion: null,
      hasGeneratedVideoInputs: false,
    };
    if (failMint) {
      await expect(prepareNativeTurnSandbox(deps)).rejects.toThrow(
        "Retained run credential generation",
      );
      localOwner = state.sandboxState.nativeTurn;
      expect(localOwner).toBeDefined();
      expect(starts).toBe(0);
      expect(mints).toBe(1);
      await expect(localOwner!.binding.authorizeResources!()).rejects.toThrow("has not completed");
    } else {
      const initial = await prepareNativeTurnSandbox(deps);
      localOwner = state.sandboxState.nativeTurn;
      expect(localOwner).toBeDefined();
      expect(initial.runCredentialResolver).toBeNull();
      expect(initial.sandboxEnvironment).toEqual({});
      expect(initial.runMcpCredentials!.has(target.id)).toBe(true);
      expect(state.sandboxState.resolvedSandbox).toBeNull();
      expect(mints).toBe(1);
      const plan = await loadSandboxV2PreparationPlan(
        client.db,
        localOwner!.machine.authority,
        "normal-turn:v1",
      );
      expect(JSON.stringify(plan)).not.toContain("SYNTHETIC_BASE");
      const sealed = await fixture.admin<
        { ciphertext: string }[]
      >`select ciphertext from sandbox_v2_credential_generations where attempt_id=${dispatch.attemptId}`;
      expect(sealed).toHaveLength(2);
      for (const entry of sealed) expect(entry.ciphertext).not.toContain("synthetic-header");
      const nativeImageOutputs: Array<{ toolName: string; toolCallId: string; output: unknown }> =
        [];
      let lastToolModelInput: unknown;
      const runTool = async (
        name: string,
        args: Record<string, unknown>,
        callId: string,
        machineSandbox = localOwner!.binding,
      ) => {
        const model = new ScriptedModel([
          {
            output: [functionCall(name, args, callId)],
          },
          { output: [assistantMessage("native prepared")] },
        ]);
        const agent = buildOpenGeniAgent(
          settings,
          (machineSandbox.repositories ?? []).map((repository) => ({
            kind: "repository" as const,
            ...repository,
          })),
          {
            model,
            machineSandbox,
            onRetainableSessionImageOutput: async (input) => {
              nativeImageOutputs.push(input);
            },
          },
        );
        const stream = await runAgentStream(agent, "ordinary native turn", settings);
        for await (const event of stream) void event;
        await stream.completed;
        expect(stream.finalOutput).toBe("native prepared");
        lastToolModelInput = model.requests.at(-1)!.input;
        const reply = await loadSandboxJournalToolReply(client.db, {
          ...localOwner!.machine.authority,
          acceptedActionId: callId,
        });
        if (reply === null) throw Error("Synthetic ordinary tool reply unavailable");
        return reply;
      };
      sdkRunTool = runTool;
      const run = async (callId: string) => {
        const reply = await runTool(
          "exec_command",
          {
            cmd: 'test "$SYNTHETIC_BASE" = base && test "$SYNTHETIC_SHARED" = broker && printf prepared',
            yield_time_ms: 1000,
            background: false,
          },
          callId,
        );
        expect(reply).toContain("prepared");
        expect(reply).toContain("Process exited with code 0");
      };
      await run("native-main-call-one");
      const imageProgram = String.raw`
const fs=require("node:fs");
const {deflateSync}=require("node:zlib");
const {createHash}=require("node:crypto");
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
const chunk=(name,data)=>{const type=Buffer.from(name);const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([type,data])),data.length+8);return out;};
const width=320,height=320,stride=width*3+1;
const pixels=Buffer.alloc(stride*height);let state=0x12345678;
for(let y=0;y<height;y++)for(let x=1;x<stride;x++){state^=state<<13;state^=state>>>17;state^=state<<5;pixels[y*stride+x]=state&255;}
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
fs.writeFileSync("/workspace/synthetic-native.png",png);
fs.writeFileSync("/workspace/synthetic-not-image.txt","ordinary text");
fs.writeFileSync("/workspace/synthetic-oversized.png",Buffer.alloc(2*1024*1024+1));
process.stdout.write("image-sha256="+createHash("sha256").update(png).digest("hex"));
`;
      const imageSource = await runTool(
        "exec_command",
        {
          cmd:
            "/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/bun --no-env-file --config=/dev/null --no-addons -e '" +
            imageProgram.replaceAll("'", "'\\''") +
            "'",
          background: false,
          yield_time_ms: 1000,
        },
        "native-sdk-image-source",
      );
      expect(imageSource).toContain("Process exited with code 0");
      const expectedImageHash = /image-sha256=([a-f0-9]{64})/u.exec(imageSource)?.[1];
      expect(expectedImageHash).toBeDefined();
      const beforeImageMints = mints;
      const imageReply = await runTool(
        "view_image",
        { path: "synthetic-native.png" },
        "native-sdk-view-image",
      );
      expect(imageReply.startsWith("data:image/png;base64,")).toBe(true);
      const imageBytes = Buffer.from(imageReply.slice(imageReply.indexOf(",") + 1), "base64");
      expect(imageBytes.length).toBeGreaterThan(256 * 1024);
      expect(createHash("sha256").update(imageBytes).digest("hex")).toBe(expectedImageHash);
      expect(nativeImageOutputs[0]).toMatchObject({
        toolName: "view_image",
        toolCallId: "native-sdk-view-image",
        output: { type: "image" },
      });
      expect(JSON.stringify(lastToolModelInput).includes('"type":"input_image"')).toBe(true);
      expect(mints).toBe(beforeImageMints);
      const beforeWithdrawnRead = providerIo;
      const beforeWithdrawnPixels = nativeImageOutputs.length;
      imageReadGrantAfterIo = beforeWithdrawnRead;
      await expect(
        runTool(
          "view_image",
          { path: "synthetic-native.png" },
          "native-sdk-image-permission-change",
        ),
      ).rejects.toThrow("Synthetic image permission withdrawn after dispatch");
      imageReadGrantAfterIo = undefined;
      expect(providerIo).toBeGreaterThan(beforeWithdrawnRead);
      expect(nativeImageOutputs.length).toBe(beforeWithdrawnPixels);
      expect(
        await loadSandboxJournalToolReply(client.db, {
          ...localOwner!.machine.authority,
          acceptedActionId: "native-sdk-image-permission-change",
        }),
      ).toBeNull();
      const beforePermissionRecovery = providerIo;
      const recoveredImage = await runTool(
        "view_image",
        { path: "synthetic-native.png" },
        "native-sdk-image-permission-change",
      );
      expect(createHash("sha256").update(recoveredImage).digest("hex")).toBe(
        createHash("sha256").update(imageReply).digest("hex"),
      );
      expect(providerIo).toBe(beforePermissionRecovery);
      const beforeTextModel = providerIo;
      const textModel = new ScriptedModel([{ outputText: "text model ready" }]);
      const textAgent = buildOpenGeniAgent(settings, [], {
        model: textModel,
        machineSandbox: localOwner!.binding,
        supportsImageInput: false,
      });
      const textStream = await runAgentStream(textAgent, "ordinary text-only turn", settings);
      for await (const event of textStream) void event;
      await textStream.completed;
      expect(
        preparedCompactionRequest(textAgent).tools.some((tool) => tool.name === "view_image"),
      ).toBe(false);
      expect(providerIo).toBe(beforeTextModel);
      expect(
        await runTool(
          "exec_command",
          { cmd: "printf changed > synthetic-native.png", background: false },
          "native-sdk-image-changed",
        ),
      ).toContain("Process exited with code 0");
      const beforeImageReplay = providerIo;
      const replayedImage = await runTool(
        "view_image",
        { path: "synthetic-native.png" },
        "native-sdk-view-image",
      );
      expect(createHash("sha256").update(replayedImage).digest("hex")).toBe(
        createHash("sha256").update(imageReply).digest("hex"),
      );
      expect(providerIo).toBe(beforeImageReplay);
      expect(nativeImageOutputs[1]).toMatchObject({ output: { type: "image" } });
      await expect(
        runTool("view_image", { path: "synthetic-native.png" }, "native-sdk-view-image", {
          ...localOwner!.binding,
          authorizeResources: async () => {
            throw Error("Synthetic image permission withdrawn");
          },
        }),
      ).rejects.toThrow("Synthetic image permission withdrawn");
      expect(providerIo).toBe(beforeImageReplay);
      expect(
        await runTool(
          "view_image",
          { path: "synthetic-not-image.txt" },
          "native-sdk-view-not-image",
        ),
      ).toContain("File is not a supported PNG, JPEG or WebP image");
      expect(
        await runTool(
          "view_image",
          { path: "synthetic-oversized.png" },
          "native-sdk-view-oversized-image",
        ),
      ).toContain("Image exceeds the 2 MiB limit");
      expect(mints).toBe(beforeImageMints);
      // Ordinary retained artifacts use the native file owner even though the
      // deployment's legacy backend is disabled. The origin is fixture-only;
      // delivery, grants, hashes and command recovery use actual product code.
      const generatedBytes = Buffer.from(SYNTHETIC_PNG_BASE64, "base64");
      await docker([
        "exec",
        "-d",
        localOwner!.machine.authority.instance.id,
        "bun",
        "-e",
        `Bun.serve({hostname:"127.0.0.1",port:45872,fetch(){return new Response(Buffer.from("${SYNTHETIC_PNG_BASE64}","base64"));}});`,
      ]);
      for (let i = 0; i < 50; i++) {
        try {
          await docker([
            "exec",
            localOwner!.machine.authority.instance.id,
            "curl",
            "--fail",
            "--silent",
            "http://127.0.0.1:45872/health",
          ]);
          break;
        } catch {
          await Bun.sleep(20);
        }
      }
      const generatedObjects = new Map<string, Uint8Array>();
      let generatedUrls = 0;
      let generatedDeferred = 0;
      const generatedStorage = {
        bucket: "synthetic-generated-images",
        fileExists: async (file) => generatedObjects.has(file.objectKey),
        putObject: async ({ key, body, sha256 }) => {
          expect(createHash("sha256").update(body).digest("hex")).toBe(sha256!);
          generatedObjects.set(key, new Uint8Array(body));
        },
        getObjectBytes: async (key) => {
          const bytes = generatedObjects.get(key);
          return bytes ? { bytes: new Uint8Array(bytes), contentType: "image/png" } : null;
        },
        createGetUrl: async ({ key, audience }) => {
          expect(generatedObjects.has(key)).toBe(true);
          expect(audience).toBe("public");
          generatedUrls++;
          return {
            url: `http://127.0.0.1:45872/image?signature=synthetic&request=${generatedUrls}`,
            expiresAt: new Date(Date.now() + 60_000),
          };
        },
      } as NonNullable<Parameters<typeof createTurnMediaArtifacts>[0]["objectStorage"]>;
      const generatedMediaDeps: Parameters<typeof createTurnMediaArtifacts>[0] = {
        db: client.db,
        objectStorage: generatedStorage,
        observability: {
          warn: () => {
            generatedDeferred++;
          },
        } as Parameters<typeof createTurnMediaArtifacts>[0]["observability"],
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        attemptId: dispatch.attemptId,
        getTurnId: () => claimed.turn.id,
        getModelRunSettings: () => settings,
        getPublish: () => state.eventing.publish,
        toolCancellationFenceRef: state.eventing.toolCancellationFenceRef,
        getResolvedSandbox: () => state.sandboxState.resolvedSandbox,
        getSetupBoxSession: () => state.sandboxState.setupBoxSession,
        getNativeTurn: () => state.sandboxState.nativeTurn,
        getSandboxGroupId: () => session.sandboxGroupId,
        runWorkspaceMutation: async () => {
          throw Error("Native generated image cannot borrow a legacy mutation owner");
        },
      };
      const generatedMedia = createTurnMediaArtifacts(generatedMediaDeps);
      generatedMedia.nativeImageGenerationRetention = {
        providerId: "synthetic-image-provider",
        providerBindingHash: "c".repeat(64),
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId: dispatch.attemptId,
      };
      const generated = await generatedMedia.retainNativeGeneratedImage({
        toolCallId: "native-generated-image",
        providerItemId: "synthetic-generated-item",
        bytes: generatedBytes,
      });
      expect(generatedDeferred).toBe(0);
      expect(generatedUrls).toBe(1);
      expect(mints).toBe(beforeImageMints);
      expect(
        await runTool(
          "exec_command",
          { cmd: `sha256sum '${generated.sandboxPath}'`, background: false },
          "native-generated-image-delivered",
        ),
      ).toContain(generated.artifact.sha256);
      const generatedPlan = await loadSandboxV2PreparationPlan(
        client.db,
        localOwner!.machine.authority,
        `generated-image:v1:${generated.artifact.artifactId}`,
      );
      expect(generatedPlan?.files[0]).toMatchObject({
        fileId: generated.artifact.artifactId,
        mountPath: "generated-images",
        sha256: generated.artifact.sha256,
        sizeBytes: generatedBytes.length,
      });
      expect(JSON.stringify(generatedPlan)).not.toContain("signature=synthetic");
      const beforeGeneratedRecovery = providerIo;
      expect(
        await createTurnMediaArtifacts(generatedMediaDeps).materializeGeneratedImage(generated),
      ).toBe(true);
      expect(providerIo).toBe(beforeGeneratedRecovery);
      expect(generatedUrls).toBe(1);
      // The original supplied current authority precedes completed recovery too.
      generatedImageDeliveryAllowed = false;
      expect(await generatedMedia.materializeGeneratedImage(generated)).toBe(false);
      expect(generatedDeferred).toBe(1);
      expect(providerIo).toBe(beforeGeneratedRecovery);
      expect(generatedUrls).toBe(1);
      generatedImageDeliveryAllowed = true;
      expect(await generatedMedia.materializeGeneratedImage(generated)).toBe(true);
      expect(providerIo).toBe(beforeGeneratedRecovery);
      const freshGenerated = await retainGeneratedImage({
        db: client.db,
        objectStorage: generatedStorage,
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId: dispatch.attemptId,
        sourceStrategy: "native_hosted",
        providerId: "synthetic-image-provider",
        providerBindingHash: "c".repeat(64),
        output: {
          toolCallId: "native-generated-image-fresh",
          providerItemId: "synthetic-generated-fresh-item",
          bytes: generatedBytes,
        },
      });
      generatedImageDeliveryAllowed = false;
      expect(await generatedMedia.materializeGeneratedImage(freshGenerated.receipt)).toBe(false);
      expect(generatedDeferred).toBe(2);
      expect(providerIo).toBe(beforeGeneratedRecovery);
      expect(generatedUrls).toBe(1);
      expect(
        await loadSandboxV2PreparationPlan(
          client.db,
          localOwner!.machine.authority,
          `generated-image:v1:${freshGenerated.receipt.artifact.artifactId}`,
        ),
      ).toBeNull();
      generatedImageDeliveryAllowed = true;
      expect(await generatedMedia.materializeGeneratedImage(freshGenerated.receipt)).toBe(true);
      expect(generatedUrls).toBe(2);
      expect(
        await runTool(
          "exec_command",
          {
            cmd: `chmod u+w '${generated.sandboxPath}' && printf changed > '${generated.sandboxPath}'`,
            background: false,
          },
          "native-generated-image-workspace-edit",
        ),
      ).toContain("Process exited with code 0");
      const beforeGeneratedEditReplay = providerIo;
      expect(await generatedMedia.materializeGeneratedImage(generated)).toBe(true);
      expect(providerIo).toBe(beforeGeneratedEditReplay);
      expect(generatedUrls).toBe(2);
      expect(
        await runTool(
          "exec_command",
          { cmd: `cat '${generated.sandboxPath}'`, background: false },
          "native-generated-image-preserved-edit",
        ),
      ).toContain("changed");
      // The ordinary hosted callback may be repeated after initial delivery
      // was deferred. It must recover placement without another image write.
      const deferredGeneratedOutput = {
        toolCallId: "native-generated-image-deferred",
        providerItemId: "synthetic-generated-deferred-item",
        bytes: generatedBytes,
      };
      generatedImageDeliveryAllowed = false;
      const beforeDeferredGenerated = providerIo;
      const deferredGenerated =
        await generatedMedia.retainNativeGeneratedImage(deferredGeneratedOutput);
      expect(providerIo).toBe(beforeDeferredGenerated);
      expect(generatedUrls).toBe(2);
      expect(generatedObjects.size).toBe(3);
      expect(
        await loadSandboxV2PreparationPlan(
          client.db,
          localOwner!.machine.authority,
          `generated-image:v1:${deferredGenerated.artifact.artifactId}`,
        ),
      ).toBeNull();
      generatedImageDeliveryAllowed = true;
      expect(await generatedMedia.retainNativeGeneratedImage(deferredGeneratedOutput)).toEqual(
        deferredGenerated,
      );
      expect(generatedObjects.size).toBe(3);
      expect(generatedUrls).toBe(3);
      expect(
        await docker([
          "exec",
          localOwner!.machine.authority.instance.id,
          "sha256sum",
          deferredGenerated.sandboxPath,
        ]),
      ).toContain(deferredGenerated.artifact.sha256);
      const beforeDeferredGeneratedReplay = providerIo;
      expect(await generatedMedia.retainNativeGeneratedImage(deferredGeneratedOutput)).toEqual(
        deferredGenerated,
      );
      expect(providerIo).toBe(beforeDeferredGeneratedReplay);
      expect(generatedUrls).toBe(3);
      expect(mints).toBe(beforeImageMints);
      expect(
        await runTool(
          "exec_command",
          {
            cmd: [
              `git init --quiet --initial-branch=main ${repositoryOrigin}`,
              `printf '%s\\n' 'export const marker = "original";' > ${repositoryOrigin}/example.ts`,
              `git -C ${repositoryOrigin} add example.ts`,
              `git -C ${repositoryOrigin} -c user.name=Synthetic -c user.email=fixture@example.test commit --quiet --message=initial`,
            ].join(" && "),
            background: false,
            yield_time_ms: 1000,
          },
          "native-repository-source",
        ),
      ).toContain("Process exited with code 0");
      repositoryResource = {
        kind: "repository",
        uri: repositoryUri,
        ref: "main",
        mountPath: "project",
        expectedCommitSha: await docker([
          "exec",
          localOwner!.machine.authority.instance.id,
          "git",
          "-C",
          repositoryOrigin,
          "rev-parse",
          "HEAD",
        ]),
      };
      const turnScopedShell = createSandboxV2TurnShell(client.db, localOwner!.machine, {
        environment: async () => ({}),
        authorizeResources: localOwner!.binding.authorizeResources!,
      });
      const beforeUnsupportedBackground = providerIo;
      await expect(
        runTool(
          "exec_command",
          { cmd: "printf unsupported-background", background: true },
          "native-sdk-background-owner-unavailable",
          {
            ...localOwner!.binding,
            session: turnScopedShell.session,
            capabilities: turnScopedShell.capabilities,
          },
        ),
      ).rejects.toThrow("Independent background command ownership is unavailable");
      expect(providerIo).toBe(beforeUnsupportedBackground);
      expect(localOwner!.machine.capabilities.pty).toBe(true);
      const ptyReply = await runTool(
        "exec_command",
        {
          cmd: 'test -t 0 && test -t 1 && stty size && printf "pty-ready\\n"; IFS= read -r answer; printf "pty-result:%s\\n" "$answer"',
          shell: "/bin/bash",
          login: false,
          tty: true,
          background: false,
          yield_time_ms: 1000,
        },
        "native-sdk-foreground-pty",
      );
      expect(ptyReply).toContain("24 80");
      expect(ptyReply).toContain("pty-ready");
      const ptyId = Number(/Process running with session ID (\d+)/u.exec(ptyReply)?.[1]);
      expect(Number.isSafeInteger(ptyId) && ptyId > 0).toBe(true);
      const ptyInput = { session_id: ptyId, chars: "sdk-pty-input\n", yield_time_ms: 1000 };
      const ptyInputReply = await runTool(
        "write_stdin",
        ptyInput,
        "native-sdk-foreground-pty-input",
      );
      expect(ptyInputReply).toContain("pty-result:sdk-pty-input");
      expect(ptyInputReply).toContain("Process exited with code 0");
      const beforePtyReplay = providerIo;
      expect(await runTool("write_stdin", ptyInput, "native-sdk-foreground-pty-input")).toBe(
        ptyInputReply,
      );
      expect(providerIo).toBe(beforePtyReplay);
      const [beforeUnsupportedPty] = await fixture.admin<{ count: number }[]>`
        select count(*)::integer as count from session_background_commands where session_id=${session.id}`;
      await expect(
        runTool(
          "exec_command",
          { cmd: "printf unsupported-pty", tty: true, background: true },
          "native-sdk-background-pty-unavailable",
        ),
      ).rejects.toThrow("Background command PTY and alternate user ownership are unavailable");
      expect(providerIo).toBe(beforePtyReplay);
      const [afterUnsupportedPty] = await fixture.admin<{ count: number }[]>`
        select count(*)::integer as count from session_background_commands where session_id=${session.id}`;
      expect(afterUnsupportedPty).toEqual(beforeUnsupportedPty);
      const workspaceContext = {
        operationId: crypto.randomUUID(),
        requestDigest: createHash("sha256")
          .update("synthetic compound workspace request")
          .digest("hex"),
        sourceCallId: "native-workspace-recovery",
        caller: { kind: "model" as const, subjectId: grant.subjectId },
      };
      const workspace = () =>
        createNativeTurnWorkspaceChannel(client.db, localOwner!, workspaceContext);
      const write = {
        directory: "synthetic-recovery",
        files: [
          { path: "note.txt", content: "original workspace bytes", encoding: "utf8" as const },
        ],
      };
      const list = { path: "synthetic-recovery", depth: 1, maxEntries: 10, includeHidden: true };
      const read = {
        path: "synthetic-recovery/note.txt",
        encoding: "utf8" as const,
        maxBytes: 128,
      };
      expect((await workspace().fsWriteFiles(write)).written).toEqual(["note.txt"]);
      expect((await workspace().fsList(list)).root.children?.[0]?.name).toBe("note.txt");
      expect((await workspace().fsRead(read)).content).toBe("original workspace bytes");
      const beforeWorkspaceRecovery = starts;
      expect((await workspace().fsWriteFiles(write)).written).toEqual(["note.txt"]);
      expect((await workspace().fsList(list)).root.children?.[0]?.name).toBe("note.txt");
      expect((await workspace().fsRead(read)).content).toBe("original workspace bytes");
      expect(starts).toBe(beforeWorkspaceRecovery);
      await expect(
        createNativeTurnWorkspaceChannel(client.db, localOwner!, {
          ...workspaceContext,
          requestDigest: "a".repeat(64),
        }).fsRead({ ...read, path: "synthetic-recovery/changed.txt" }),
      ).rejects.toThrow("temporarily unavailable");
      await expect(
        createNativeTurnWorkspaceChannel(client.db, localOwner!, workspaceContext, {
          sourceSnapshotDigest: "b".repeat(64),
        }).fsRead({ ...read, path: "synthetic-recovery/added.txt" }),
      ).rejects.toThrow("temporarily unavailable");
      expect(starts).toBe(beforeWorkspaceRecovery);
      expect(
        (
          await loadSandboxV2PreparationPlan(
            client.db,
            localOwner!.machine.authority,
            `workspace-operation:v1:${workspaceContext.operationId}`,
          )
        )?.workspaceOperation,
      ).toEqual({
        operationId: workspaceContext.operationId,
        requestDigest: workspaceContext.requestDigest,
      });
      const revokedWorkspace = createNativeTurnWorkspaceChannel(
        client.db,
        {
          ...localOwner!,
          binding: {
            ...localOwner!.binding,
            authorizeResources: async () => {
              throw new Error("Synthetic current file grant withdrawn");
            },
          },
        },
        workspaceContext,
      );
      await expect(revokedWorkspace.fsRead(read)).rejects.toThrow("temporarily unavailable");
      expect(starts).toBe(beforeWorkspaceRecovery);
      const large = "ordinary retained stdin\n".repeat(4_000);
      await workspace().fsWrite({
        path: "synthetic-recovery/large.txt",
        content: large,
        encoding: "utf8",
        overwrite: false,
        createParents: true,
      });
      expect(
        await docker([
          "exec",
          `opengeni-v2-${ownedMachineId}`,
          "cat",
          "/workspace/synthetic-recovery/large.txt",
        ]),
      ).toBe(large.trim());
      await localOwner!.closeAndDrain();
      const beforeReplay = starts;
      const recovered = await prepareNativeTurnSandbox({
        ...deps,
        workspaceEnvironment: { SYNTHETIC_BASE: "changed" },
      });
      localOwner = state.sandboxState.nativeTurn;
      expect(starts).toBe(beforeReplay);
      expect(mints).toBe(1);
      expect(recovered.runMcpCredentials!.has(target.id)).toBe(true);
      const replacementCredentials = createSandboxV2RunCredentialOwner(
        deps.context,
        localOwner!.machine,
        plan!,
        {
          environment: async () => ({}),
          workspaceEnvironment: { SYNTHETIC_BASE: "changed", SYNTHETIC_SHARED: "changed" },
        },
      );
      const originalJobSource = await replacementCredentials.renew(plan!.credentialGenerationId!);
      expect(mints).toBe(2);
      await run("native-main-call-two");
      // Exercise the ordinary SDK tool boundary, including its durable reply
      // replay and cached output after actual per-job credential cleanup.
      for (const [label, cmd] of [
        [
          "completed",
          'test "$SYNTHETIC_BASE" = base && test "$SYNTHETIC_SHARED" = broker && printf "€€€sdk-background"',
        ],
        ["cancelled", "printf sdk-cancellation; sleep 120"],
      ] as const) {
        const launchArgs = { cmd, background: true, yield_time_ms: 0, max_output_tokens: 4096 };
        const launchCall = `native-sdk-background-${label}`;
        const launchReply = await runTool("exec_command", launchArgs, launchCall);
        const launched = JSON.parse(launchReply) as { commandId: string; terminal: boolean };
        sdkCompletedJobs.push(launched.commandId);
        expect(launched.commandId).toMatch(/^[0-9a-f-]{36}$/u);
        const beforeSdkReplay = providerIo;
        expect(await runTool("exec_command", launchArgs, launchCall)).toBe(launchReply);
        expect(providerIo).toBe(beforeSdkReplay);
        expect(mints).toBe(2);
        const commandArgs = { command_id: launched.commandId, max_output_bytes: 65_536 };
        if (label === "cancelled") {
          const runningPage = JSON.parse(
            await runTool("command_read", commandArgs, "native-sdk-running-output"),
          ) as { nextCursor: string; terminal: boolean };
          expect(runningPage.terminal).toBe(false);
          const waitArgs = { ...commandArgs, cursor: runningPage.nextCursor, wait_ms: 100 };
          const idleWait = await runTool("command_wait", waitArgs, "native-sdk-idle-wait");
          expect(JSON.parse(idleWait)).toMatchObject({
            terminal: false,
            state: "running",
            exitCode: null,
            chunks: [],
          });
          const beforeWaitReplay = providerIo;
          expect(await runTool("command_wait", waitArgs, "native-sdk-idle-wait")).toBe(idleWait);
          expect(providerIo).toBe(beforeWaitReplay);
          const beforeInvalidCancel = providerIo;
          await expect(
            runTool(
              "command_cancel",
              { ...commandArgs, cursor: `${crypto.randomUUID()}:0:0` },
              "native-sdk-invalid-cancel-cursor",
            ),
          ).rejects.toThrow("Invalid command output cursor");
          expect(providerIo).toBe(beforeInvalidCancel);
          expect(
            (
              await loadSandboxV2BackgroundCommandForControl(client.db, {
                ...localOwner!.machine.authority,
                jobId: launched.commandId,
              })
            ).state,
          ).toBe("running");
        }
        let page = JSON.parse(
          await runTool(
            label === "cancelled" ? "command_cancel" : "command_read",
            commandArgs,
            `native-sdk-control-${label}`,
          ),
        ) as { terminal: boolean; chunks: { chunk: string }[]; state: string };
        for (let index = 0; index < 30 && !page.terminal; index++) {
          page = JSON.parse(
            await runTool(
              "command_wait",
              { ...commandArgs, wait_ms: 500 },
              `native-sdk-wait-${label}-${index}`,
            ),
          );
        }
        expect(page.terminal).toBe(true);
        expect(page.state).toBe("exited");
        expect(page.chunks.map((chunk) => chunk.chunk).join("")).toContain(
          label === "completed" ? "sdk-background" : "sdk-cancellation",
        );
        if (label === "completed") {
          const tinyPage = JSON.parse(
            await runTool(
              "command_read",
              { ...commandArgs, max_output_bytes: 4 },
              "native-sdk-unicode-first-page",
            ),
          ) as { chunks: { chunk: string }[]; nextCursor: string };
          expect(tinyPage.chunks.map((chunk) => chunk.chunk).join("")).toBe("€");
          const nextTinyPage = JSON.parse(
            await runTool(
              "command_read",
              { ...commandArgs, max_output_bytes: 4, cursor: tinyPage.nextCursor },
              "native-sdk-unicode-next-page",
            ),
          ) as typeof tinyPage;
          expect(nextTinyPage.chunks.map((chunk) => chunk.chunk).join("")).toBe("€");
          expect(nextTinyPage.nextCursor).not.toBe(tinyPage.nextCursor);
        }
        const sdkAuthority = { ...localOwner!.machine.authority, jobId: launched.commandId };
        expect(
          (await loadSandboxV2BackgroundCommandForControl(client.db, sdkAuthority)).independent,
        ).toBe(true);
        let cleanup = await reconcileSandboxV2BackgroundGuestCredentialCleanup(
          client.db,
          sdkAuthority,
          backend.transport,
        );
        for (let index = 0; index < 100 && cleanup.state !== "complete"; index++) {
          await Bun.sleep(25);
          cleanup = await reconcileSandboxV2BackgroundGuestCredentialCleanup(
            client.db,
            sdkAuthority,
            backend.transport,
          );
        }
        expect(cleanup.state).toBe("complete");
        const beforeCachedRead = providerIo;
        const cachedReply = await runTool(
          "command_read",
          commandArgs,
          `native-sdk-cleared-read-${label}`,
        );
        expect(JSON.parse(cachedReply)).toMatchObject({ terminal: true, state: "exited" });
        expect(providerIo).toBe(beforeCachedRead);
        sdkJobAllowed = false;
        const beforeDenied = providerIo;
        await expect(
          runTool("command_read", commandArgs, `native-sdk-denied-read-${label}`),
        ).rejects.toThrow("Synthetic current job permission withdrawn");
        expect(providerIo).toBe(beforeDenied);
        sdkJobAllowed = true;
      }
      const jobContext = {
        ...localOwner!.machine.authority,
        acceptedActionId: "synthetic-background-credential-custody",
      };
      const jobId = await allocateSandboxV2BackgroundOperation(client.db, jobContext, {
        requestDigest: createHash("sha256").update("synthetic reserved job").digest("hex"),
        commandText: "printf ordinary-reserved-job",
      });
      const installed = await installSandboxV2BackgroundCredentialGeneration(
        client.db,
        localOwner!.machine,
        { jobId, generationId: "original-job-generation" },
        {
          encryptionKey: new Uint8Array(32).fill(17),
          authorize: replacementCredentials.authorizeCurrent,
          source: originalJobSource.resolution,
        },
      );
      jobCustody = { ...installed, authority: { ...localOwner!.machine.authority, jobId } };
      const beforeJobReplay = starts;
      expect(
        await installSandboxV2BackgroundCredentialGeneration(
          client.db,
          localOwner!.machine,
          { jobId, generationId: "original-job-generation" },
          {
            encryptionKey: new Uint8Array(32).fill(17),
            authorize: replacementCredentials.authorizeCurrent,
          },
        ),
      ).toEqual(installed);
      expect(starts).toBe(beforeJobReplay);
      expect(mints).toBe(2);
      expect(
        await docker([
          "exec",
          localOwner!.machine.authority.instance.id,
          "stat",
          "--format=%a",
          installed.root,
          `${installed.root}/versions/${installed.versionName}/env`,
        ]),
      ).toBe("700\n600");
      expect(
        (
          await reconcileSandboxV2BackgroundGuestCredentialCleanup(
            client.db,
            jobCustody.authority,
            backend.transport,
          )
        ).state,
      ).toBe("held");
      expect(starts).toBe(beforeJobReplay);
      // This fixture never launches the reserved job. Protected abandonment
      // proves no binding was dispatched; it does not report a physical exit.
      expect(await abandonSandboxJournalOperation(client.db, jobContext, jobId)).toBe(true);
      const runningContext = {
        ...localOwner!.machine.authority,
        acceptedActionId: "synthetic-running-job-control",
      };
      const runningId = await allocateSandboxV2BackgroundOperation(client.db, runningContext, {
        requestDigest: createHash("sha256").update("synthetic running job").digest("hex"),
        commandText: "run synthetic background progress",
      });
      const runningSource = structuredClone(originalJobSource.resolution);
      if (runningSource.status !== "ok") throw Error("Synthetic running job requires material");
      // Shorten this synthetic lease; never extend the issuer's original expiry.
      const runningExpiry = Math.min(
        Date.now() + 30_000,
        runningSource.expiresAt ? Date.parse(runningSource.expiresAt) : Number.POSITIVE_INFINITY,
      );
      runningSource.expiresAt = new Date(runningExpiry).toISOString();
      const runningCredentials = await installSandboxV2BackgroundCredentialGeneration(
        client.db,
        localOwner!.machine,
        { jobId: runningId, generationId: "original-running-job-generation" },
        {
          encryptionKey: new Uint8Array(32).fill(17),
          authorize: replacementCredentials.authorizeCurrent,
          source: runningSource,
        },
      );
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const progress = [
        'import {readFileSync,writeFileSync} from "node:fs";',
        'if(process.env.SYNTHETIC_BASE!=="base"||process.env.SYNTHETIC_SHARED!=="broker") throw Error("Synthetic original job material unavailable");',
        'process.stdout.write("€".repeat(40000));',
        `const ownEnv=${JSON.stringify(`${runningCredentials.root}/versions/${runningCredentials.versionName}/env`)};`,
        'let tick=0; setInterval(()=>{if(!readFileSync(ownEnv,"utf8").includes("SYNTHETIC_SHARED")) throw Error("Synthetic job custody lost"); writeFileSync("/workspace/synthetic-job-progress",String(++tick));},25);',
      ].join("\n");
      const request = JournalStartRequest.parse({
        operationId: runningId,
        bootId: runningContext.instance.bootId,
        diskLineage: runningContext.instance.diskLineage,
        program: "/usr/bin/env",
        args: [
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          `set -a; . ${quote(`${runningCredentials.root}/versions/${runningCredentials.versionName}/env`)}; exec /usr/local/bin/bun --no-env-file --config=/dev/null --no-addons -e ${quote(progress)}`,
        ],
        cwd: "/workspace",
        environment: {},
        stdin: false,
        pty: null,
      });
      const launcher = new MachineJournalClient(
        { machineId: runningContext.machineId, instance: runningContext.instance },
        backend.transport,
        {
          reserve: (command) => reserveSandboxJournalCommand(client.db, runningContext, command),
          assert: (command, action) =>
            assertSandboxJournalCommand(client.db, runningContext, command, action),
        },
        { attempts: 1 },
      );
      let allowed = true;
      let controlIo = 0;
      const authorizeJob = async () => {
        if (!allowed) throw Error("Synthetic current job control grant withdrawn");
      };
      const ownerAuthority = { ...localOwner!.machine.authority, jobId: runningId };
      allowed = false;
      const beforeOwner = starts;
      await expect(
        retainSandboxV2BackgroundControlOwner(client.db, ownerAuthority, {
          authorizeJob,
        }),
      ).rejects.toThrow("current job control grant withdrawn");
      expect(starts).toBe(beforeOwner);
      allowed = true;
      const registeredOwners = await Promise.all(
        Array.from({ length: 3 }, () =>
          retainSandboxV2BackgroundControlOwner(client.db, ownerAuthority, { authorizeJob }),
        ),
      );
      expect(
        registeredOwners.every(
          (owner) =>
            owner.jobId === runningId && owner.generationId === "original-running-job-generation",
        ),
      ).toBe(true);
      const [registered] = await fixture.admin<{ count: number; bound: boolean }[]>`
        select count(*)::integer as count,bool_or(command.binding is not null) as bound
        from sandbox_v2_background_owners owner join sandbox_v2_commands command on command.operation_id=owner.job_id
        where owner.job_id=${runningId}`;
      expect(registered).toEqual({ count: 1, bound: false });
      expect(
        (await readSandboxJournalAttemptWriters(client.db, ownerAuthority)).commands.some(
          (command) => command.operationId === runningId,
        ),
      ).toBe(true);
      expect(starts).toBe(beforeOwner);
      await launcher.start(request);
      expect(
        (await readSandboxJournalAttemptWriters(client.db, ownerAuthority)).commands.some(
          (command) => command.operationId === runningId,
        ),
      ).toBe(false);
      await expect(
        retainSandboxV2BackgroundControlOwner(client.db, ownerAuthority, {
          authorizeJob,
        }),
      ).rejects.toThrow();
      const controlTransport = {
        exec: (input: Parameters<typeof backend.transport.exec>[0]) => {
          controlIo++;
          return backend.transport.exec(input);
        },
      };
      const controller = createSandboxV2BackgroundCommandController(
        client.db,
        { ...localOwner!.machine.authority, jobId: runningId },
        controlTransport,
        {
          authorizeJob,
        },
      );
      runningJob = {
        custody: {
          ...runningCredentials,
          authority: { ...localOwner!.machine.authority, jobId: runningId },
        },
        controller,
        setAllowed: (value) => {
          allowed = value;
        },
        ioCount: () => controlIo,
        authorizeJob,
        expiresAt: runningExpiry,
        recover: (cleanup = false) =>
          reconcileSandboxV2BackgroundJobs(
            client.db,
            {
              accountId: runningContext.accountId,
              workspaceId: runningContext.workspaceId,
              machineId: runningContext.machineId,
            },
            controlTransport,
            {
              limit: 1,
              jobId: runningId,
              cleanup,
              authorizeJob: async (job) => {
                if (job.jobId !== runningId) throw Error("Synthetic job control scope changed");
                await authorizeJob();
              },
            },
          ),
      };
    }
    expect(authorizations).toBeGreaterThan(0);
    if (runningJob) {
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "steer",
            text: "ordinary next prompt",
            resources: [repositoryResource!],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      );
    } else
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
      );
    // Logical interruption closes the exact attempt before normal credential
    // cleanup. An independently preowned bound job keeps its own lifetime.
    if (!runningJob) expect((await localOwner!.finalize()).state).toBe("held");
    expect(
      (
        await settleSessionAttemptInterruptions(
          client.db,
          workspaceId,
          session.id,
          dispatch.attemptId,
        )
      ).action,
    ).toBe(runningJob ? "continue" : "paused");
    let settlement = await localOwner!.finalize();
    for (let i = 0; i < 100 && settlement.state !== "drained"; i++) {
      await Bun.sleep(25);
      settlement = await localOwner!.finalize();
    }
    expect(settlement.state).toBe("drained");
    await commitSessionAttemptQuiescence(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      attemptId: dispatch.attemptId,
      temporalWorkflowId: dispatch.workflowId,
      temporalWorkflowRunId: dispatch.workflowRunId,
      temporalActivityId: dispatch.dispatchId,
      nativeAuthority: localOwner!.machine.authority,
      allowUninterrupted: true,
    });
    const retained = await fixture.admin<
      { ciphertext: string | null }[]
    >`select ciphertext from sandbox_v2_credential_generations where attempt_id=${dispatch.attemptId}`;
    expect(retained.every((entry) => entry.ciphertext === null)).toBe(true);
    if (runningJob) {
      const [origin] = await fixture.admin<{ closed: boolean }[]>`
        select closed_at is not null as closed from session_turn_attempts where id=${dispatch.attemptId}`;
      expect(origin?.closed).toBe(true);
      await docker([
        "exec",
        localOwner!.machine.authority.instance.id,
        "test",
        "!",
        "-e",
        `${runCredentialRoot(session.id)}/current`,
      ]);
      const authority = runningJob.custody.authority;
      const inventoryTenant = {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        machineId: authority.machineId,
      };
      expect(
        (await listPendingSandboxJournalCommands(client.db, inventoryTenant)).items.some(
          (command) => command.operationId === authority.jobId,
        ),
      ).toBe(false);
      const stillRunning = await loadSandboxV2BackgroundCommandForControl(client.db, authority);
      expect(stillRunning.state).toBe("running");
      expect(stillRunning.outputComplete).toBe(false);
      for (const action of ["read", "cancel"] as const)
        await expect(
          assertSandboxJournalControl(client.db, authority, stillRunning.command!.command, action),
        ).rejects.toThrow("requires its independent control owner");
      let genericIo = 0;
      const generic = await reconcileSandboxV2MachineCommands(client.db, inventoryTenant, {
        exec: (request) => {
          genericIo++;
          return backend.transport.exec(request);
        },
      });
      expect(generic.items.some((item) => item.id === authority.jobId)).toBe(false);
      expect(genericIo).toBe(0);
      const workerTarget = {
        ...inventoryTenant,
        sandboxGroupId: session.sandboxGroupId,
        provider: localOwner!.machine.provider,
      };
      expect((await workerForJob().reconcileSandboxV2Machine(workerTarget)).status).toBe(
        "deferred",
      );
      expect(workerIo).toBe(0);
      const nativeJob = runningJob;
      nativeJob.setAllowed(false);
      const deniedWorker = workerForJob(async (job) => {
        if (job.jobId !== authority.jobId) throw Error("Synthetic worker job scope changed");
        await nativeJob.authorizeJob();
      });
      expect((await deniedWorker.reconcileSandboxV2Machine(workerTarget)).status).toBe(
        "reconciled",
      );
      expect(workerIo).toBe(0);
      nativeJob.setAllowed(true);
      const beforeProgress = Number(
        await docker([
          "exec",
          localOwner!.machine.authority.instance.id,
          "cat",
          "/workspace/synthetic-job-progress",
        ]),
      );
      await Bun.sleep(100);
      expect(
        Number(
          await docker([
            "exec",
            localOwner!.machine.authority.instance.id,
            "cat",
            "/workspace/synthetic-job-progress",
          ]),
        ),
      ).toBeGreaterThan(beforeProgress);
      expect(Date.now()).toBeLessThan(runningJob.expiresAt);
      await Bun.sleep(Math.max(0, runningJob.expiresAt - Date.now() + 50));
      expect(
        await requestSandboxV2BackgroundExpiredCredentialCancellation(client.db, authority),
      ).toBe(true);
      const [expiry] = await fixture.admin<{ state: string; reason: string; proved: boolean }[]>`
        select job.state,job.cancel_requested_by as reason,command.proof is not null as proved
        from session_background_commands job join sandbox_v2_commands command on command.operation_id=job.native_operation_id
        where job.id=${authority.jobId}`;
      expect(expiry).toEqual({
        state: "stopping",
        reason: "native_static_credential_expired",
        proved: false,
      });
      runningJob.setAllowed(false);
      const beforeDenied = runningJob.ioCount();
      await expect(runningJob.controller.observe()).rejects.toThrow(
        "current job control grant withdrawn",
      );
      expect(runningJob.ioCount()).toBe(beforeDenied);
      const deferred = await runningJob.recover();
      expect(deferred.items).toEqual([
        { jobId: runningJob.custody.authority.jobId, state: "deferred" },
      ]);
      expect(runningJob.ioCount()).toBe(beforeDenied);
      runningJob.setAllowed(true);
      const recoveredPage = await runningJob.recover();
      expect(recoveredPage.items).toEqual([
        { jobId: runningJob.custody.authority.jobId, state: "held" },
      ]);
      const firstPage = await loadSandboxV2BackgroundCommandForControl(
        client.db,
        runningJob.custody.authority,
      );
      expect(firstPage.command?.stdout.offset).toBe(64 * 1024);
      expect(firstPage.command?.stdout.remainder).not.toBe("");
      let cancelled = await runningJob.controller.cancel();
      for (let index = 0; index < 100 && cancelled.state !== "output_complete"; index++) {
        await Bun.sleep(25);
        cancelled = await runningJob.controller.observe();
      }
      expect(cancelled.state).toBe("output_complete");
      const [terminalJob] = await fixture.admin<{ state: string; events: number }[]>`
        select job.state,(select count(*)::integer from session_events event
          where event.session_id=job.session_id and event.type='session.command.finished'
            and event.payload->>'commandId'=job.id::text) as events
        from session_background_commands job where job.id=${runningJob.custody.authority.jobId}`;
      expect(terminalJob).toEqual({ state: "exited", events: 1 });
      const captures = await fixture.admin<{ stdout: string }[]>`
        select stdout from sandbox_v2_command_output where operation_id=${runningJob.custody.authority.jobId} order by revision`;
      expect(
        captures.map((page) => Buffer.from(page.stdout, "base64").toString("utf8")).join(""),
      ).toBe("€".repeat(40000));
      let outputCursor: string | undefined;
      let ordinaryOutput = "";
      for (let index = 0; index < 20; index++) {
        const page = await readSessionBackgroundCommandOutput(client.db, {
          ...runningJob.custody.authority,
          commandId: runningJob.custody.authority.jobId,
          cursor: outputCursor,
        });
        expect(page.state).toBe("exited");
        expect(page.retention.gaps).toEqual([]);
        ordinaryOutput += page.chunks.map((chunk) => chunk.chunk).join("");
        outputCursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      expect(ordinaryOutput).toBe("€".repeat(40000));
      const beforeRecovery = runningJob.ioCount();
      const recovered = await runningJob.controller.observe();
      expect(recovered.state).toBe("output_complete");
      expect(recovered.events).toEqual([]);
      expect(runningJob.ioCount()).toBe(beforeRecovery);
      expect(mints).toBe(2);
    }
    const allJobCustodies = [jobCustody, runningJob?.custody];
    for (const retiredCustody of allJobCustodies) {
      if (!retiredCustody) continue;
      // The turn's actual cleanup must preserve the independent job pointer.
      await docker([
        "exec",
        localOwner!.machine.authority.instance.id,
        "test",
        "-f",
        `${retiredCustody.root}/versions/${retiredCustody.versionName}/env`,
      ]);
      const [held] = await fixture.admin<
        { ciphertext: string | null; demand: boolean }[]
      >`select credentials.ciphertext,
        machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
          'id',credentials.cleanup_operation_id::text,'kind','command',
          'owner',credentials.session_id::text,'authority',credentials.job_id::text)) as demand
        from sandbox_v2_background_credentials credentials
        join sandbox_v2_machines machine on machine.id=credentials.machine_id
        where credentials.job_id=${retiredCustody.authority.jobId}`;
      expect(held?.ciphertext).not.toBeNull();
      expect(held?.demand).toBe(true);
      if (retiredCustody.authority.jobId !== runningJob?.custody.authority.jobId) {
        // Sealed custody without a completed independent registration must
        // remain discoverable after original preparation/observer failure.
        const recoverOriginal = () =>
          reconcileSandboxV2BackgroundJobs(
            client.db,
            {
              accountId: grant.accountId,
              workspaceId,
              machineId: retiredCustody.authority.machineId,
            },
            backend.transport,
            {
              jobId: retiredCustody.authority.jobId,
              authorizeJob: async (job) => {
                if (job.jobId !== retiredCustody.authority.jobId)
                  throw Error("Synthetic original custody scope changed");
              },
            },
          );
        let original = await recoverOriginal();
        for (let index = 0; index < 100 && original.items[0]?.state !== "settled"; index++) {
          await Bun.sleep(25);
          original = await recoverOriginal();
        }
        expect(original.items).toEqual([
          { jobId: retiredCustody.authority.jobId, state: "settled" },
        ]);
        const [neverLaunched] = await fixture.admin<
          { state: string; abandoned: boolean; bound: boolean }[]
        >`
          select job.state,command.abandoned,command.binding is not null as bound
          from session_background_commands job join sandbox_v2_commands command on command.operation_id=job.native_operation_id
          where job.id=${retiredCustody.authority.jobId}`;
        expect(neverLaunched).toEqual({ state: "lost", abandoned: true, bound: false });
      } else {
        const nativeJob = runningJob;
        const machineTarget = {
          accountId: grant.accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          machineId: localOwner!.machine.authority.machineId,
          provider: localOwner!.machine.provider,
        };
        const controlWorker = (installed: boolean) =>
          workerForJob(
            installed
              ? async (job) => {
                  if (job.jobId !== nativeJob.custody.authority.jobId)
                    throw Error("Synthetic worker job scope changed");
                  await nativeJob.authorizeJob();
                }
              : undefined,
          );
        const beforeMissingControl = starts;
        expect((await controlWorker(false).reconcileSandboxV2Machine(machineTarget)).status).toBe(
          "deferred",
        );
        expect(starts).toBe(beforeMissingControl);
        expect(workerIo).toBe(0);
        nativeJob.setAllowed(false);
        expect((await controlWorker(true).reconcileSandboxV2Machine(machineTarget)).status).toBe(
          "reconciled",
        );
        expect(starts).toBe(beforeMissingControl);
        expect(workerIo).toBe(0);
        nativeJob.setAllowed(true);
        const worker = controlWorker(true);
        let background = await worker.reconcileSandboxV2Machine(machineTarget);
        for (let index = 0; index < 100; index++) {
          const [custodyState] = await fixture.admin<{ cleared: boolean }[]>`
            select cleared_at is not null as cleared from sandbox_v2_background_credentials where job_id=${retiredCustody.authority.jobId}`;
          if (custodyState?.cleared) break;
          await Bun.sleep(25);
          background = await worker.reconcileSandboxV2Machine(machineTarget);
        }
        expect(background.status).toBe("reconciled");
        expect(workerIo).toBeGreaterThan(0);
        const beforeCompletedSweep = runningJob.ioCount();
        expect((await runningJob.recover(true)).items).toEqual([]);
        expect(runningJob.ioCount()).toBe(beforeCompletedSweep);
        expect(mints).toBe(2);
      }
      let cleaned = await reconcileSandboxV2BackgroundGuestCredentialCleanup(
        client.db,
        retiredCustody.authority,
        backend.transport,
      );
      for (let index = 0; index < 100 && cleaned.state !== "complete"; index++) {
        await Bun.sleep(25);
        cleaned = await reconcileSandboxV2BackgroundGuestCredentialCleanup(
          client.db,
          retiredCustody.authority,
          backend.transport,
        );
      }
      expect(cleaned.state).toBe("complete");
      const [settled] = await fixture.admin<
        { ciphertext: string | null; cleared: boolean; demand: boolean }[]
      >`select credentials.ciphertext,credentials.cleared_at is not null as cleared,
        machine.projection->'demands' @> jsonb_build_array(jsonb_build_object(
          'id',credentials.cleanup_operation_id::text,'kind','command',
          'owner',credentials.session_id::text,'authority',credentials.job_id::text)) as demand
        from sandbox_v2_background_credentials credentials
        join sandbox_v2_machines machine on machine.id=credentials.machine_id
        where credentials.job_id=${retiredCustody.authority.jobId}`;
      expect(settled).toEqual({ ciphertext: null, cleared: true, demand: false });
      await expect(
        docker([
          "exec",
          localOwner!.machine.authority.instance.id,
          "test",
          "-e",
          `${retiredCustody.root}/versions/${retiredCustody.versionName}/env`,
        ]),
      ).rejects.toThrow("Owned native preparation fixture command failed");
      expect(
        await reconcileSandboxV2BackgroundGuestCredentialCleanup(
          client.db,
          retiredCustody.authority,
          backend.transport,
        ),
      ).toEqual(cleaned);
    }
    if (sdkRunTool && sdkCompletedJobs.length) {
      // A fresh ordinary turn reads historical jobs under current job grants.
      // No ended broker is called, and erased per-job material is not restored.
      const nextDispatch = {
        ...dispatch,
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
      };
      const nextClaim = await claimSessionWorkForAttempt(client.db, workspaceId, nextDispatch);
      if (nextClaim.action !== "claimed") throw Error("Synthetic later turn was not claimed");
      expect(nextClaim.turn.id).not.toBe(claimed.turn.id);
      credentialAttemptId = nextDispatch.attemptId;
      const nextState = createTurnContext({ settings, cancellationRequestedAt: null });
      nextState.eventing.publish = async () => undefined;
      await prepareNativeTurnSandbox({
        ...deps,
        ...nextState,
        runtimeResources: [repositoryResource!],
        context: {
          ...deps.context,
          turn: nextClaim.turn as unknown as SessionTurn,
          attemptId: nextDispatch.attemptId,
        },
      });
      localOwner = nextState.sandboxState.nativeTurn;
      expect(localOwner).toBeDefined();
      expect(mints).toBe(3);
      expect(localOwner!.binding.repositories).toEqual([
        {
          uri: repositoryUri,
          ref: "main",
          mountPath: "project",
          expectedCommitSha: repositoryResource!.expectedCommitSha,
        },
      ]);
      const beforeLaterRead = providerIo;
      for (const commandId of sdkCompletedJobs) {
        const laterReply = await sdkRunTool(
          "command_read",
          { command_id: commandId, max_output_bytes: 65_536 },
          `native-sdk-later-turn-${commandId}`,
        );
        expect(JSON.parse(laterReply)).toMatchObject({
          commandId,
          terminal: true,
          state: "exited",
        });
      }
      expect(providerIo).toBe(beforeLaterRead);
      expect(
        await sdkRunTool(
          "exec_command",
          { cmd: "cat project/example.ts", background: false, yield_time_ms: 1000 },
          "native-repository-read",
        ),
      ).toContain('marker = "original"');
      await sdkRunTool(
        "apply_patch",
        {
          operation: {
            type: "update_file",
            path: "project/example.ts",
            diff: '@@\n-export const marker = "original";\n+export const marker = "changed";\n',
          },
        },
        "native-repository-edit",
      );
      const repositoryPlan = await loadSandboxV2PreparationPlan(
        client.db,
        localOwner!.machine.authority,
        "normal-turn:v1",
      );
      const repositoryStep = repositoryPlan!.steps[0]!;
      const beforeRepositoryReplay = starts;
      await executeSandboxV2SetupStep(
        client.db,
        localOwner!.machine,
        {
          setupId: repositoryPlan!.setupId,
          stepId: `hook:${createHash("sha256").update(repositoryStep.stepId).digest("hex")}`,
          command: {
            ...repositoryStep.command,
            cmd: withRunCredentialEnvironment(repositoryStep.command.cmd, session.id),
          },
        },
        { environment: async () => ({}), workspaceRoot: "/workspace" },
      );
      expect(starts).toBe(beforeRepositoryReplay);
      expect(mints).toBe(3);
      expect(
        await sdkRunTool(
          "exec_command",
          { cmd: "cat project/example.ts", background: false, yield_time_ms: 1000 },
          "native-repository-preserved",
        ),
      ).toContain('marker = "changed"');
      const conflictingClone = repositoryCloneCommand(
        [{ ...repositoryResource!, expectedCommitSha: "f".repeat(40) }],
        [],
        [],
        { credentialsAlreadyPrepared: true, preserveExisting: true },
      );
      expect(
        await sdkRunTool(
          "exec_command",
          {
            cmd: "OPENGENI_GIT_PROVISIONING_TARGET=sandbox\n" + conflictingClone,
            background: false,
            yield_time_ms: 1000,
          },
          "native-repository-conflict",
        ),
      ).toContain("Process exited with code 1");
      expect(
        await sdkRunTool(
          "exec_command",
          { cmd: "cat project/example.ts", background: false, yield_time_ms: 1000 },
          "native-repository-conflict-preserved",
        ),
      ).toContain('marker = "changed"');
      const raceClone = repositoryCloneCommand(
        [{ ...repositoryResource!, mountPath: "project-race" }],
        [],
        [],
        { credentialsAlreadyPrepared: true, preserveExisting: true },
      );
      const raceArgs = {
        cmd: "OPENGENI_GIT_PROVISIONING_TARGET=sandbox\n" + raceClone,
        background: false,
        yield_time_ms: 1000,
      };
      const raceReplies = await Promise.all([
        sdkRunTool("exec_command", raceArgs, "native-repository-race-one"),
        sdkRunTool("exec_command", raceArgs, "native-repository-race-two"),
      ]);
      for (const reply of raceReplies) expect(reply).toContain("Process exited with code 0");
      expect(
        await sdkRunTool(
          "exec_command",
          {
            cmd: "test -z \"$(find . -maxdepth 2 -name 'project-race.tmp.*' -print -quit)\" && git -C project-race rev-parse HEAD",
            background: false,
            yield_time_ms: 1000,
          },
          "native-repository-race-retained",
        ),
      ).toContain(repositoryResource!.expectedCommitSha!);
      expect(mints).toBe(3);
      const committedReply = await sdkRunTool(
        "exec_command",
        {
          cmd: "git -C project add example.ts && git -C project -c user.name=Synthetic -c user.email=fixture@example.test commit --quiet --message='Synthetic fixture edit' && git -C project rev-parse HEAD",
          background: false,
          yield_time_ms: 1000,
        },
        "native-repository-commit",
      );
      expect(committedReply).toContain("Process exited with code 0");
      const committedSha = committedReply.split("\n").find((line) => /^[a-f0-9]{40}$/u.test(line));
      expect(committedSha).toBeDefined();
      expect(committedSha).not.toBe(repositoryResource!.expectedCommitSha);
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "steer",
            text: "continue with the committed repository",
            resources: [repositoryResource!],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      );
      expect(
        (
          await settleSessionAttemptInterruptions(
            client.db,
            workspaceId,
            session.id,
            nextDispatch.attemptId,
          )
        ).action,
      ).toBe("continue");
      let nextSettlement = await localOwner!.finalize();
      for (let index = 0; index < 100 && nextSettlement.state !== "drained"; index++) {
        await Bun.sleep(25);
        nextSettlement = await localOwner!.finalize();
      }
      expect(nextSettlement.state).toBe("drained");
      await commitSessionAttemptQuiescence(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        attemptId: nextDispatch.attemptId,
        temporalWorkflowId: nextDispatch.workflowId,
        temporalWorkflowRunId: nextDispatch.workflowRunId,
        temporalActivityId: nextDispatch.dispatchId,
        nativeAuthority: localOwner!.machine.authority,
        allowUninterrupted: true,
      });
      const nextCredentials = await fixture.admin<{ ciphertext: string | null }[]>`
        select ciphertext from sandbox_v2_credential_generations where attempt_id=${nextDispatch.attemptId}`;
      expect(nextCredentials.length).toBeGreaterThan(0);
      expect(nextCredentials.every((entry) => entry.ciphertext === null)).toBe(true);
      const committedDispatch = {
        ...dispatch,
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
      };
      const committedClaim = await claimSessionWorkForAttempt(
        client.db,
        workspaceId,
        committedDispatch,
      );
      if (committedClaim.action !== "claimed") throw Error("Committed repository turn not claimed");
      credentialAttemptId = committedDispatch.attemptId;
      const committedState = createTurnContext({ settings, cancellationRequestedAt: null });
      committedState.eventing.publish = async () => undefined;
      await prepareNativeTurnSandbox({
        ...deps,
        ...committedState,
        runtimeResources: [repositoryResource!],
        context: {
          ...deps.context,
          turn: committedClaim.turn as unknown as SessionTurn,
          attemptId: committedDispatch.attemptId,
        },
      });
      localOwner = committedState.sandboxState.nativeTurn;
      expect(mints).toBe(4);
      expect(localOwner!.binding.repositories).toEqual(repositoryPlan!.repositories!);
      const retainedCommit = await sdkRunTool(
        "exec_command",
        {
          cmd: "git -C project rev-parse HEAD && cat project/example.ts",
          background: false,
          yield_time_ms: 1000,
        },
        "native-repository-commit-retained-next-turn",
      );
      expect(retainedCommit).toContain(committedSha!);
      expect(retainedCommit).toContain('marker = "changed"');
      await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as SessionActivityDatabase, {
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: crypto.randomUUID(),
            action: "pause",
          }),
        ),
      );
      expect(
        (
          await settleSessionAttemptInterruptions(
            client.db,
            workspaceId,
            session.id,
            committedDispatch.attemptId,
          )
        ).action,
      ).toBe("paused");
      let committedSettlement = await localOwner!.finalize();
      for (let index = 0; index < 100 && committedSettlement.state !== "drained"; index++) {
        await Bun.sleep(25);
        committedSettlement = await localOwner!.finalize();
      }
      expect(committedSettlement.state).toBe("drained");
      await commitSessionAttemptQuiescence(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        attemptId: committedDispatch.attemptId,
        temporalWorkflowId: committedDispatch.workflowId,
        temporalWorkflowRunId: committedDispatch.workflowRunId,
        temporalActivityId: committedDispatch.dispatchId,
        nativeAuthority: localOwner!.machine.authority,
        allowUninterrupted: true,
      });
      const committedCredentials = await fixture.admin<{ ciphertext: string | null }[]>`
        select ciphertext from sandbox_v2_credential_generations where attempt_id=${committedDispatch.attemptId}`;
      expect(committedCredentials.length).toBeGreaterThan(0);
      expect(committedCredentials.every((entry) => entry.ciphertext === null)).toBe(true);
    }
    const lifecycle = new MachineController(
      createSandboxV2MachineStore(client.db, grant.accountId),
      backend,
      0,
    );
    const scope = { workspaceId, sandboxGroupId: session.sandboxGroupId };
    await lifecycle.requestDestroy(scope);
    expect((await lifecycle.step(scope)).state).toBe("destroying");
    expect((await lifecycle.step(scope)).state).toBe("destroyed");
  } finally {
    await localOwner?.closeAndDrain();
    if (ownedMachineId) {
      await docker(["rm", "--force", `opengeni-v2-${ownedMachineId}`]).catch(() => undefined);
      await docker(["volume", "rm", `opengeni-v2-workspace-${ownedMachineId}`]).catch(
        () => undefined,
      );
    }
    await client.close();
    await fixture.release();
  }
}

(image ? test : test.skip)(
  "main native preparation executes and recovers sealed workspace/MCP material",
  async () => {
    await exerciseNativePreparation(false);
  },
  180_000,
);

(image ? test : test.skip)(
  "failed original broker mint retains cleanup ownership through a native receipt",
  async () => {
    await exerciseNativePreparation(true);
  },
  180_000,
);

(image ? test : test.skip)(
  "production runAgentTurn completes through native preparation and its original receipt",
  async () => {
    const fixture = await acquireSharedTestDatabase("native-production-turn");
    if (!fixture) throw Error("Native production turn requires disposable PostgreSQL");
    const client = createDb(fixture.appUrl);
    let ownedMachineId: string | undefined;
    let jevServer: ReturnType<typeof Bun.serve> | undefined;
    let credentialServer: ReturnType<typeof Bun.serve> | undefined;
    const docker = async (args: string[]) => {
      const child = Bun.spawn(["docker", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      try {
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (code !== 0) throw Error("Owned native production fixture command failed");
        return stdout.trim();
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      configureSandboxV2AdmissionPolicy(client.db, {
        enabled: true,
        qualifiedBackends: new Set(["docker"]),
      });
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: suffix,
        accountName: "Synthetic native production turn",
        workspaceExternalSource: "test",
        workspaceExternalId: suffix,
        workspaceName: "Synthetic native production turn",
        subjectId: `subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;
      await updateWorkspaceSettings(client.db, workspaceId, { sandboxV2Enabled: true });
      const fileContent = "synthetic main attachment";
      const upload = await createFileUpload(client.db, {
        accountId: grant.accountId,
        workspaceId,
        fileId: crypto.randomUUID(),
        filename: "sample.txt",
        safeFilename: "sample.txt",
        contentType: "text/plain",
        sizeBytes: Buffer.byteLength(fileContent),
        sha256: createHash("sha256").update(fileContent).digest("hex"),
        bucket: "synthetic-bucket",
        objectKey: `synthetic/${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const readyFile = await completeFileUpload(client.db, workspaceId, upload.uploadId);
      const skillId = crypto.randomUUID();
      const largeSkillFile = "ordinary data.\n".repeat(90_000);
      const savedSkill = await saveSkill(client.db, {
        accountId: grant.accountId,
        workspaceId,
        actor: { kind: "human", subjectId: grant.subjectId, principalKind: "human_session" },
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `synthetic-native-${suffix}`,
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: synthetic-native\ndescription: Synthetic workspace fixture\n---\nOrdinary fixture.",
          },
          { path: "references/note.md", content: "synthetic initial note" },
          { path: "references/large.txt", content: largeSkillFile },
        ],
        reason: "Synthetic native workspace fixture",
      });
      const originalSkill = (
        await listSkillDescriptors(client.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
        })
      ).find((entry) => entry.id === skillId)!;
      expect(originalSkill.revisionId).toBe(savedSkill.revisionId);
      const variableKey = Buffer.alloc(32, 19);
      const createVariables = (setName: string, values: Record<string, string>) =>
        createVariableSet(client.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          scope: "workspace",
          name: setName,
          variables: Object.entries(values).map(([variableName, value]) => ({
            name: variableName,
            valueEncrypted: encryptEnvironmentValue(variableKey, value),
          })),
        });
      const firstDefaults = await createVariables("Synthetic first rig defaults", {
        SYNTHETIC_RIG_ORDER: "synthetic-rig-first",
        SYNTHETIC_RIG_ONLY: "synthetic-pinned-default",
        SYNTHETIC_OVERRIDE: "synthetic-rig-value",
      });
      const secondDefaults = await createVariables("Synthetic second rig defaults", {
        SYNTHETIC_RIG_ORDER: "synthetic-rig-second",
      });
      const explicitVariables = await createVariables("Synthetic session variables", {
        SYNTHETIC_OVERRIDE: "synthetic-session-value",
      });
      const newerDefaults = await createVariables("Synthetic newer rig defaults", {
        SYNTHETIC_RIG_ONLY: "synthetic-newer-default",
      });
      const rig = await createRig(client.db, {
        accountId: grant.accountId,
        workspaceId,
        scope: "workspace",
        subjectId: grant.subjectId,
        name: "Synthetic configuration environment",
        initialVersion: { defaultVariableSetIds: [firstDefaults.id, secondDefaults.id] },
      });
      const session = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "Run a native command and finish.",
        resources: [{ kind: "file", fileId: readyFile.id }],
        tools: [],
        codeSearchDeploymentPolicy: { available: true, workspaceDefault: "on" },
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "docker",
        rigId: rig.id,
        rigVersionId: rig.activeVersion!.id,
        variableSetIds: [explicitVariables.id],
        createdBy: { kind: "subject", subjectId: grant.subjectId },
      });
      expect(session.rigVersionId).toBe(rig.activeVersion!.id);
      // A newer version cannot change this session's frozen configuration or
      // introduce setup that its native preparation contract does not support.
      const newerRigVersion = await createRigVersion(
        client.db,
        workspaceId,
        rig.id,
        {
          setupScript: "printf synthetic-newer-rig-setup",
          defaultVariableSetIds: [newerDefaults.id],
        },
        { activate: true },
      );
      expect(newerRigVersion.version).toBe(2);
      const machine = await findSandboxMachine(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
      });
      if (!machine) throw Error("Synthetic native production machine was not admitted");
      ownedMachineId = machine.id;
      await initializeSessionStartAtomically(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        clientEventId: `initial:${suffix}`,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
      const backend = new DockerMachineBackend({
        image: await docker(["image", "inspect", "--format", "{{.Id}}", image!]),
        networkMode: "none",
        memoryLimitBytes: 256 * 1024 ** 2,
        cpuLimit: 0.5,
      });
      let jevRequests = 0;
      let jevAuthorized = true;
      jevServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (new URL(request.url).pathname === "/healthz") return Response.json({ status: "ok" });
          if (request.headers.get("authorization") !== "Bearer synthetic-jev-token") {
            jevAuthorized = false;
            return new Response("Synthetic authorization rejected", { status: 403 });
          }
          jevRequests++;
          const body = (await request.json()) as {
            questions: Record<string, { type: string; options?: string[] }>;
          };
          const answers: Record<string, unknown> = {};
          for (const [id, question] of Object.entries(body.questions))
            answers[id] =
              question.type === "noul"
                ? { type: "noul", noul: 0.9 }
                : question.type === "choice"
                  ? { type: "choice", choice: question.options?.[0] ?? "" }
                  : { type: "score", score: 0.9 };
          return Response.json({ answers, usage: { input_tokens: 1000 }, model: "jev-test" });
        },
      });
      const settings = testSettings({
        databaseUrl: fixture.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
        sandboxV2Enabled: false,
        environmentsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
        jevApiKey: "synthetic-jev-token",
        jevBaseUrl: jevServer.url.toString(),
        codeSearchMode: "default_on",
      });
      const attemptId = crypto.randomUUID();
      let backgroundAllowed = true;
      let productionBackgroundAuthority: SandboxV2BackgroundCommandAuthority | undefined;
      const authorizeBackgroundJobControl = async (
        authority: SandboxV2BackgroundCommandAuthority,
      ) => {
        if (
          !backgroundAllowed ||
          authority.accountId !== grant.accountId ||
          authority.workspaceId !== workspaceId ||
          authority.sessionId !== session.id ||
          authority.attemptId !== attemptId ||
          authority.machineId !== ownedMachineId ||
          (productionBackgroundAuthority && authority.jobId !== productionBackgroundAuthority.jobId)
        )
          throw Error("Synthetic production job permission unavailable");
        productionBackgroundAuthority ??= structuredClone(authority);
      };
      const model = new ScriptedModel([
        {
          output: [
            {
              type: "hosted_tool_call",
              id: "synthetic-native-production-hosted-image",
              name: "image_generation_call",
              status: "completed",
              output: SYNTHETIC_PNG_BASE64,
              providerData: { type: "image_generation_call" },
            },
            functionCall(
              "skill_checkout",
              { skill: skillId, directory: "synthetic-skill" },
              "native-production-checkout",
            ),
          ],
        },
        {
          output: [
            functionCall(
              "exec_command",
              {
                cmd: `test "$SYNTHETIC_MAIN" = sealed && test "$SYNTHETIC_RIG_ORDER" = synthetic-rig-second && test "$SYNTHETIC_RIG_ONLY" = synthetic-pinned-default && test "$SYNTHETIC_OVERRIDE" = synthetic-session-value && test -z "$JEV_API_KEY" && test "$(stat -c %a "$OPENGENI_GIT_CREDENTIALS_FILE")" = 400 && printf 'protocol=https\nhost=git.example.test\n\n' | git credential fill | rg --quiet '^password=.' && test "$(cat .opengeni/files/${readyFile.id}/sample.txt)" = 'synthetic main attachment' && test "$(cat synthetic-skill/references/note.md)" = 'synthetic initial note' && test "$(wc -c < synthetic-skill/references/large.txt)" -eq ${Buffer.byteLength(largeSkillFile)} && test "$(find generated-images -maxdepth 1 -type f | wc -l)" -eq 1 && sha256sum generated-images/*.png | rg --quiet '^${createHash("sha256").update(Buffer.from(SYNTHETIC_PNG_BASE64, "base64")).digest("hex")} ' && printf '%s\n' "export const syntheticWorkspaceValue = 'ordinary-native';" > synthetic-skill/references/note.md && cp generated-images/*.png native-image.png && printf main-native`,
                yield_time_ms: 1000,
              },
              "native-production-command",
            ),
          ],
        },
        {
          output: [
            functionCall("view_image", { path: "native-image.png" }, "native-production-image"),
          ],
        },
        {
          output: [
            functionCall(
              "code_search",
              {
                question: "Where is syntheticWorkspaceValue defined?",
                keywords: ["syntheticWorkspaceValue", "ordinary-native"],
                paths: ["synthetic-skill"],
              },
              "native-production-search",
            ),
          ],
        },
        {
          output: [
            functionCall(
              "skill_publish",
              {
                operationId: crypto.randomUUID(),
                skillId,
                expectedRevisionId: savedSkill.revisionId,
                expectedScopeVersion: originalSkill.scopeVersion,
                directory: "synthetic-skill",
                reason: "Synthetic native publication fixture",
              },
              "native-production-publish",
            ),
          ],
        },
        { output: [functionCall(REFRESH_CREDENTIALS_TOOL_NAME, {}, "native-production-refresh")] },
        {
          output: [
            functionCall(
              "exec_command",
              {
                cmd: 'set -eu; test "$SYNTHETIC_MAIN" = sealed; test "$SYNTHETIC_RIG_ONLY" = synthetic-pinned-default; test "$SYNTHETIC_OVERRIDE" = synthetic-session-value; printf native-background-ready; n=0; while :; do n=$((n+1)); printf "%s" "$n" > .native-background-progress.tmp; mv .native-background-progress.tmp native-background-progress; sleep 0.1; done',
                shell: "/bin/bash",
                login: false,
                background: true,
                yield_time_ms: 0,
              },
              "native-production-background",
            ),
          ],
        },
        {
          output: [
            functionCall(
              "exec_command",
              {
                cmd: "for i in {1..100}; do test ! -s native-background-progress || break; sleep 0.02; done; test -s native-background-progress && printf background-observed",
                shell: "/bin/bash",
                login: false,
                yield_time_ms: 1000,
              },
              "native-production-background-observation",
            ),
          ],
        },
        { output: [assistantMessage("Native turn finished.")] },
      ]);
      let mints = 0;
      let hostFallbackCalls = 0;
      const credentialRequests: CredentialProviderRequest[] = [];
      const issuerSecret = `ogcp_${randomBytes(32).toString("base64url")}`;
      const gitPassword = randomBytes(32).toString("base64url");
      credentialServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          let accepted: CredentialProviderRequest;
          try {
            accepted = await verifyCredentialProviderRequest({
              body: await request.text(),
              headers: request.headers,
              secret: issuerSecret,
            });
          } catch {
            return new Response("Synthetic issuer signature rejected", { status: 401 });
          }
          credentialRequests.push(accepted);
          mints++;
          if (mints === 2) await Bun.sleep(250);
          return Response.json({
            status: "ok",
            environment: { SYNTHETIC_MAIN: "sealed" },
            git: [{ host: "git.example.test", password: gitPassword }],
            expiresAt: new Date(Date.now() + (mints === 1 ? 300_000 : 3_600_000)).toISOString(),
          });
        },
      });
      const providerRegistration = await upsertWorkspaceCredentialProvider(client.db, {
        accountId: grant.accountId,
        workspaceId,
        url: `http://127.0.0.1:${credentialServer.port}/credentials`,
        secretEncrypted: encryptEnvironmentValue(
          environmentsEncryptionKeyBytes(settings)!,
          issuerSecret,
        ),
        enabled: true,
        timeoutMs: 2000,
        createdBySubjectId: grant.subjectId,
      });
      let serverStarted = false;
      let generatedUrlAttempts = 0;
      const urlAudiences: (string | undefined)[] = [];
      const storedImages = new Map<string, Uint8Array>();
      const runtime = createProductionAgentRuntime({ model });
      // Keep the scripted model for all execution. Only the ordinary catalogue
      // metadata is supplied, using a synthetic credential, to expose hosted
      // image retention through the same worker/SDK path as a real Responses turn.
      runtime.resolveTurnModel = (runSettings) => {
        const resolved = resolveTurnModel(
          { ...runSettings, openaiModel: "gpt-5.6-sol" },
          "gpt-5.6-sol",
        );
        expect(resolved?.configured.capabilities.hostedTools.imageGeneration.runnable).toBe(true);
        return resolved;
      };
      const activities = createActivityTestHarness({
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        runtime,
        objectStorage: {
          bucket: "synthetic-bucket",
          fileExists: async (file) => storedImages.has(file.objectKey),
          putObject: async ({ key, contentType, body, sha256 }) => {
            expect(contentType).toBe("image/png");
            expect(createHash("sha256").update(body).digest("hex")).toBe(sha256!);
            storedImages.set(key, new Uint8Array(body));
          },
          getObjectBytes: async (key) => {
            const bytes = storedImages.get(key);
            return bytes ? { bytes: new Uint8Array(bytes), contentType: "image/png" } : null;
          },
          deleteObject: async (key) => {
            storedImages.delete(key);
          },
          createGetUrl: async ({ key, audience }) => {
            const generated = storedImages.has(key);
            if (!generated) expect(key).toBe(readyFile.objectKey);
            if (generated && ++generatedUrlAttempts === 1)
              throw Error("Synthetic image URL signer temporarily unavailable");
            urlAudiences.push(audience);
            return {
              url: `http://127.0.0.1:45871/${generated ? "generated" : "file"}?signature=synthetic`,
              expiresAt: new Date(Date.now() + 60_000),
            };
          },
        } as NonNullable<Parameters<typeof createActivityTestHarness>[0]["objectStorage"]>,
        sandboxV2ControlProviders: new Map([
          [
            "docker",
            {
              backend,
              fileDownloadAudience: "public",
              authorizeBackgroundJobControl,
              transport: {
                exec: async (request) => {
                  const response = await backend.transport.exec(request);
                  if (!serverStarted && request.argv.includes("capabilities")) {
                    // Bootstrap only the owned fixture's attachment origin. The
                    // production preparer performs the actual verified download.
                    serverStarted = true;
                    await docker([
                      "exec",
                      "-d",
                      request.instanceId,
                      "bun",
                      "-e",
                      `Bun.serve({hostname:"127.0.0.1",port:45871,fetch(request){return new Response(new URL(request.url).pathname==="/generated"?Buffer.from("${SYNTHETIC_PNG_BASE64}","base64"):${JSON.stringify(fileContent)});}});`,
                    ]);
                    for (let i = 0; i < 50; i++) {
                      try {
                        await docker([
                          "exec",
                          request.instanceId,
                          "curl",
                          "--fail",
                          "--silent",
                          "http://127.0.0.1:45871/health",
                        ]);
                        break;
                      } catch {
                        await Bun.sleep(20);
                      }
                    }
                  }
                  return response;
                },
              },
            },
          ],
        ]),
        connectionCredentials: {
          runCredentialAuthority: {
            identity: "synthetic-production-host",
            authorize: async () => {
              hostFallbackCalls++;
              throw Error("Workspace issuer cannot borrow the host fallback");
            },
          },
          runCredentials: async () => {
            hostFallbackCalls++;
            throw Error("Workspace issuer cannot borrow the host fallback");
          },
        },
      });
      const result = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        attemptId,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      const events = await listSessionEvents(client.db, workspaceId, session.id);
      expect(
        events.filter((event) => event.type === "turn.failed").map((event) => event.payload),
      ).toEqual([]);
      expect(result).toMatchObject({ status: "idle" });
      expect(mints).toBe(3);
      expect(hostFallbackCalls).toBe(0);
      expect(credentialRequests.map((request) => request.purpose)).toEqual([
        "provision",
        "renewal",
        "renewal",
      ]);
      for (const request of credentialRequests) {
        expect(request).toMatchObject({
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          attemptId,
          sandboxBackend: "machine-v2",
          sandboxEngine: "machine-v2",
          machineProvider: "docker",
          initiatingHumanSubjectId: grant.subjectId,
          lane: "workspace",
          mcpServers: [],
        });
        expect(Object.hasOwn(request, "variableSet")).toBe(false);
        expect(JSON.stringify(request)).not.toContain("synthetic-session-value");
        expect(JSON.stringify(request)).not.toContain("synthetic-pinned-default");
      }
      const [selection] = await fixture.admin<
        { provider: unknown; variable_set: unknown; definition: unknown }[]
      >`
        select definition->'credentialSelection'->'provider' as provider,
          definition->'credentialSelection'->'variableSet' as variable_set,definition
        from sandbox_v2_preparation_plans where attempt_id=${attemptId} and setup_id='normal-turn:v1'`;
      expect(selection?.provider).toMatchObject({ kind: "workspace", id: providerRegistration.id });
      expect(selection?.variable_set).toEqual({
        id: explicitVariables.id,
        name: explicitVariables.name,
      });
      expect(JSON.stringify(selection?.definition)).not.toContain("synthetic-session-value");
      expect(JSON.stringify(selection?.definition)).not.toContain("synthetic-pinned-default");
      expect(urlAudiences).toContain("public");
      expect(generatedUrlAttempts).toBe(2);
      expect(model.requests[0]!.systemInstructions).toContain("sample.txt");
      expect(model.requests[0]!.systemInstructions).not.toContain("signature=synthetic");
      expect(model.requests[0]!.systemInstructions).not.toContain("synthetic-session-value");
      expect(model.requests[0]!.systemInstructions).not.toContain("synthetic-pinned-default");
      expect(model.requests[0]!.systemInstructions).toContain(
        'sandbox environment "Synthetic configuration environment" (pinned version v1)',
      );
      expect(model.requests[0]!.systemInstructions).toContain(
        "Your sandbox machine is retained for this sandbox group.",
      );
      expect(model.requests[0]!.systemInstructions).not.toContain("EPHEMERAL FORK");
      expect(events.some((event) => event.type === "rig.setup.started")).toBe(false);
      expect(
        model.requests.some((request) =>
          JSON.stringify(request.input).includes('"type":"input_image"'),
        ),
      ).toBe(true);
      expect(JSON.stringify(model.requests[0]!.tools)).toContain("image_generation");
      expect(storedImages.size).toBe(2);
      const [generatedArtifact] = await fixture.admin<
        { status: string; source_strategy: string; sha256: string; sandbox_path: string }[]
      >`
        select status,source_strategy,sha256,sandbox_path from generated_image_artifacts
        where session_id=${session.id} and attempt_id=${attemptId}
          and provider_item_id='synthetic-native-production-hosted-image'`;
      expect(generatedArtifact).toMatchObject({
        status: "ready",
        source_strategy: "native_hosted",
        sha256: createHash("sha256")
          .update(Buffer.from(SYNTHETIC_PNG_BASE64, "base64"))
          .digest("hex"),
      });
      expect(generatedArtifact?.sandbox_path).toMatch(
        /^\/workspace\/generated-images\/generated-image-[a-f0-9-]+\.png$/u,
      );
      expect(JSON.stringify(events)).not.toContain(SYNTHETIC_PNG_BASE64);
      expect(JSON.stringify(events)).toContain(generatedArtifact!.sandbox_path);
      const [imageArtifact] = await fixture.admin<
        { status: string; media_type: string; sha256: string; width: number; height: number }[]
      >`
        select status,media_type,sha256,width,height from retained_screenshot_artifacts
        where session_id=${session.id} and attempt_id=${attemptId}
          and tool_call_id='native-production-image'`;
      expect(imageArtifact).toEqual({
        status: "ready",
        media_type: "image/png",
        sha256: createHash("sha256")
          .update(Buffer.from(SYNTHETIC_PNG_BASE64, "base64"))
          .digest("hex"),
        width: 1,
        height: 1,
      });
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      const outputs = events.filter((event) => event.type === "agent.toolCall.output");
      const commandOutput = outputs.find((event) =>
        JSON.stringify(event.payload).includes("native-production-command"),
      );
      expect(JSON.stringify(commandOutput)).toContain("main-native");
      expect(JSON.stringify(commandOutput)).toContain("Process exited with code 0");
      for (const id of [
        "native-production-checkout",
        "native-production-search",
        "native-production-publish",
      ]) {
        const output = outputs.find((event) => JSON.stringify(event.payload).includes(id));
        expect(output).toBeDefined();
        expect(JSON.stringify(output).replaceAll('\\"', '"')).not.toContain('"isError":true');
      }
      expect(JSON.stringify(outputs).replaceAll('\\"', '"')).toContain('"written":3');
      expect(jevRequests).toBeGreaterThan(0);
      expect(jevAuthorized).toBe(true);
      expect(
        JSON.stringify(
          outputs.find((event) =>
            JSON.stringify(event.payload).includes("native-production-search"),
          ),
        ),
      ).toContain("syntheticWorkspaceValue");
      const [attempt] = await fixture.admin<{ closed: boolean; quiesced: boolean }[]>`
      select closed_at is not null as closed,quiesced_at is not null as quiesced
      from session_turn_attempts where id=${attemptId}`;
      expect(attempt).toEqual({ closed: true, quiesced: true });
      const retained = await fixture.admin<{ ciphertext: string | null }[]>`
      select ciphertext from sandbox_v2_credential_generations where attempt_id=${attemptId}`;
      expect(retained).toHaveLength(4);
      for (const entry of retained) expect(entry.ciphertext).toBeNull();
      // The actual worker closes its turn and clears its own credentials while
      // the original background job retains independent static custody.
      if (!productionBackgroundAuthority) throw Error("Original production job owner missing");
      const jobAuthority = productionBackgroundAuthority;
      const jobTarget = {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
        machineId: ownedMachineId,
        provider: "docker",
      };
      expect(await loadSandboxV2BackgroundCommandForControl(client.db, jobAuthority)).toMatchObject(
        {
          independent: true,
          state: "running",
          outputComplete: false,
        },
      );
      const [backgroundCustody] = await fixture.admin<{ retained: boolean; cleared: boolean }[]>`
        select ciphertext is not null as retained,cleared_at is not null as cleared
        from sandbox_v2_background_credentials where job_id=${jobAuthority.jobId}`;
      expect(backgroundCustody).toEqual({ retained: true, cleared: false });
      await docker([
        "exec",
        jobAuthority.instance.id,
        "test",
        "!",
        "-e",
        `${runCredentialRoot(session.id)}/current`,
      ]);
      const progress = () =>
        docker([
          "exec",
          jobAuthority.instance.id,
          "cat",
          "/workspace/native-background-progress",
        ]).then(Number);
      const beforeProgress = await progress();
      await Bun.sleep(150);
      expect(await progress()).toBeGreaterThan(beforeProgress);
      let controlIo = 0;
      const controlWorker = (installPermission: boolean) =>
        createSandboxV2ControlActivities(
          async () =>
            ({
              db: client.db,
              settings,
              bus: new MemoryEventBus(),
              sandboxV2ControlProviders: new Map([
                [
                  "docker",
                  {
                    backend,
                    ...(installPermission ? { authorizeBackgroundJobControl } : {}),
                    transport: {
                      exec: (request) => {
                        controlIo++;
                        return backend.transport.exec(request);
                      },
                    },
                  },
                ],
              ]),
            }) as ControlActivityServices,
        );
      expect((await controlWorker(false).reconcileSandboxV2Machine(jobTarget)).status).toBe(
        "deferred",
      );
      expect(controlIo).toBe(0);
      backgroundAllowed = false;
      await controlWorker(true).reconcileSandboxV2Machine(jobTarget);
      expect(controlIo).toBe(0);
      expect(mints).toBe(3);
      backgroundAllowed = true;
      const independentControl = controlWorker(true);
      await independentControl.reconcileSandboxV2Machine(jobTarget);
      const outputIdentity = {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        commandId: jobAuthority.jobId,
        maxOutputBytes: 65_536,
      };
      const runningPage = await readSessionBackgroundCommandOutput(client.db, outputIdentity);
      expect(runningPage.terminal).toBe(false);
      expect(runningPage.chunks.map((chunk) => chunk.chunk).join("")).toContain(
        "native-background-ready",
      );
      expect(
        await requestSessionBackgroundCommandCancellation(client.db, {
          ...outputIdentity,
          subjectId: grant.subjectId,
        }),
      ).toMatchObject({ accepted: true });
      expect(
        (await loadSandboxV2BackgroundCommandForControl(client.db, jobAuthority)).outputComplete,
      ).toBe(false);
      let cleared = false;
      for (let i = 0; i < 100 && !cleared; i++) {
        await independentControl.reconcileSandboxV2Machine(jobTarget);
        const [custody] = await fixture.admin<{ cleared: boolean }[]>`
          select ciphertext is null and cleared_at is not null as cleared
          from sandbox_v2_background_credentials where job_id=${jobAuthority.jobId}`;
        cleared = custody?.cleared === true;
        if (!cleared) await Bun.sleep(25);
      }
      expect(cleared).toBe(true);
      const finishedPage = await readSessionBackgroundCommandOutput(client.db, outputIdentity);
      expect(finishedPage).toMatchObject({ terminal: true, state: "exited" });
      expect(finishedPage.chunks.map((chunk) => chunk.chunk).join("")).toContain(
        "native-background-ready",
      );
      const beforeControlReplay = controlIo;
      await controlWorker(true).reconcileSandboxV2Machine(jobTarget);
      expect(controlIo).toBe(beforeControlReplay);
      expect(mints).toBe(3);
      expect(hostFallbackCalls).toBe(0);
      const lifecycle = new MachineController(
        createSandboxV2MachineStore(client.db, grant.accountId),
        backend,
        0,
      );
      const scope = { workspaceId, sandboxGroupId: session.sandboxGroupId };
      await lifecycle.requestDestroy(scope);
      expect((await lifecycle.step(scope)).state).toBe("destroying");
      expect((await lifecycle.step(scope)).state).toBe("destroyed");
      const unsupportedSession = await createSession(client.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "Use the newer scripted environment.",
        tools: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "docker",
        rigId: rig.id,
        rigVersionId: newerRigVersion.id,
        createdBy: { kind: "subject", subjectId: grant.subjectId },
      });
      expect(unsupportedSession.rigVersionId).toBe(newerRigVersion.id);
      await initializeSessionStartAtomically(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: unsupportedSession.id,
        clientEventId: `unsupported:${suffix}`,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
      expect(
        await activities.runAgentTurn({
          accountId: grant.accountId,
          workspaceId,
          sessionId: unsupportedSession.id,
          attemptId: crypto.randomUUID(),
          workflowId: `session-${unsupportedSession.id}`,
          workflowRunId: crypto.randomUUID(),
          trigger: { kind: "next" },
        }),
      ).toMatchObject({ status: "failed" });
      const unsupportedEvents = await listSessionEvents(
        client.db,
        workspaceId,
        unsupportedSession.id,
      );
      expect(
        JSON.stringify(unsupportedEvents.filter((event) => event.type === "turn.failed")),
      ).toContain("Native turn preparation does not yet support this rig, resource or OS contract");
      expect(mints).toBe(3);
      expect(hostFallbackCalls).toBe(0);
      expect(
        (
          await findSandboxMachine(client.db, {
            accountId: grant.accountId,
            workspaceId,
            sandboxGroupId: unsupportedSession.sandboxGroupId,
          })
        )?.state,
      ).toBe("absent");
    } finally {
      jevServer?.stop(true);
      credentialServer?.stop(true);
      if (ownedMachineId) {
        await docker(["rm", "--force", `opengeni-v2-${ownedMachineId}`]).catch(() => undefined);
        await docker(["volume", "rm", `opengeni-v2-workspace-${ownedMachineId}`]).catch(
          () => undefined,
        );
      }
      await client.close();
      await fixture.release();
    }
  },
  180_000,
);
