import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acquireSharedTestDatabase,
  ScriptedModel,
  functionCall,
  assistantMessage,
  testSettings,
} from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  createTurnInvocationDrain,
  runAgentStream,
  RunMcpCredentials,
} from "@opengeni/runtime";
import type {
  ConnectionCredentialsPort,
  RunCredentialsRequest,
  Session,
  SessionTurn,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  abandonUnboundSandboxJournalControl,
  acquireSandboxMachineForAttempt,
  claimSessionWorkForAttempt,
  commitSessionAttemptQuiescence,
  configureSandboxV2AdmissionPolicy,
  createDb,
  createSession,
  createFileUpload,
  completeFileUpload,
  clearSandboxV2CredentialGenerationsForQuiescedAttempt,
  encryptEnvironmentValue,
  retainSandboxV2CredentialGeneration,
  findSandboxMachine,
  loadSandboxJournalCommand,
  loadSandboxJournalToolReply,
  listPendingSandboxJournalCommands,
  releaseRevokedSandboxMachineAttempt,
  loadSandboxV2CredentialCleanupForControl,
  submitHumanPromptInTransaction,
  updateWorkspaceSettings,
  withWorkspaceSubjectSessionActivityRls,
  type SessionActivityDatabase,
  type SandboxJournalTurnAuthority,
} from "@opengeni/db";
import { mutateSessionControlInTransaction } from "../../db/src/session-control";
import { withRlsContext } from "../../db/src/database";
import { sessionAttemptPendingWritersSql } from "../../db/src/session-attempt-writers";
import {
  DockerMachineBackend,
  MachineController,
  JournalCapabilities,
  JournalUnavailableError,
  MachineSandboxSession,
  withRunCredentialEnvironment,
  normalizeRunCredentialsResolution,
  type MachineExecTransport,
} from "@opengeni/runtime/sandbox";
import {
  createSandboxV2CommandPersistence,
  executeSandboxV2AcceptedToolAction,
  sandboxV2CausalActionId,
} from "../src/sandbox-v2-command-store";
import { createSandboxV2MachineStore } from "../src/sandbox-v2-store";
import { establishSandboxV2MachineForAttempt } from "../src/sandbox-v2-turn";
import { executeSandboxV2SetupStep, SandboxV2SetupFailedError } from "../src/sandbox-v2-setup";
import { deliverSandboxV2File } from "../src/sandbox-v2-files";
import { installSandboxV2CredentialGeneration } from "../src/sandbox-v2-credentials";
import { reconcileSandboxV2GuestCredentialCleanup } from "../src/sandbox-v2-credential-cleanup";
import { createSandboxV2CredentialGenerationOwner } from "../src/sandbox-v2-credential-owner";
import {
  loadSandboxV2CredentialOwner,
  reserveSandboxV2CredentialRenewal,
  activateSandboxV2CredentialTicket,
} from "@opengeni/db";
import { reconcileSandboxV2MachineCommands } from "../src/sandbox-v2-reconcile";
import { reconcileSandboxV2AttemptWriters } from "../src/sandbox-v2-attempt-writers";
import { createSandboxV2ShellBinding } from "../../../apps/worker/src/sandbox-v2-shell";
import {
  createSandboxV2TurnShell,
  prepareSandboxV2TurnShell,
  loadOrCreateSandboxV2TurnPreparationPlan,
} from "../../../apps/worker/src/sandbox-v2-turn";
import { createSandboxV2TurnFileResourceOwner } from "../../../apps/worker/src/sandbox-v2-resources";
import { createSandboxV2TurnExecution } from "../../../apps/worker/src/sandbox-v2-execution";
import {
  createSandboxV2RunCredentialOwner,
  planSandboxV2RunCredentialSelection,
} from "../../../apps/worker/src/sandbox-v2-run-credentials";

const image = process.env.JOURNAL_CONFORMANCE_IMAGE;
(image ? test : test.skip)(
  "real Linux and PostgreSQL: retained actions survive lost replies and Pause settles only physical exit",
  async () => {
    const fixture = await acquireSharedTestDatabase("sandbox-v2-command-store");
    if (!fixture) throw Error("Integrated journal requires disposable PostgreSQL");
    const client = createDb(fixture.appUrl);
    let controlClient: ReturnType<typeof createDb> | undefined;
    let container: string | undefined;
    let ownedMachineId: string | undefined;
    async function docker(args: string[]) {
      const child = Bun.spawn(["docker", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
      try {
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(0);
        return stdout.trim();
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      configureSandboxV2AdmissionPolicy(client.db, {
        enabled: true,
        qualifiedBackends: new Set(["docker"]),
      });
      const suffix = crypto.randomUUID();
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: `account-${suffix}`,
        accountName: "Synthetic integrated journal",
        workspaceExternalSource: "test",
        workspaceExternalId: `workspace-${suffix}`,
        workspaceName: "Synthetic integrated journal",
        subjectId: `subject-${suffix}`,
      });
      const grant = access.workspaceGrants[0]!;
      const workspaceId = grant.workspaceId!;
      await updateWorkspaceSettings(client.db, workspaceId, {
        sandboxV2Enabled: true,
      });
      const fileContent = "synthetic attachment 😀\n";
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
      const renewalMcpTarget = { id: "synthetic-renewal-mcp", url: "https://mcp.example.test/" };
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
        mcpServers: [renewalMcpTarget],
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
            text: "synthetic work",
            resources: [{ kind: "file", fileId: readyFile.id }],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      );
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw Error("Synthetic attempt was not claimed");
      const machine = await findSandboxMachine(client.db, {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
      });
      if (!machine) throw Error("Synthetic machine was not admitted");
      ownedMachineId = machine.id;
      const backend = new DockerMachineBackend({
        image: await docker(["image", "inspect", "--format", "{{.Id}}", image!]),
        networkMode: "none",
        memoryLimitBytes: 256 * 1024 ** 2,
        cpuLimit: 0.5,
      });
      const lifecycle = new MachineController(
        createSandboxV2MachineStore(client.db, grant.accountId),
        backend,
        0,
      );
      const machineScope = {
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
      };
      const preparedMachine = await establishSandboxV2MachineForAttempt(
        client.db,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          turnId: claimed.turn.id,
          executionGeneration: claimed.turn.executionGeneration,
          attemptId,
        },
        new Map([["docker", { backend, transport: backend.transport }]]),
        { idleGraceMs: 0 },
      );
      if (preparedMachine.engine !== "machine-v2") throw Error("Expected retained machine engine");
      expect(
        (await findSandboxMachine(client.db, { accountId: grant.accountId, ...machineScope }))
          ?.state,
      ).toBe("running");
      const instance = preparedMachine.authority.instance;
      container = instance.id;
      expect(container).toMatch(/^[a-f0-9]{64}$/u);
      const real = backend.transport;
      const capability = await real.exec({
        instanceId: container,
        argv: ["/usr/local/bin/opengeni-run", "capabilities"],
      });
      expect(capability.exitCode).toBe(0);
      const capabilities = JournalCapabilities.parse(
        JSON.parse(Buffer.from(capability.stdout).toString()),
      );
      expect(capabilities.bootId).toBe(instance.bootId);
      const setup = {
        setupId: "turn-bootstrap",
        stepId: "workspace",
        command: {
          cmd: "printf x >> /workspace/platform-once; printf ready",
          yieldTimeMs: 120_000,
        },
      };
      const setupOptions = { environment: async () => ({}) };
      expect(
        (await executeSandboxV2SetupStep(client.db, preparedMachine, setup, setupOptions)).stdout,
      ).toBe("ready");
      expect(
        (
          await executeSandboxV2SetupStep(client.db, preparedMachine, setup, {
            environment: async () => {
              throw Error("Completed setup must not refresh credentials");
            },
          })
        ).stdout,
      ).toBe("ready");
      expect(
        Buffer.from(
          (
            await real.exec({
              instanceId: container,
              argv: ["/bin/cat", "/workspace/platform-once"],
            })
          ).stdout,
        ).toString(),
      ).toBe("x");
      await expect(
        executeSandboxV2SetupStep(
          client.db,
          preparedMachine,
          {
            ...setup,
            command: { cmd: "printf conflicting" },
          },
          setupOptions,
        ),
      ).rejects.toThrow();
      const noisySetup = await executeSandboxV2SetupStep(
        client.db,
        preparedMachine,
        {
          setupId: setup.setupId,
          stepId: "large-output",
          command: { cmd: 'bun -e \'process.stdout.write("😀".repeat(150000)+"finished")\'' },
        },
        setupOptions,
      );
      expect(noisySetup.exitCode).toBe(0);
      expect(noisySetup.sessionId).toBeUndefined();
      expect(Buffer.byteLength(noisySetup.stdout)).toBeLessThanOrEqual(256 * 1024);
      expect(noisySetup.stdout.endsWith("finished")).toBe(true);
      expect(noisySetup.stdout.includes("\ufffd")).toBe(false);
      expect(noisySetup.omittedOutputBytes).toBeGreaterThan(0);
      const failedSetup = {
        ...setup,
        stepId: "failed",
        command: { cmd: "printf x >> /workspace/failed-once; exit 13" },
      };
      await expect(
        executeSandboxV2SetupStep(client.db, preparedMachine, failedSetup, setupOptions),
      ).rejects.toBeInstanceOf(SandboxV2SetupFailedError);
      await expect(
        executeSandboxV2SetupStep(client.db, preparedMachine, failedSetup, {
          environment: async () => {
            throw Error("Failed setup must not run again");
          },
        }),
      ).rejects.toBeInstanceOf(SandboxV2SetupFailedError);
      expect(
        Buffer.from(
          (await real.exec({ instanceId: container, argv: ["/bin/cat", "/workspace/failed-once"] }))
            .stdout,
        ).toString(),
      ).toBe("x");
      const file = {
        fileId: "synthetic-file",
        mountPath: ".opengeni/files/synthetic-file",
        filename: "sample.txt",
        sizeBytes: Buffer.byteLength(fileContent),
        sha256: createHash("sha256").update(fileContent).digest("hex"),
      };
      await docker([
        "exec",
        "-d",
        container,
        "bun",
        "-e",
        [
          'import { appendFileSync } from "node:fs";',
          'Bun.serve({hostname:"127.0.0.1",port:45871,fetch(request){',
          "const path=new URL(request.url).pathname;",
          'if(path==="/health") return new Response("ready");',
          'appendFileSync("/workspace/download-count","x");',
          `return new Response(path==="/corrupt"?"bad":${JSON.stringify(fileContent)});`,
          "}});",
        ].join("\n"),
      ]);
      expect(
        (
          await real.exec({
            instanceId: container,
            argv: [
              "/bin/sh",
              "-c",
              "for n in 1 2 3 4 5 6 7 8 9 10; do curl --silent --fail http://127.0.0.1:45871/health && exit 0; sleep 0.1; done; exit 1",
            ],
          })
        ).exitCode,
      ).toBe(0);
      let downloadUrlReads = 0;
      let downloadStarts = 0;
      const deliveryMachine = {
        ...preparedMachine,
        transport: {
          exec: async (request: Parameters<MachineExecTransport["exec"]>[0]) => {
            if (request.argv.includes("start")) {
              downloadStarts++;
              const payload = JSON.parse(Buffer.from(request.stdin!).toString());
              expect(payload.args.join(" ")).not.toContain("signature=");
              expect(payload.environment.OPENGENI_ATTACHMENT_DOWNLOAD_URL).toContain(
                "signature=synthetic",
              );
            }
            return preparedMachine.transport.exec(request);
          },
        },
      };
      const deliveryOptions = {
        environment: async () => ({}),
        resolveDownloadUrl: async () => {
          downloadUrlReads++;
          return "http://127.0.0.1:45871/file?signature=synthetic";
        },
      };
      await deliverSandboxV2File(
        client.db,
        deliveryMachine,
        { setupId: setup.setupId, file },
        deliveryOptions,
      );
      await deliverSandboxV2File(
        client.db,
        deliveryMachine,
        { setupId: setup.setupId, file },
        {
          environment: async () => {
            throw Error("Completed delivery cannot refresh credentials");
          },
          resolveDownloadUrl: async () => {
            throw Error("Completed delivery cannot mint another URL");
          },
        },
      );
      expect(downloadUrlReads).toBe(1);
      expect(downloadStarts).toBe(1);
      expect(await docker(["exec", container, "cat", "/workspace/download-count"])).toBe("x");
      expect(
        await docker([
          "exec",
          container,
          "cat",
          "/workspace/.opengeni/files/synthetic-file/sample.txt",
        ]),
      ).toBe(fileContent.trim());
      await expect(
        deliverSandboxV2File(
          client.db,
          deliveryMachine,
          {
            setupId: setup.setupId,
            file: { ...file, sha256: "a".repeat(64) },
          },
          deliveryOptions,
        ),
      ).rejects.toThrow();
      expect(downloadUrlReads).toBe(1);
      await real.exec({
        instanceId: container,
        argv: [
          "/bin/sh",
          "-c",
          "chmod u+w /workspace/.opengeni/files/synthetic-file/sample.txt; printf keep > /workspace/.opengeni/files/synthetic-file/sample.txt",
        ],
      });
      await expect(
        deliverSandboxV2File(
          client.db,
          preparedMachine,
          {
            setupId: setup.setupId,
            file: { ...file, fileId: "synthetic-corrupt-file" },
          },
          {
            ...deliveryOptions,
            resolveDownloadUrl: async () => "http://127.0.0.1:45871/corrupt?signature=synthetic",
          },
        ),
      ).rejects.toBeInstanceOf(SandboxV2SetupFailedError);
      expect(
        await docker([
          "exec",
          container,
          "cat",
          "/workspace/.opengeni/files/synthetic-file/sample.txt",
        ]),
      ).toBe("keep");
      const syntheticCredential = "synthetic credential ' and newline\nnext";
      const syntheticCredentialFile = "synthetic file material 😀";
      let credentialResolutionReads = 0;
      let credentialStarts = 0;
      let credentialInputs = 0;
      let dropCredentialInputReply = true;
      let credentialGrant = true;
      const authorizeCredentialGeneration = async () => {
        if (!credentialGrant) throw Error("Synthetic credential grant revoked");
      };
      const credentialMachine = {
        ...preparedMachine,
        transport: {
          exec: async (request: Parameters<MachineExecTransport["exec"]>[0]) => {
            if (request.argv.includes("start")) {
              credentialStarts++;
              const payload = Buffer.from(request.stdin!).toString();
              expect(payload).not.toContain(syntheticCredential);
              expect(payload).not.toContain(syntheticCredentialFile);
            }
            if (request.argv.includes("input")) credentialInputs++;
            const nativeReply = await preparedMachine.transport.exec(request);
            if (request.argv.includes("input") && dropCredentialInputReply) {
              throw Error("Dropped synthetic credential input reply");
            }
            return nativeReply;
          },
        },
      };
      const credentialPlan = { setupId: setup.setupId, generationId: "initial-host-generation" };
      const credentialDefinition = {
        generationId: credentialPlan.generationId,
        purpose: "provision" as const,
        forceRefresh: false,
      };
      const credentialKey = crypto.getRandomValues(new Uint8Array(32));
      const credentialOwner = createSandboxV2CredentialGenerationOwner(
        client.db,
        preparedMachine.authority,
        credentialDefinition,
        {
          encryptionKey: credentialKey,
          authorize: authorizeCredentialGeneration,
          resolve: async () => {
            credentialResolutionReads++;
            return {
              status: "ok" as const,
              accountId: preparedMachine.authority.accountId,
              workspaceId,
              sessionId: session.id,
              environment: { SYNTHETIC_CREDENTIAL: syntheticCredential },
              files: [
                { path: "provider/token", content: syntheticCredentialFile, mode: "0400" as const },
              ],
              fileEnvironment: { SYNTHETIC_CREDENTIAL_FILE: "provider/token" },
            };
          },
        },
      );
      await expect(
        installSandboxV2CredentialGeneration(client.db, credentialMachine, credentialPlan, {
          environment: async () => ({}),
          resolveGeneration: credentialOwner.resolveGeneration,
        }),
      ).rejects.toThrow("Exact journal operation is unavailable");
      dropCredentialInputReply = false;
      // The replacement observer cannot ask the broker for newer input bytes.
      const replacementCredentialOwner = createSandboxV2CredentialGenerationOwner(
        client.db,
        preparedMachine.authority,
        credentialDefinition,
        {
          encryptionKey: credentialKey,
          authorize: authorizeCredentialGeneration,
          resolve: async () => {
            throw Error("Recovery cannot refresh broker material");
          },
        },
      );
      await expect(
        replacementCredentialOwner.resolveGeneration("changed-host-generation"),
      ).rejects.toThrow("unavailable or changed");
      await expect(
        replacementCredentialOwner.authorizeGeneration("changed-host-generation"),
      ).rejects.toThrow("unavailable or changed");
      await expect(
        createSandboxV2CredentialGenerationOwner(
          client.db,
          preparedMachine.authority,
          credentialDefinition,
          {
            encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
            authorize: authorizeCredentialGeneration,
            resolve: async () => {
              throw Error("A wrong key cannot refresh broker material");
            },
          },
        ).resolveGeneration(),
      ).rejects.toThrow("unavailable or changed");
      const [sealedCredential] = await fixture.admin<{ ciphertext: string; definition: unknown }[]>`
        select ciphertext,definition from sandbox_v2_credential_generations where attempt_id=${preparedMachine.authority.attemptId}`;
      expect(sealedCredential!.definition).toEqual(credentialDefinition);
      expect(sealedCredential!.ciphertext).not.toContain(syntheticCredential);
      expect(sealedCredential!.ciphertext).not.toContain(syntheticCredentialFile);
      const installedCredentials = await installSandboxV2CredentialGeneration(
        client.db,
        credentialMachine,
        credentialPlan,
        {
          environment: async () => ({}),
          resolveGeneration: replacementCredentialOwner.resolveGeneration,
        },
      );
      expect(installedCredentials.installed).toBe(true);
      expect(
        await installSandboxV2CredentialGeneration(client.db, credentialMachine, credentialPlan, {
          environment: async () => {
            throw Error("Retained credential setup cannot refresh environment");
          },
          resolveGeneration: async () => {
            throw Error("Retained generation cannot resolve new material");
          },
        }),
      ).toEqual(installedCredentials);
      expect(credentialResolutionReads).toBe(1);
      expect(credentialStarts).toBe(1);
      expect(credentialInputs).toBe(4);
      let concurrentBrokerReads = 0;
      let releaseConcurrentBrokers!: () => void;
      const bothConcurrentBrokers = new Promise<void>((resolve) => {
        releaseConcurrentBrokers = resolve;
      });
      const concurrentDefinition = {
        ...credentialDefinition,
        generationId: "concurrent-host-generation",
      };
      const concurrentOwners = [crypto.randomUUID(), crypto.randomUUID()].map((value) =>
        createSandboxV2CredentialGenerationOwner(
          client.db,
          preparedMachine.authority,
          concurrentDefinition,
          {
            encryptionKey: credentialKey,
            authorize: authorizeCredentialGeneration,
            resolve: async () => {
              if (++concurrentBrokerReads === 2) releaseConcurrentBrokers();
              await bothConcurrentBrokers;
              return {
                status: "ok",
                accountId: preparedMachine.authority.accountId,
                workspaceId,
                sessionId: session.id,
                environment: { SYNTHETIC_CONCURRENT: value },
                files: [],
              };
            },
          },
        ),
      );
      const concurrentMaterials = await Promise.all(
        concurrentOwners.map((owner) => owner.resolveGeneration()),
      );
      expect(concurrentMaterials[0]).toEqual(concurrentMaterials[1]);
      expect(concurrentBrokerReads).toBe(2);
      expect(await concurrentOwners[0]!.resolveGeneration()).toEqual(concurrentMaterials[0]);
      expect(concurrentBrokerReads).toBe(2);
      const expiredDefinition = {
        ...credentialDefinition,
        generationId: "expired-host-generation",
      };
      const expiredAt = new Date(Date.now() - 60_000);
      // A previously retained payload can expire while its observer is absent.
      // Keep that original; neither recovery nor dispatch may silently renew it.
      await retainSandboxV2CredentialGeneration(
        client.db,
        preparedMachine.authority,
        expiredDefinition,
        {
          ciphertext: encryptEnvironmentValue(
            credentialKey,
            JSON.stringify({
              version: 1,
              authority: preparedMachine.authority,
              definition: expiredDefinition,
              resolution: {
                status: "ok",
                accountId: preparedMachine.authority.accountId,
                workspaceId,
                sessionId: session.id,
                environment: { SYNTHETIC_EXPIRED: crypto.randomUUID() },
                files: [],
                expiresAt: expiredAt.toISOString(),
              },
            }),
          ),
          expiresAt: expiredAt,
        },
      );
      let expiredBrokerReads = 0;
      const expiredOwner = createSandboxV2CredentialGenerationOwner(
        client.db,
        preparedMachine.authority,
        expiredDefinition,
        {
          encryptionKey: credentialKey,
          authorize: authorizeCredentialGeneration,
          resolve: async () => {
            expiredBrokerReads++;
            throw Error("Expired recovery cannot refresh material");
          },
        },
      );
      await expect(expiredOwner.resolveGeneration()).rejects.toThrow("unavailable or changed");
      await expect(expiredOwner.authorizeGeneration()).rejects.toThrow("unavailable or changed");
      expect(expiredBrokerReads).toBe(0);
      const credentialCheck = await real.exec({
        instanceId: container,
        argv: [
          "/bin/sh",
          "-c",
          withRunCredentialEnvironment(
            [
              `test "$SYNTHETIC_CREDENTIAL" = '${syntheticCredential.replaceAll("'", "'\\''")}'`,
              `test "$(cat "$SYNTHETIC_CREDENTIAL_FILE")" = '${syntheticCredentialFile}'`,
              'test "$(stat -c %a "$SYNTHETIC_CREDENTIAL_FILE")" = 400',
              `test "$(stat -c %a '${installedCredentials.root}/versions/${installedCredentials.versionName}/env')" = 600`,
            ].join("\n"),
            session.id,
          ),
        ],
      });
      expect(credentialCheck.exitCode).toBe(0);
      expect(Buffer.from(credentialCheck.stdout).length).toBe(0);
      let preparationUrlReads = 0;
      const fileOwner = createSandboxV2TurnFileResourceOwner(
        client.db,
        preparedMachine,
        {
          createGetUrl: async ({ key, audience }) => {
            expect(key).toBe(readyFile.objectKey);
            expect(audience).toBe("public");
            preparationUrlReads++;
            return {
              url: "http://127.0.0.1:45871/file?signature=synthetic",
              expiresAt: new Date(Date.now() + 60_000),
            };
          },
        },
        { audience: "public" },
      );
      const turnFiles = await fileOwner.plan();
      expect(turnFiles.resources).toEqual([{ kind: "file", fileId: readyFile.id }]);
      expect(turnFiles.files[0]).toEqual({
        ...file,
        fileId: readyFile.id,
        mountPath: `.opengeni/files/${readyFile.id}`,
      });
      expect(preparationUrlReads).toBe(0);
      await expect(
        fileOwner.resolveDownloadUrl({ ...turnFiles.files[0]!, sha256: "0".repeat(64) }),
      ).rejects.toThrow("changed");
      await expect(
        fileOwner.resolveDownloadUrl({ ...turnFiles.files[0]!, fileId: crypto.randomUUID() }),
      ).rejects.toThrow("outside the current turn");
      expect(preparationUrlReads).toBe(0);
      let nativeAuthorizationReads = 0;
      let nativeBroker: NonNullable<ConnectionCredentialsPort["runCredentials"]> = async () => {
        throw Error("Initial sealed generation must not call the ordinary broker");
      };
      const assertNativeRequest = (request: RunCredentialsRequest) => {
        expect(request).toMatchObject({
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          rootSessionId: session.id,
          attemptId,
          turnId: claimed.turn.id,
          executionGeneration: claimed.turn.executionGeneration,
          effectiveSandboxBackend: "machine-v2",
          sandboxEngine: "machine-v2",
          machineProvider: "docker",
          variableSet: null,
        });
      };
      const nativePort: ConnectionCredentialsPort = {
        runCredentialAuthority: {
          identity: "synthetic-host-authority",
          authorize: async (request, selection) => {
            nativeAuthorizationReads++;
            await authorizeCredentialGeneration();
            assertNativeRequest(request);
            expect(selection.mcpServers).toEqual([renewalMcpTarget]);
            // Host callbacks receive copies: ordinary mutation must not alter
            // the retained request or target selection used on the next call.
            request.initiatorContext = { synthetic: "callback-local" };
            selection.mcpServers[0]!.url = "https://different.example.test/";
          },
        },
        runCredentials: (request) => nativeBroker(request),
      };
      const nativeCredentialContext = {
        db: client.db,
        settings: testSettings({ mcpServers: [{ ...renewalMcpTarget, cacheToolsList: false }] }),
        connectionCredentials: nativePort,
        accountId: grant.accountId,
        workspaceId,
        session: session as unknown as Session,
        turn: claimed.turn as unknown as SessionTurn,
        attemptId,
        variableSet: null,
        effectiveTools: [{ kind: "mcp" as const, id: renewalMcpTarget.id }],
      };
      const credentialSelection = await planSandboxV2RunCredentialSelection(
        nativeCredentialContext,
        preparedMachine,
      );
      expect(credentialSelection.provider).toEqual({
        kind: "host",
        identity: "synthetic-host-authority",
      });
      expect(credentialSelection.mcpServers).toEqual([
        {
          id: renewalMcpTarget.id,
          urlDigest: createHash("sha256").update(renewalMcpTarget.url).digest("hex"),
        },
      ]);
      expect(JSON.stringify(credentialSelection)).not.toContain(renewalMcpTarget.url);
      expect(nativeAuthorizationReads).toBe(0);
      const preparationPlan = {
        setupId: setup.setupId,
        credentialGenerationId: credentialPlan.generationId,
        credentialSelection,
        steps: [
          {
            stepId: "verify-credentials",
            command: {
              cmd: 'test -r "$SYNTHETIC_CREDENTIAL_FILE"; printf stage >> /workspace/preparation-once',
            },
          },
        ],
        files: turnFiles.files,
      };
      let planBuilds = 0;
      const retainedPreparationPlan = await loadOrCreateSandboxV2TurnPreparationPlan(
        client.db,
        preparedMachine,
        preparationPlan.setupId,
        async () => {
          planBuilds++;
          return preparationPlan;
        },
      );
      expect(
        await loadOrCreateSandboxV2TurnPreparationPlan(
          client.db,
          preparedMachine,
          preparationPlan.setupId,
          async () => {
            throw new Error("A replacement worker must load the original host plan");
          },
        ),
      ).toEqual(preparationPlan);
      expect(planBuilds).toBe(1);
      let earlyPreparedBinding: ReturnType<typeof createSandboxV2TurnShell> | undefined;
      const preparedShell = await prepareSandboxV2TurnShell(
        client.db,
        preparedMachine,
        retainedPreparationPlan,
        {
          onBinding: (binding) => {
            earlyPreparedBinding = binding;
            expect(binding.session.state.machineId).toBe(preparedMachine.authority.machineId);
          },
          environment: async () => ({}),
          resolveCredentialGeneration: async () => {
            throw Error("Initial generation already exists");
          },
          authorizeCredentialGeneration: replacementCredentialOwner.authorizeGeneration,
          resolveDownloadUrl: fileOwner.resolveDownloadUrl,
          authorizeFileResources: fileOwner.authorize,
        },
      );
      expect(preparedShell).toBe(earlyPreparedBinding);
      await prepareSandboxV2TurnShell(client.db, preparedMachine, preparationPlan, {
        environment: async () => {
          throw Error("Completed preparation cannot refresh command environment");
        },
        resolveCredentialGeneration: async () => {
          throw Error("Completed preparation cannot resolve credentials");
        },
        authorizeCredentialGeneration: replacementCredentialOwner.authorizeGeneration,
        resolveDownloadUrl: async () => {
          throw Error("Completed preparation cannot mint another download URL");
        },
        authorizeFileResources: fileOwner.authorize,
      });
      expect(preparationUrlReads).toBe(1);
      await expect(
        prepareSandboxV2TurnShell(
          client.db,
          preparedMachine,
          {
            ...preparationPlan,
            steps: [{ ...preparationPlan.steps[0]!, command: { cmd: "printf changed" } }],
          },
          {
            environment: async () => {
              throw Error("Conflicting plan cannot resolve environment");
            },
            resolveCredentialGeneration: async () => {
              throw Error("Conflicting plan cannot resolve credentials");
            },
            authorizeCredentialGeneration: replacementCredentialOwner.authorizeGeneration,
            resolveDownloadUrl: async () => {
              throw Error("Conflicting plan cannot resolve file URLs");
            },
            authorizeFileResources: fileOwner.authorize,
          },
        ),
      ).rejects.toThrow("Retained native preparation plan");
      expect(await docker(["exec", container, "cat", "/workspace/preparation-once"])).toBe("stage");
      const preparedExec = preparedShell.capability
        .clone()
        .bind(preparedShell.session)
        .tools()
        .find((tool) => tool.type === "function" && tool.name === "exec_command");
      if (preparedExec?.type !== "function") throw Error("Prepared shell capability is missing");
      const preparedInput = JSON.stringify({
        cmd: `test -r "$SYNTHETIC_CREDENTIAL_FILE" && test -r ${turnFiles.files[0]!.mountPath}/sample.txt && printf prepared-shell`,
        yield_time_ms: 1000,
      });
      expect(
        await preparedExec.invoke({} as never, preparedInput, {
          toolCall: {
            type: "function_call",
            callId: "prepared-sdk-call",
            name: "exec_command",
            arguments: preparedInput,
          },
        }),
      ).toContain("prepared-shell");
      const turnSettings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
      const scriptedModel = new ScriptedModel([
        {
          output: [
            functionCall(
              "exec_command",
              {
                cmd: `test -r "$SYNTHETIC_CREDENTIAL_FILE" && test -r ${turnFiles.files[0]!.mountPath}/sample.txt && printf model >> /workspace/sdk-model-once`,
                yield_time_ms: 1000,
              },
              "prepared-model-call",
            ),
          ],
        },
        {
          output: [
            functionCall(
              "apply_patch",
              {
                operation: {
                  type: "create_file",
                  path: "standard-patch.txt",
                  diff: "+model created\n",
                },
              },
              "prepared-model-patch",
            ),
          ],
        },
        { output: [assistantMessage("prepared model finished")] },
      ]);
      const scriptedInvocations = createTurnInvocationDrain();
      const scriptedAgent = buildOpenGeniAgent(turnSettings, turnFiles.resources, {
        model: scriptedModel,
        machineSandbox: { ...preparedShell, invocationDrain: scriptedInvocations },
        supportsImageInput: false,
      });
      let admittedModelCalls = 0;
      let settledModelCalls = 0;
      const preparationPhases: string[] = [];
      const scriptedResult = await runAgentStream(
        scriptedAgent,
        "Use the prepared synthetic attachment and credential, then finish.",
        turnSettings,
        {
          beforeModelRequest: () => {
            admittedModelCalls++;
          },
          onModelResponse: () => {
            settledModelCalls++;
          },
          onModelPreparationPhase: (measurement) => preparationPhases.push(measurement.phase),
        },
      );
      for await (const event of scriptedResult) void event;
      await scriptedResult.completed;
      expect(scriptedResult.finalOutput).toBe("prepared model finished");
      expect(admittedModelCalls).toBe(3);
      expect(settledModelCalls).toBe(3);
      expect(scriptedModel.requests[0]!.systemInstructions).toContain("sample.txt");
      expect(scriptedModel.requests[0]!.systemInstructions).not.toContain("signature=");
      expect(preparationUrlReads).toBe(1);
      expect(preparationPhases).toContain("sandbox_session_manifest_inventory");
      expect(preparationPhases).not.toContain("sandbox_client_create");
      expect(preparationPhases).not.toContain("sandbox_client_resume");
      expect(preparationPhases).not.toContain("sandbox_client_delete");
      expect(await docker(["exec", container, "cat", "/workspace/sdk-model-once"])).toBe("model");
      expect(await docker(["exec", container, "cat", "/workspace/standard-patch.txt"])).toBe(
        "model created",
      );
      credentialGrant = false;
      await expect(replacementCredentialOwner.resolveGeneration()).rejects.toThrow(
        "credential grant revoked",
      );
      const deniedCredentialModel = new ScriptedModel("must not use revoked cached credentials");
      const deniedCredentialAgent = buildOpenGeniAgent(turnSettings, turnFiles.resources, {
        model: deniedCredentialModel,
        machineSandbox: preparedShell,
      });
      await expect(
        (async () => {
          const stream = await runAgentStream(
            deniedCredentialAgent,
            "use cached credentials",
            turnSettings,
          );
          for await (const event of stream) void event;
          await stream.completed;
        })(),
      ).rejects.toThrow("credential grant revoked");
      expect(deniedCredentialModel.calls).toBe(0);
      const deniedCredentialInput = JSON.stringify({
        cmd: "printf denied > /workspace/denied-credential-tool",
      });
      await expect(
        preparedExec.invoke({} as never, deniedCredentialInput, {
          toolCall: {
            type: "function_call",
            callId: "denied-credential-tool",
            name: "exec_command",
            arguments: deniedCredentialInput,
          },
        }),
      ).rejects.toThrow("credential grant revoked");
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          "test ! -e /workspace/denied-credential-tool && printf refused",
        ]),
      ).toBe("refused");
      await expect(
        prepareSandboxV2TurnShell(client.db, preparedMachine, preparationPlan, {
          environment: async () => {
            throw Error("Revoked credential replay cannot resolve environment");
          },
          resolveCredentialGeneration: async () => {
            throw Error("Revoked credential replay cannot refresh material");
          },
          authorizeCredentialGeneration: replacementCredentialOwner.authorizeGeneration,
          resolveDownloadUrl: fileOwner.resolveDownloadUrl,
          authorizeFileResources: fileOwner.authorize,
        }),
      ).rejects.toThrow("credential grant revoked");
      expect(credentialResolutionReads).toBe(1);
      credentialGrant = true;
      await withRlsContext(client.db, { accountId: grant.accountId, workspaceId }, (db) =>
        db.execute(
          sql`update files set status='deleted' where account_id=${grant.accountId} and workspace_id=${workspaceId} and id=${readyFile.id}`,
        ),
      );
      await expect(fileOwner.resolveDownloadUrl(turnFiles.files[0]!)).rejects.toThrow("finalized");
      expect(preparationUrlReads).toBe(1);
      const deniedModel = new ScriptedModel("must not read a revoked cached attachment");
      const deniedAgent = buildOpenGeniAgent(turnSettings, turnFiles.resources, {
        model: deniedModel,
        machineSandbox: preparedShell,
      });
      await expect(
        (async () => {
          const stream = await runAgentStream(deniedAgent, "read cached attachment", turnSettings);
          for await (const event of stream) void event;
          await stream.completed;
        })(),
      ).rejects.toThrow("finalized");
      expect(deniedModel.calls).toBe(0);
      const deniedInput = JSON.stringify({ cmd: "printf denied > /workspace/denied-file-tool" });
      await expect(
        preparedExec.invoke({} as never, deniedInput, {
          toolCall: {
            type: "function_call",
            callId: "denied-file-tool",
            name: "exec_command",
            arguments: deniedInput,
          },
        }),
      ).rejects.toThrow("finalized");
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          "test ! -e /workspace/denied-file-tool && printf refused",
        ]),
      ).toBe("refused");
      await expect(
        prepareSandboxV2TurnShell(client.db, preparedMachine, preparationPlan, {
          environment: async () => {
            throw Error("Revoked replay cannot resolve environment");
          },
          resolveCredentialGeneration: async () => {
            throw Error("Revoked replay cannot resolve credentials");
          },
          authorizeCredentialGeneration: replacementCredentialOwner.authorizeGeneration,
          resolveDownloadUrl: fileOwner.resolveDownloadUrl,
          authorizeFileResources: fileOwner.authorize,
        }),
      ).rejects.toThrow("finalized");
      expect(preparationUrlReads).toBe(1);
      await withRlsContext(client.db, { accountId: grant.accountId, workspaceId }, (db) =>
        db.execute(
          sql`update files set status='ready' where account_id=${grant.accountId} and workspace_id=${workspaceId} and id=${readyFile.id}`,
        ),
      );
      let context: SandboxJournalTurnAuthority = {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        executionGeneration: claimed.turn.executionGeneration,
        attemptId,
        machineId: machine.id,
        instance,
        acceptedActionId: "exec-accepted",
      };
      const dropped = new Set(["start", "input"]);
      let starts = 0;
      let inputs = 0;
      let transportCalls = 0;
      let environmentReads = 0;
      const instrumentTransport = (target: MachineExecTransport): MachineExecTransport => ({
        exec: async (input) => {
          transportCalls++;
          const action = input.argv.includes("start")
            ? "start"
            : input.argv.includes("input")
              ? "input"
              : "read";
          if (action === "start") starts++;
          if (action === "input") inputs++;
          const result = await target.exec(input);
          if (dropped.delete(action)) throw Error("Synthetic reply loss after physical execution");
          return result;
        },
      });
      const transport = instrumentTransport(real);
      const compose = (action: string, environment?: () => Promise<Record<string, string>>) =>
        new MachineSandboxSession({
          provider: "docker",
          machineId: machine.id,
          instance,
          transport,
          persistence: createSandboxV2CommandPersistence(client.db, {
            ...context,
            acceptedActionId: action,
          }),
          environment:
            environment ??
            (async () => {
              environmentReads++;
              return {};
            }),
          capabilities,
          workspaceRoot: "/workspace",
        });
      const args = {
        cmd: "printf x >> effect; read -r a; printf '%s😀' \"$a\"; read -r b; printf '%s' \"$b\"; exit 7",
        yieldTimeMs: 0,
      };
      const first = await compose("exec-accepted").exec(args);
      expect(first.sessionId).toBeGreaterThan(0);
      const handle = first.sessionId!;
      await compose("exec-accepted").exec(args);
      expect(environmentReads).toBe(1);
      expect(starts).toBe(2);
      await compose("input-first").writeStdin({
        sessionId: handle,
        chars: "first\n",
        yieldTimeMs: 100,
      });
      const replayedInput = await compose("input-first").writeStdin({
        sessionId: handle,
        chars: "first\n",
        yieldTimeMs: 0,
      });
      expect(replayedInput).toContain("first😀");
      const result = await compose("input-second").writeStdin({
        sessionId: handle,
        chars: "second\n",
        yieldTimeMs: 1000,
      });
      expect(result).toContain("Process exited with code 7");
      expect(inputs).toBe(4);
      expect(await docker(["exec", container, "cat", "/workspace/effect"])).toBe("x");
      const saved = await loadSandboxJournalCommand(client.db, context, {
        handle,
      });
      expect(saved).not.toBeNull();
      async function pending(excludeMaintenance = false) {
        const cleanup = excludeMaintenance
          ? await loadSandboxV2CredentialCleanupForControl(client.db, context)
          : null;
        return withRlsContext(client.db, context, async (tx) => {
          const rows = await tx.execute(sql`select ${sessionAttemptPendingWritersSql(sql`attempt`, {
            ...(cleanup ? { excludeCredentialCleanupOperation: cleanup.operationId } : {}),
          })} as pending
          from session_turn_attempts attempt where attempt.id=${context.attemptId}::uuid`);
          return (rows as unknown as { pending: boolean }[])[0]!.pending;
        });
      }
      // Delivered guest credentials retain a separate maintenance writer.
      // Command-only checks below exclude that exact retained intent; the full
      // predicate stays pending until original guest cleanup physically exits.
      expect(await pending()).toBe(true);
      expect(await pending(true)).toBe(false);
      const beforeLocalFailure = starts + inputs;
      await expect(
        compose("failed-environment", async () => {
          throw Error("Synthetic credential preparation failure");
        }).exec({ cmd: "must not run", yieldTimeMs: 0 }),
      ).rejects.toThrow("credential preparation failure");
      expect(await pending(true)).toBe(false);
      expect(starts + inputs).toBe(beforeLocalFailure);
      await expect(
        compose("failed-environment").exec({
          cmd: "must not run",
          yieldTimeMs: 0,
        }),
      ).rejects.toThrow("abandoned before dispatch");
      await expect(
        compose("invalid-command").exec({
          cmd: "invalid\0command",
          yieldTimeMs: 0,
        }),
      ).rejects.toThrow();
      expect(await pending(true)).toBe(false);
      expect(starts + inputs).toBe(beforeLocalFailure);
      const callId = "retained-sdk-call";
      const callItem = {
        type: "function_call",
        callId,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "printf retained-response",
          yieldTimeMs: 1000,
        }),
      };
      const options = {
        provider: "docker",
        machineId: machine.id,
        instance,
        transport,
        environment: async () => ({}),
        capabilities,
        workspaceRoot: "/workspace",
      };
      const sdkInput = JSON.stringify({
        cmd: "printf x >> /workspace/sdk-once; printf sdk-response",
        yield_time_ms: 1000,
      });
      const sdkCall = {
        type: "function_call" as const,
        callId: "sdk-shell-accepted-call",
        name: "exec_command",
        arguments: sdkInput,
      };
      const binding = createSandboxV2TurnShell(
        client.db,
        {
          ...preparedMachine,
          transport: instrumentTransport(preparedMachine.transport),
        },
        {
          environment: async () => ({}),
          workspaceRoot: "/workspace",
        },
      );
      const sdkExec = binding.capability
        .clone()
        .bind(binding.session)
        .tools()
        .find((tool) => tool.type === "function" && tool.name === "exec_command");
      if (sdkExec?.type !== "function") throw Error("SDK shell did not expose exec_command");
      const beforeSdk = starts;
      await expect(binding.session.execCommand!({ cmd: "true" })).rejects.toThrow(
        "accepted tool action",
      );
      await expect(sdkExec.invoke({} as never, sdkInput)).rejects.toThrow("exact accepted input");
      await expect(
        sdkExec.invoke({} as never, sdkInput, {
          toolCall: { ...sdkCall, arguments: JSON.stringify({ cmd: "printf changed" }) },
        }),
      ).rejects.toThrow("exact accepted input");
      expect(starts).toBe(beforeSdk);
      const sdkReply = await sdkExec.invoke({} as never, sdkInput, { toolCall: sdkCall });
      expect(sdkReply).toContain("sdk-response");
      expect(starts).toBe(beforeSdk + 1);
      // A replacement SDK binding recovers the formatted reply even if fresh
      // credentials and the physical transport are no longer available.
      const replacement = createSandboxV2ShellBinding(client.db, context, {
        ...options,
        transport: {
          exec: async () => {
            throw Error("Replay must not contact the provider");
          },
        },
        environment: async () => {
          throw Error("Replay must not refresh credentials");
        },
      });
      const replayExec = replacement.capability
        .clone()
        .bind(replacement.session)
        .tools()
        .find((tool) => tool.type === "function" && tool.name === "exec_command");
      if (replayExec?.type !== "function") throw Error("Replacement SDK shell is missing");
      expect(await replayExec.invoke({} as never, sdkInput, { toolCall: sdkCall })).toBe(sdkReply);
      expect(starts).toBe(beforeSdk + 1);
      const sdkSideEffect = await real.exec({
        instanceId: container,
        argv: ["/bin/sh", "-c", "cat /workspace/sdk-once"],
      });
      expect(Buffer.from(sdkSideEffect.stdout).toString()).toBe("x");
      const patchTool = (target: typeof binding) => {
        const tools = target.filesystemCapability.clone().bind(target.session).tools();
        expect(tools.some((tool) => tool.type === "function" && tool.name === "view_image")).toBe(
          false,
        );
        const editorTool = tools.find(
          (tool) => tool.type === "function" && tool.name === "apply_patch",
        );
        if (editorTool?.type !== "function") throw Error("Native text editor is missing");
        return editorTool;
      };
      const patchCall = (id: string, operation: Record<string, unknown>) => ({
        type: "function_call" as const,
        name: "apply_patch",
        callId: id,
        arguments: JSON.stringify({ operation }),
      });
      const invokePatch = (target: typeof binding, call: ReturnType<typeof patchCall>) =>
        patchTool(target).invoke({} as never, call.arguments, { toolCall: call });
      const patch = patchCall("patch-update", {
        type: "update_file",
        path: "/workspace/standard-patch.txt",
        diff: "@@\n-model created\n+updated π\n",
      });
      const fileOnlyBinding = createSandboxV2ShellBinding(client.db, context, {
        ...options,
        environment: async () => {
          throw Error("File edits must not resolve broker credentials");
        },
      });
      const patchReply = await invokePatch(fileOnlyBinding, patch);
      expect(patchReply).toBe("Patch applied.");
      expect(await docker(["exec", container, "cat", "/workspace/standard-patch.txt"])).toBe(
        "updated π",
      );
      await docker([
        "exec",
        container,
        "/bin/sh",
        "-c",
        "printf newer > /workspace/standard-patch.txt",
      ]);
      const startsBeforePatchReplay = starts;
      expect(await invokePatch(replacement, patch)).toBe(patchReply);
      expect(starts).toBe(startsBeforePatchReplay);
      expect(await docker(["exec", container, "cat", "/workspace/standard-patch.txt"])).toBe(
        "newer",
      );
      const forbiddenPath = patchCall("patch-outside", {
        type: "create_file",
        path: "../outside.txt",
        diff: "+no\n",
      });
      const outsideStarts = starts;
      expect(await invokePatch(binding, forbiddenPath)).toContain("inside the workspace");
      expect(starts).toBe(outsideStarts);
      await docker(["exec", container, "/bin/sh", "-c", "ln -s /tmp /workspace/editor-link"]);
      expect(
        await invokePatch(
          binding,
          patchCall("patch-link", {
            type: "create_file",
            path: "editor-link/outside.txt",
            diff: "+no\n",
          }),
        ),
      ).toContain("Filesystem operation was refused");
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          "test ! -e /tmp/outside.txt && printf refused",
        ]),
      ).toBe("refused");
      expect(
        await invokePatch(
          binding,
          patchCall("patch-existing", {
            type: "create_file",
            path: "standard-patch.txt",
            diff: "+must not replace\n",
          }),
        ),
      ).toContain("Destination already exists");
      expect(await docker(["exec", container, "cat", "/workspace/standard-patch.txt"])).toBe(
        "newer",
      );
      expect(
        await invokePatch(
          binding,
          patchCall("patch-move", {
            type: "update_file",
            path: "standard-patch.txt",
            moveTo: "nested/moved.txt",
            diff: "@@\n-newer\n+moved\n",
          }),
        ),
      ).toBe("Patch applied.");
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          "test ! -e /workspace/standard-patch.txt && cat /workspace/nested/moved.txt",
        ]),
      ).toBe("moved");
      expect(
        await invokePatch(
          binding,
          patchCall("patch-delete", {
            type: "delete_file",
            path: "nested/moved.txt",
          }),
        ),
      ).toBe("Patch applied.");
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          "test ! -e /workspace/nested/moved.txt && printf removed",
        ]),
      ).toBe("removed");
      // Lost command replies remain pending outside the SDK's text renderer.
      // A replacement observer completes the original command/input identities.
      const uncertainPatch = patchCall("patch-uncertain", {
        type: "create_file",
        path: "uncertain-patch.txt",
        diff: "+once\n",
      });
      const uncertainEditor = createSandboxV2ShellBinding(client.db, context, {
        ...options,
        journal: { attempts: 1 },
        transport: {
          exec: async (request) => {
            const response = await transport.exec(request);
            if (request.argv.includes("start")) throw Error("Synthetic editor reply loss");
            return response;
          },
        },
      });
      const beforeUncertainPatch = starts;
      await expect(invokePatch(uncertainEditor, uncertainPatch)).rejects.toThrow();
      expect(
        await loadSandboxJournalToolReply(client.db, {
          ...context,
          acceptedActionId: uncertainPatch.callId,
        }),
      ).toBeNull();
      expect(starts).toBe(beforeUncertainPatch + 1);
      expect(await invokePatch(binding, uncertainPatch)).toBe("Patch applied.");
      expect(starts).toBe(beforeUncertainPatch + 1);
      expect(await docker(["exec", container, "cat", "/workspace/uncertain-patch.txt"])).toBe(
        "once",
      );
      await docker([
        "exec",
        container,
        "/usr/local/bin/bun",
        "-e",
        'await Bun.write("/workspace/large-edit.txt","head\\n"+"a".repeat(131060)+"\\n"); await Bun.write("/workspace/too-large.txt","a".repeat(131073)); await Bun.write("/workspace/bom-edit.txt","\\ufeffold\\n");',
      ]);
      await docker(["exec", container, "chmod", "0770", "/workspace/large-edit.txt"]);
      expect(
        await invokePatch(
          binding,
          patchCall("patch-large", {
            type: "update_file",
            path: "large-edit.txt",
            diff: "@@\n-head\n+next\n",
          }),
        ),
      ).toBe("Patch applied.");
      expect(
        await docker([
          "exec",
          container,
          "/usr/local/bin/bun",
          "-e",
          'const fs=await import("node:fs"); const text=await Bun.file("/workspace/large-edit.txt").text(); process.stdout.write(JSON.stringify({head:text.slice(0,5),bytes:Buffer.byteLength(text),mode:fs.statSync("/workspace/large-edit.txt").mode&0o777}));',
        ]),
      ).toBe(JSON.stringify({ head: "next\n", bytes: 131066, mode: 0o770 }));
      expect(
        await invokePatch(
          binding,
          patchCall("patch-too-large", {
            type: "update_file",
            path: "too-large.txt",
            diff: "@@\n-no\n+no\n",
          }),
        ),
      ).toContain("native text editor limit");
      const startsBeforeOversizedCreate = starts;
      expect(
        await invokePatch(
          binding,
          patchCall("patch-oversized-create", {
            type: "create_file",
            path: "oversized-create.txt",
            diff: `+${"π".repeat(65537)}\n`,
          }),
        ),
      ).toContain("native text editor limit");
      expect(starts).toBe(startsBeforeOversizedCreate);
      expect(
        await invokePatch(
          binding,
          patchCall("patch-bom", {
            type: "update_file",
            path: "bom-edit.txt",
            diff: "@@\n-\ufeffold\n+\ufeffnew\n",
          }),
        ),
      ).toBe("Patch applied.");
      expect(
        await docker([
          "exec",
          container,
          "/usr/local/bin/bun",
          "-e",
          'process.stdout.write(Buffer.from(await Bun.file("/workspace/bom-edit.txt").arrayBuffer()).toString("hex"));',
        ]),
      ).toBe("efbbbf6e65770a");
      // The SDK's stdin error path must preserve an uncertain accepted action,
      // not acknowledge retry advice. Deliver input once, lose every reply, and
      // recover the same action/sequence through a replacement SDK observer.
      let dropSdkInput = true;
      const uncertainBinding = createSandboxV2ShellBinding(client.db, context, {
        ...options,
        capabilities: { ...capabilities, pty: false },
        journal: { attempts: 1 },
        transport: {
          exec: async (request) => {
            const physicalResult = await transport.exec(request);
            if (dropSdkInput && request.argv.includes("input"))
              throw Error("Synthetic SDK stdin reply loss");
            return physicalResult;
          },
        },
      });
      const pipeTools = uncertainBinding.capability.clone().bind(uncertainBinding.session).tools();
      const pipeExec = pipeTools.find(
        (tool) => tool.type === "function" && tool.name === "exec_command",
      );
      const pipeInput = pipeTools.find(
        (tool) => tool.type === "function" && tool.name === "write_stdin",
      );
      if (pipeExec?.type !== "function" || pipeInput?.type !== "function")
        throw Error("Native pipe execution and polling must both be available");
      const pipeArgs = JSON.stringify({
        cmd: "read -r a; printf '%s' \"$a\" >> /workspace/sdk-input-effect; printf first-input; read -r b; printf second-input",
        yield_time_ms: 0,
      });
      const pipeCall = {
        type: "function_call" as const,
        name: "exec_command",
        callId: "sdk-pipe-exec",
        arguments: pipeArgs,
      };
      const pipeReply = await pipeExec.invoke({} as never, pipeArgs, { toolCall: pipeCall });
      const pipeHandle = Number(
        /Process running with session ID (\d+)/.exec(pipeReply as string)?.[1],
      );
      expect(pipeHandle).toBeGreaterThan(0);
      const inputArgs = JSON.stringify({
        session_id: pipeHandle,
        chars: "once\n",
        yield_time_ms: 0,
      });
      const inputCall = {
        type: "function_call" as const,
        name: "write_stdin",
        callId: "sdk-pipe-input",
        arguments: inputArgs,
      };
      await expect(
        pipeInput.invoke({} as never, inputArgs, { toolCall: inputCall }),
      ).rejects.toThrow("retain its dispatch identity");
      const inputAuthority = { ...context, acceptedActionId: inputCall.callId };
      expect(await loadSandboxJournalToolReply(client.db, inputAuthority)).toBeNull();
      expect(await pending(true)).toBe(true);
      dropSdkInput = false;
      const recoveredInput = await pipeInput.invoke({} as never, inputArgs, {
        toolCall: inputCall,
      });
      expect(await loadSandboxJournalToolReply(client.db, inputAuthority)).toBe(recoveredInput);
      const finishArgs = JSON.stringify({
        session_id: pipeHandle,
        chars: "done\n",
        yield_time_ms: 1000,
      });
      const finishCall = {
        type: "function_call" as const,
        name: "write_stdin",
        callId: "sdk-pipe-finish",
        arguments: finishArgs,
      };
      expect(await pipeInput.invoke({} as never, finishArgs, { toolCall: finishCall })).toContain(
        "Process exited with code 0",
      );
      const inputEffect = await real.exec({
        instanceId: container,
        argv: ["/bin/sh", "-c", "cat /workspace/sdk-input-effect"],
      });
      expect(Buffer.from(inputEffect.stdout).toString()).toBe("once");
      const inputsBeforeReplyReplay = inputs;
      expect(await pipeInput.invoke({} as never, inputArgs, { toolCall: inputCall })).toBe(
        recoveredInput,
      );
      expect(inputs).toBe(inputsBeforeReplyReplay);
      expect(await pending(true)).toBe(false);
      const aborted = new AbortController();
      aborted.abort(Error("Synthetic revoked SDK invocation"));
      const abortedCall = { ...sdkCall, callId: "sdk-aborted-call" };
      const beforeAborted = transportCalls;
      await expect(
        sdkExec.invoke({} as never, sdkInput, {
          toolCall: abortedCall,
          signal: aborted.signal,
        }),
      ).rejects.toThrow("revoked SDK invocation");
      expect(transportCalls).toBe(beforeAborted);
      let invocations = 0;
      const invoke = (acceptedSession: MachineSandboxSession) => {
        invocations++;
        return acceptedSession.execCommand({
          cmd: "printf retained-response",
          yieldTimeMs: 1000,
        });
      };
      const reply = await executeSandboxV2AcceptedToolAction(
        client.db,
        { ...context, acceptedActionId: callId },
        options,
        callItem,
        invoke,
      );
      const startCount = starts;
      const replay = await executeSandboxV2AcceptedToolAction(
        client.db,
        { ...context, acceptedActionId: callId },
        options,
        callItem,
        invoke,
      );
      expect(replay).toBe(reply);
      expect(reply).toContain("retained-response");
      expect(invocations).toBe(1);
      expect(starts).toBe(startCount);
      const compoundId = "compound-sdk-call";
      const compoundCall = {
        type: "function_call",
        callId: compoundId,
        name: "synthetic_compound_command",
        arguments: "{}",
      };
      const compoundAuthority = { ...context, acceptedActionId: compoundId };
      let compoundInvocations = 0;
      const compoundStarts = starts;
      const invokeCompound = async (
        _root: MachineSandboxSession,
        operation: (key: string) => MachineSandboxSession,
      ) => {
        compoundInvocations++;
        const firstStepReply = await operation("first").execCommand({
          cmd: "printf a >> compound-effect; printf first-result",
          yieldTimeMs: 1000,
        });
        if (compoundInvocations === 1)
          throw Error("Synthetic observer loss after first compound step");
        const second = await operation("second").execCommand({
          cmd: "printf b >> compound-effect; printf second-result",
          yieldTimeMs: 1000,
        });
        return `${firstStepReply}\n${second}`;
      };
      await expect(
        executeSandboxV2AcceptedToolAction(
          client.db,
          compoundAuthority,
          options,
          compoundCall,
          invokeCompound,
        ),
      ).rejects.toThrow("observer loss");
      const compoundReply = await executeSandboxV2AcceptedToolAction(
        client.db,
        compoundAuthority,
        options,
        compoundCall,
        invokeCompound,
      );
      expect(compoundReply).toContain("first-result");
      expect(compoundReply).toContain("second-result");
      expect(await docker(["exec", container, "cat", "/workspace/compound-effect"])).toBe("ab");
      expect(starts - compoundStarts).toBe(2);
      expect(
        await executeSandboxV2AcceptedToolAction(
          client.db,
          compoundAuthority,
          options,
          compoundCall,
          invokeCompound,
        ),
      ).toBe(compoundReply);
      expect(compoundInvocations).toBe(2);
      expect(starts - compoundStarts).toBe(2);
      for (const [index, value] of [
        "embedded\0null",
        "lone\ud800",
        "opengeni_lossless_json_string_v2_81f06e15:literal",
      ].entries()) {
        const specialId = `lossless-reply-${index}`;
        let specialInvocations = 0;
        const specialCall = {
          type: "function_call",
          callId: specialId,
          name: "synthetic_command_reply",
          arguments: "{}",
        };
        const invokeSpecial = async () => {
          specialInvocations++;
          return value;
        };
        const action = { ...context, acceptedActionId: specialId };
        expect(
          await executeSandboxV2AcceptedToolAction(
            client.db,
            action,
            options,
            specialCall,
            invokeSpecial,
          ),
        ).toBe(value);
        expect(
          await executeSandboxV2AcceptedToolAction(
            client.db,
            action,
            options,
            specialCall,
            invokeSpecial,
          ),
        ).toBe(value);
        expect(specialInvocations).toBe(1);
      }
      // Physical completion does not adopt an unfinished tool action. Retain
      // an exact command receipt but lose its observer before the full reply.
      const unfinishedCall = {
        type: "function_call",
        callId: "unfinished-sdk-call",
        name: "exec_command",
        arguments: "{}",
      };
      let unfinishedInvocations = 0;
      const unfinished = async (unfinishedSession: MachineSandboxSession) => {
        unfinishedInvocations++;
        await unfinishedSession.execCommand({
          cmd: "printf x >> /workspace/unfinished-once",
          yieldTimeMs: 1000,
        });
        throw Error("Synthetic observer death before formatted reply");
      };
      await expect(
        executeSandboxV2AcceptedToolAction(
          client.db,
          { ...context, acceptedActionId: unfinishedCall.callId },
          options,
          unfinishedCall,
          unfinished,
        ),
      ).rejects.toThrow("before formatted reply");
      const stranded = await createSandboxV2CommandPersistence(client.db, {
        ...context,
        acceptedActionId: "stranded-allocation",
      }).allocateOperationId({ requestDigest: "f".repeat(64) });
      const beforeAttemptRecovery = starts;
      // Ordinary renewal recovery: a physical stdin reply is lost. The durable
      // pending ticket and encrypted original survive; recovery cannot mint a
      // replacement. The initial writer was already completed by preparation.
      let renewalBrokerReads = 0;
      let dropRenewalReply = false;
      const adoptedOrdinals: number[] = [];
      const renewalMcp = new RunMcpCredentials([renewalMcpTarget]);
      const renewalMcpToken = "Bearer synthetic-renewal-header";
      const lifecycleMachine = {
        ...preparedMachine,
        transport: {
          exec: async (request: Parameters<MachineExecTransport["exec"]>[0]) => {
            if (request.stdin) {
              const body = JSON.parse(Buffer.from(request.stdin).toString());
              expect(JSON.stringify(body)).not.toContain(renewalMcpToken);
              if (request.argv.includes("input") && body.input.kind === "data") {
                const delivered = Buffer.from(body.input.base64, "base64").toString();
                expect(delivered).not.toContain(renewalMcpToken);
                expect(delivered).not.toContain(renewalMcpTarget.url);
              }
            }
            const nativeReply = await preparedMachine.transport.exec(request);
            if (dropRenewalReply && request.argv.includes("input"))
              throw Error("Dropped ordinary renewal input reply");
            return nativeReply;
          },
        },
      };
      const lifecycleOptions = {
        encryptionKey: credentialKey,
        environment: async () => ({}),
        onActivate: (
          value: import("../src/sandbox-v2-credential-lifecycle").SandboxV2ActiveCredentials,
        ) => {
          adoptedOrdinals.push(value.ticket.ordinal);
          renewalMcp.replaceGeneration(
            {
              attemptId: preparedMachine.authority.attemptId,
              generationId: value.ticket.definition.generationId,
              ordinal: value.ticket.ordinal,
            },
            normalizeRunCredentialsResolution(value.resolution, preparedMachine.authority),
          );
        },
      };
      nativeBroker = async (request) => {
        assertNativeRequest(request);
        expect(request.purpose).toBe("renewal");
        expect(request.forceRefresh).toBe(true);
        renewalBrokerReads++;
        return {
          status: "ok",
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
          environment: { SYNTHETIC_RENEWED: "generation-one" },
          mcp: [{ url: renewalMcpTarget.url, headers: { Authorization: renewalMcpToken } }],
          files: [],
          fileEnvironment: {},
        };
      };
      const firstLifecycle = createSandboxV2RunCredentialOwner(
        nativeCredentialContext,
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      expect((await firstLifecycle.ensure()).ticket.ordinal).toBe(0);
      expect(renewalBrokerReads).toBe(0);
      dropRenewalReply = true;
      await expect(firstLifecycle.renew(credentialPlan.generationId)).rejects.toThrow(
        "Exact journal operation is unavailable",
      );
      const pendingRenewal = await loadSandboxV2CredentialOwner(
        client.db,
        preparedMachine.authority,
        preparationPlan.setupId,
      );
      expect(pendingRenewal.active!.ordinal).toBe(0);
      expect(pendingRenewal.pending!.ordinal).toBe(1);
      expect(renewalBrokerReads).toBe(1);
      await expect(firstLifecycle.authorizeCurrent()).rejects.toThrow("unavailable or changed");
      const retryReservations = await Promise.all(
        Array.from({ length: 4 }, () =>
          reserveSandboxV2CredentialRenewal(client.db, preparedMachine.authority, {
            setupId: preparationPlan.setupId,
            expectedGenerationId: credentialPlan.generationId,
          }),
        ),
      );
      for (const retryReservation of retryReservations)
        expect(retryReservation).toEqual(pendingRenewal);
      dropRenewalReply = false;
      nativeBroker = async () => {
        throw Error("Pending generation recovery must not mint new material");
      };
      const replacementLifecycle = createSandboxV2RunCredentialOwner(
        nativeCredentialContext,
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      const renewed = await replacementLifecycle.ensure();
      expect(renewed.ticket).toEqual(pendingRenewal.pending);
      expect(renewed.resolution.status).toBe("ok");
      expect(renewalBrokerReads).toBe(1);
      expect(adoptedOrdinals).toEqual([0, 1]);
      expect(
        new Headers(renewalMcp.requestInit(renewalMcpTarget, renewalMcpTarget.url)?.headers).get(
          "Authorization",
        ),
      ).toBe(renewalMcpToken);
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          withRunCredentialEnvironment(
            'test "$SYNTHETIC_RENEWED" = generation-one && test -z "${SYNTHETIC_CREDENTIAL-}" && printf renewed',
            session.id,
          ),
        ]),
      ).toBe("renewed");
      const afterRenewal = await loadSandboxV2CredentialOwner(
        client.db,
        preparedMachine.authority,
        preparationPlan.setupId,
      );
      expect(afterRenewal.pending).toBeNull();
      // A late timer with its old predecessor reads the current generation and
      // cannot reserve ordinal 2. Replaying old activation cannot rewind it.
      expect((await firstLifecycle.renew(credentialPlan.generationId)).ticket).toEqual(
        renewed.ticket,
      );
      expect(renewalBrokerReads).toBe(1);
      expect(
        (
          await loadSandboxV2CredentialOwner(
            client.db,
            preparedMachine.authority,
            preparationPlan.setupId,
          )
        ).version,
      ).toBe(afterRenewal.version);
      expect(
        (
          await activateSandboxV2CredentialTicket(client.db, preparedMachine.authority, {
            setupId: preparationPlan.setupId,
            ticket: pendingRenewal.active!,
          })
        ).active,
      ).toEqual(renewed.ticket);
      let emptyRenewalReads = 0;
      nativeBroker = async (request) => {
        assertNativeRequest(request);
        emptyRenewalReads++;
        return {
          status: "not_applicable",
          accountId: grant.accountId,
          workspaceId,
          sessionId: session.id,
        };
      };
      const emptyLifecycle = createSandboxV2RunCredentialOwner(
        nativeCredentialContext,
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      const emptyGeneration = await emptyLifecycle.renew(renewed.ticket.definition.generationId);
      expect(emptyGeneration.ticket.ordinal).toBe(2);
      expect(emptyGeneration.resolution.status).toBe("not_applicable");
      expect(() => renewalMcp.requestInit(renewalMcpTarget, renewalMcpTarget.url)).toThrow(
        "authentication unavailable",
      );
      expect(
        renewalMcp.replaceGeneration(
          {
            attemptId: preparedMachine.authority.attemptId,
            generationId: renewed.ticket.definition.generationId,
            ordinal: renewed.ticket.ordinal,
          },
          normalizeRunCredentialsResolution(renewed.resolution, preparedMachine.authority),
        ),
      ).toBe(false);
      expect(() => renewalMcp.requestInit(renewalMcpTarget, renewalMcpTarget.url)).toThrow(
        "authentication unavailable",
      );
      expect(emptyRenewalReads).toBe(1);
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          withRunCredentialEnvironment(
            'test -z "${SYNTHETIC_RENEWED-}" && test -z "${SYNTHETIC_CREDENTIAL-}" && printf empty',
            session.id,
          ),
        ]),
      ).toBe("empty");
      nativeBroker = async () => {
        throw Error("Activated empty generation recovery cannot refresh material");
      };
      const recoveredEmpty = createSandboxV2RunCredentialOwner(
        nativeCredentialContext,
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      expect((await recoveredEmpty.ensure()).ticket).toEqual(emptyGeneration.ticket);
      expect(nativeAuthorizationReads).toBeGreaterThan(0);
      credentialGrant = false;
      await expect(recoveredEmpty.authorizeCurrent()).rejects.toThrow("revoked");
      credentialGrant = true;
      await recoveredEmpty.authorizeCurrent();
      const differentHost = createSandboxV2RunCredentialOwner(
        {
          ...nativeCredentialContext,
          connectionCredentials: {
            ...nativePort,
            runCredentialAuthority: {
              ...nativePort.runCredentialAuthority!,
              identity: "different-host-authority",
            },
          },
        },
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      await expect(differentHost.ensure()).rejects.toThrow("unavailable or changed");
      const changedTargets = createSandboxV2RunCredentialOwner(
        { ...nativeCredentialContext, effectiveTools: [] },
        lifecycleMachine,
        preparationPlan,
        lifecycleOptions,
      );
      await expect(changedTargets.ensure()).rejects.toThrow("unavailable or changed");
      expect(renewalBrokerReads).toBe(1);
      expect(emptyRenewalReads).toBe(1);
      const nativePreparedAfterRenewal = await prepareSandboxV2TurnShell(
        client.db,
        preparedMachine,
        preparationPlan,
        {
          environment: async () => ({}),
          credentialLifecycle: recoveredEmpty,
          resolveDownloadUrl: fileOwner.resolveDownloadUrl,
          authorizeFileResources: fileOwner.authorize,
        },
      );
      expect(typeof nativePreparedAfterRenewal.authorizeResources).toBe("function");
      credentialGrant = false;
      await expect(nativePreparedAfterRenewal.authorizeResources!()).rejects.toThrow(
        "credential grant revoked",
      );
      credentialGrant = true;
      renewalMcp.close();
      // Seed only this disposable fixture's new canonical attempt. Retain the
      // origin identities and deliberately omit physical-settlement evidence.
      const oldContext = context;
      const replacementId = crypto.randomUUID();
      const rows = await withRlsContext(client.db, context, (tx) =>
        tx.execute(sql`select request_digest from sandbox_v2_commands
          where session_id=${context.sessionId}::uuid and accepted_action_id=${sandboxV2CausalActionId(callId)}`),
      );
      const digest = (rows as unknown as { request_digest: string }[])[0]!.request_digest;
      const admin = createDb(fixture.adminUrl);
      try {
        await withRlsContext(admin.db, context, async (tx) => {
          await tx.execute(sql`set local opengeni.session_inference_claim='1'`);
          await tx.execute(sql`update session_turn_attempts set state='closed',outcome='completed',
            closed_at=now() where id=${context.attemptId}::uuid`);
          await tx.execute(sql`update session_turns set active_attempt_id=${replacementId}::uuid,
            execution_generation=execution_generation+1,version=version+1 where id=${context.turnId}::uuid`);
          await tx.execute(sql`insert into session_turn_attempts
            (id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
             temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,
             authority_epoch,authority_visibility,authority_owner_organization_membership_id,
             personal_resource_protocol_version,mcp_approval_policies,connector_action_policies)
            select ${replacementId}::uuid,account_id,workspace_id,session_id,turn_id,execution_generation+1,
             'claimed',temporal_workflow_id,${crypto.randomUUID()},${crypto.randomUUID()},verified_control_revision,
             authority_epoch,authority_visibility,authority_owner_organization_membership_id,
             personal_resource_protocol_version,mcp_approval_policies,connector_action_policies
            from session_turn_attempts where id=${context.attemptId}::uuid`);
        });
      } finally {
        await admin.close();
      }
      context = {
        ...context,
        attemptId: replacementId,
        executionGeneration: context.executionGeneration + 1,
      };
      await acquireSandboxMachineForAttempt(client.db, context);
      expect(await releaseRevokedSandboxMachineAttempt(client.db, oldContext)).toBe(false);
      const successorCredentialOwner = createSandboxV2CredentialGenerationOwner(
        client.db,
        context,
        credentialDefinition,
        {
          encryptionKey: credentialKey,
          authorize: authorizeCredentialGeneration,
          resolve: async () => ({
            status: "not_applicable",
            accountId: context.accountId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
          }),
        },
      );
      expect((await successorCredentialOwner.resolveGeneration()).status).toBe("not_applicable");
      await expect(
        clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, oldContext),
      ).rejects.toThrow("unavailable or changed");
      await expect(
        executeSandboxV2AcceptedToolAction(
          client.db,
          { ...context, acceptedActionId: callId },
          options,
          callItem,
          invoke,
        ),
      ).rejects.toThrow("settled predecessor authority");
      const settleAdmin = createDb(fixture.adminUrl);
      try {
        await withRlsContext(settleAdmin.db, oldContext, (tx) =>
          tx.execute(sql`update session_turn_attempts set quiesced_at=now()
            where id=${oldContext.attemptId}::uuid`),
        );
      } finally {
        await settleAdmin.close();
      }
      // A timestamp cannot hide an unresolved physical dispatch/allocation.
      await expect(
        loadSandboxJournalToolReply(client.db, { ...context, acceptedActionId: callId }),
      ).rejects.toThrow("settled predecessor authority");
      await expect(
        clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, oldContext),
      ).rejects.toThrow("unavailable or changed");
      expect(await abandonUnboundSandboxJournalControl(client.db, oldContext, stranded)).toBe(true);
      // Narrow ordinary guest cleanup has its own retained maintenance intent.
      // Losing its first physical reply permits only observation of that exact
      // operation, including after a successor publishes its own version.
      let cleanupStarts = 0;
      let loseCleanupReply = true;
      const cleanupTransport: MachineExecTransport = {
        exec: async (request) => {
          if (request.argv.includes("start")) cleanupStarts++;
          const physicalReply = await real.exec(request);
          if (request.argv.includes("start") && loseCleanupReply) {
            loseCleanupReply = false;
            throw Error("Synthetic credential cleanup reply loss");
          }
          return physicalReply;
        },
      };
      await expect(
        reconcileSandboxV2GuestCredentialCleanup(client.db, oldContext, cleanupTransport),
      ).rejects.toBeInstanceOf(JournalUnavailableError);
      const pendingCleanup = await loadSandboxV2CredentialCleanupForControl(client.db, oldContext);
      expect(pendingCleanup?.binding).not.toBeNull();
      expect(pendingCleanup?.proof).toBeNull();
      // This diagnostic only arranges the disposable successor fixture. Native
      // proof remains pending until the original journal observation is stored.
      for (let i = 0; i < 50; i++) {
        const empty = await real.exec({
          instanceId: container,
          argv: ["/bin/sh", "-c", `test ! -e '${installedCredentials.root}/current'`],
        });
        if (empty.exitCode === 0) break;
        await Bun.sleep(20);
      }
      const successorMachine = { ...preparedMachine, authority: { ...context }, transport: real };
      const successorInstalled = await installSandboxV2CredentialGeneration(
        client.db,
        successorMachine,
        { setupId: "successor-credentials", generationId: credentialDefinition.generationId },
        {
          environment: async () => ({}),
          resolveGeneration: successorCredentialOwner.resolveGeneration,
        },
      );
      expect(successorInstalled.installed).toBe(false);
      let cleanup = await reconcileSandboxV2GuestCredentialCleanup(
        client.db,
        oldContext,
        cleanupTransport,
      );
      for (let i = 0; i < 50 && cleanup.state !== "complete"; i++) {
        await Bun.sleep(20);
        cleanup = await reconcileSandboxV2GuestCredentialCleanup(
          client.db,
          oldContext,
          cleanupTransport,
        );
      }
      expect(cleanup.state).toBe("complete");
      expect(cleanup.operationId).toBe(pendingCleanup!.operationId);
      expect(cleanupStarts).toBe(1);
      expect(await releaseRevokedSandboxMachineAttempt(client.db, oldContext)).toBe(true);
      expect(await docker(["exec", container, "cat", `${installedCredentials.root}/current`])).toBe(
        successorInstalled.versionName,
      );
      expect(
        await docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          `test ! -e '${installedCredentials.root}/versions/${installedCredentials.versionName}' && test -d '${installedCredentials.root}/versions/${successorInstalled.versionName}' && printf preserved`,
        ]),
      ).toBe("preserved");
      expect(
        (
          await reconcileSandboxV2GuestCredentialCleanup(client.db, oldContext, {
            exec: async () => {
              throw Error("Completed maintenance cannot contact provider");
            },
          })
        ).state,
      ).toBe("complete");
      const [originalDispatch] = await withRlsContext(client.db, oldContext, (tx) =>
        tx.execute<{
          workflow: string;
          run: string;
          activity: string;
        }>(sql`select temporal_workflow_id as workflow,temporal_workflow_run_id as run,
        temporal_activity_id as activity from session_turn_attempts where id=${oldContext.attemptId}::uuid`),
      );
      await commitSessionAttemptQuiescence(client.db, {
        accountId: oldContext.accountId,
        workspaceId: oldContext.workspaceId,
        sessionId: oldContext.sessionId,
        attemptId: oldContext.attemptId,
        temporalWorkflowId: originalDispatch!.workflow,
        temporalWorkflowRunId: originalDispatch!.run,
        temporalActivityId: originalDispatch!.activity,
        nativeAuthority: oldContext,
        allowUninterrupted: true,
      });
      expect(
        await clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, oldContext),
      ).toBe(0);
      expect(
        await clearSandboxV2CredentialGenerationsForQuiescedAttempt(client.db, oldContext),
      ).toBe(0);
      expect((await successorCredentialOwner.resolveGeneration()).status).toBe("not_applicable");
      const oldCredentials = await fixture.admin<{ ciphertext: string | null; cleared: boolean }[]>`
        select ciphertext,cleared_at is not null as cleared from sandbox_v2_credential_generations
        where attempt_id=${oldContext.attemptId}`;
      expect(oldCredentials).toHaveLength(5);
      for (const oldCredential of oldCredentials)
        expect(oldCredential).toEqual({ ciphertext: null, cleared: true });
      const recoveredReply = await executeSandboxV2AcceptedToolAction(
        client.db,
        { ...context, acceptedActionId: callId },
        {
          ...options,
          transport: {
            exec: async () => {
              throw Error("Completed reply must not contact provider");
            },
          },
          environment: async () => {
            throw Error("Completed reply must not refresh credentials");
          },
        },
        callItem,
        invoke,
      );
      expect(recoveredReply).toBe(reply);
      await expect(
        executeSandboxV2AcceptedToolAction(
          client.db,
          { ...context, acceptedActionId: unfinishedCall.callId },
          options,
          unfinishedCall,
          unfinished,
        ),
      ).rejects.toThrow("protected attempt adoption");
      expect(unfinishedInvocations).toBe(1);
      await expect(
        createSandboxV2CommandPersistence(client.db, {
          ...context,
          acceptedActionId: callId,
        }).allocateOperationId({ requestDigest: digest }),
      ).rejects.toThrow("protected attempt adoption");
      expect(invocations).toBe(1);
      expect(starts).toBe(beforeAttemptRecovery);
      await expect(
        loadSandboxJournalToolReply(client.db, { ...oldContext, acceptedActionId: callId }),
      ).rejects.toThrow("authority rejected");
      await expect(loadSandboxJournalCommand(client.db, oldContext, { handle })).rejects.toThrow(
        "authority rejected",
      );
      // Revocation may advance session authority while retaining conversation
      // and command history. Seed a newer accepted snapshot through the fixture
      // administrator's transaction-bound capability; never rewrite an attempt.
      const epochPrior = context;
      const epochAttemptId = crypto.randomUUID();
      const epochAdmin = createDb(fixture.adminUrl);
      try {
        await withRlsContext(epochAdmin.db, context, async (tx) => {
          await tx.execute(sql`set local opengeni.session_inference_claim='1'`);
          await tx.execute(sql`update session_turn_attempts set state='closed',outcome='completed',
            closed_at=now(),quiesced_at=now() where id=${context.attemptId}::uuid`);
          const capabilityId = crypto.randomUUID();
          await tx.execute(sql`insert into session_visibility_write_capabilities
            (backend_pid,transaction_id,capability_id)
            values(pg_backend_pid(),pg_current_xact_id(),${capabilityId}::uuid)`);
          await tx.execute(
            sql`select set_config('opengeni.session_visibility_write_capability',${capabilityId},true)`,
          );
          await tx.execute(sql`update sessions set authority_epoch=authority_epoch+1
            where id=${context.sessionId}::uuid`);
          await tx.execute(sql`delete from session_visibility_write_capabilities
            where capability_id=${capabilityId}::uuid`);
          await tx.execute(
            sql`select set_config('opengeni.session_visibility_write_capability','',true)`,
          );
          await tx.execute(sql`update session_turns set active_attempt_id=${epochAttemptId}::uuid,
            execution_generation=execution_generation+1,version=version+1 where id=${context.turnId}::uuid`);
          await tx.execute(sql`insert into session_turn_attempts
            (id,account_id,workspace_id,session_id,turn_id,execution_generation,state,
             temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,
             authority_epoch,authority_visibility,authority_owner_organization_membership_id,
             personal_resource_protocol_version,mcp_approval_policies,connector_action_policies)
            select ${epochAttemptId}::uuid,account_id,workspace_id,session_id,turn_id,execution_generation+1,
             'claimed',temporal_workflow_id,${crypto.randomUUID()},${crypto.randomUUID()},verified_control_revision,
             authority_epoch+1,authority_visibility,authority_owner_organization_membership_id,
             personal_resource_protocol_version,mcp_approval_policies,connector_action_policies
            from session_turn_attempts where id=${context.attemptId}::uuid`);
        });
      } finally {
        await epochAdmin.close();
      }
      context = {
        ...context,
        attemptId: epochAttemptId,
        executionGeneration: context.executionGeneration + 1,
      };
      await acquireSandboxMachineForAttempt(client.db, context);
      let successorCleanup = await reconcileSandboxV2GuestCredentialCleanup(
        client.db,
        epochPrior,
        real,
      );
      for (let i = 0; i < 50 && successorCleanup.state !== "complete"; i++) {
        await Bun.sleep(20);
        successorCleanup = await reconcileSandboxV2GuestCredentialCleanup(
          client.db,
          epochPrior,
          real,
        );
      }
      expect(successorCleanup.state).toBe("complete");
      expect(await releaseRevokedSandboxMachineAttempt(client.db, epochPrior)).toBe(true);
      const beforeEpochReplay = transportCalls;
      await expect(
        executeSandboxV2AcceptedToolAction(
          client.db,
          { ...context, acceptedActionId: callId },
          options,
          callItem,
          invoke,
        ),
      ).rejects.toThrow("settled predecessor authority");
      expect(transportCalls).toBe(beforeEpochReplay);
      expect(invocations).toBe(1);
      const active = await compose("long-accepted").exec({
        cmd: "sleep 60",
        yieldTimeMs: 0,
      });
      const running = await loadSandboxJournalCommand(client.db, context, {
        handle: active.sessionId!,
      });
      expect(running).not.toBeNull();
      expect(await pending()).toBe(true);
      const recoveryTenant = {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        machineId: machine.id,
      };
      const liveRecovery = await reconcileSandboxV2MachineCommands(
        client.db,
        recoveryTenant,
        transport,
      );
      expect(liveRecovery.items).toContainEqual({
        kind: "attempt",
        id: `attempt:${context.attemptId}`,
        status: "held",
      });
      expect(liveRecovery.items).toContainEqual({
        kind: "command",
        id: running!.command.operationId,
        status: "held",
      });
      expect(await pending()).toBe(true);
      const exactLive = await reconcileSandboxV2AttemptWriters(client.db, context, transport);
      expect(exactLive.state).toBe("live");
      expect(exactLive.items).toContainEqual({
        operationId: running!.command.operationId,
        state: "held",
      });
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
      const before = starts + inputs;
      await expect(
        compose("revoked-input").writeStdin({
          sessionId: active.sessionId!,
          chars: "revoked\n",
        }),
      ).rejects.toThrow("authority rejected");
      expect(starts + inputs).toBe(before);
      expect(await pending()).toBe(true);
      controlClient = createDb(fixture.appUrl);
      await expect(acquireSandboxMachineForAttempt(client.db, context)).rejects.toThrow(
        "authority rejected",
      );
      // Fresh control process has no observer state. A transport outage releases
      // only the revoked attempt, retaining the physically unresolved command.
      const failedRecovery = await reconcileSandboxV2MachineCommands(
        controlClient.db,
        recoveryTenant,
        {
          exec: async () => {
            throw Error("Synthetic provider transport outage");
          },
        },
        {
          onDeferred: () => {
            throw Error("Synthetic diagnostics failure");
          },
        },
      );
      expect(failedRecovery.items).toContainEqual({
        kind: "attempt",
        id: `attempt:${context.attemptId}`,
        status: "released",
      });
      expect(failedRecovery.items).toContainEqual({
        kind: "command",
        id: running!.command.operationId,
        status: "deferred",
      });
      const exactOutage = await reconcileSandboxV2AttemptWriters(controlClient.db, context, {
        exec: async () => {
          throw Error("Synthetic exact-attempt transport outage");
        },
      });
      expect(exactOutage.state).toBe("held");
      expect(exactOutage.items).toContainEqual({
        operationId: running!.command.operationId,
        state: "deferred",
      });
      const asyncDiagnosticFailure = await reconcileSandboxV2MachineCommands(
        controlClient.db,
        recoveryTenant,
        {
          exec: async () => {
            throw Error("Synthetic provider transport outage");
          },
        },
        {
          onDeferred: async () => {
            throw Error("Synthetic async diagnostics failure");
          },
        },
      );
      // An unconsumed callback rejection fails the Bun process, even though the
      // control pass itself returned successfully. Flush the microtask here.
      await Bun.sleep(0);
      expect(asyncDiagnosticFailure.items).toContainEqual({
        kind: "command",
        id: running!.command.operationId,
        status: "deferred",
      });
      const completedPages = await reconcileSandboxV2MachineCommands(
        controlClient.db,
        recoveryTenant,
        {
          exec: async () => {
            throw Error("A completed inventory must not be rescanned");
          },
        },
        { scanAttempts: false, scanCommands: false },
      );
      expect(completedPages.items).toHaveLength(0);
      expect(await pending()).toBe(true);
      expect((await lifecycle.step(machineScope)).state).toBe("running");
      const inventory = await listPendingSandboxJournalCommands(controlClient.db, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        machineId: machine.id,
      });
      expect(inventory.items).toHaveLength(1);
      const discovered = inventory.items[0]!;
      expect(discovered.command).toEqual(running!.command);
      expect(discovered.authority).not.toBeNull();
      let lostCancelReply = false;
      const recoveryTransport: MachineExecTransport = {
        exec: async (input) => {
          const physicalResult = await transport.exec(input);
          if (input.argv.includes("cancel") && !lostCancelReply) {
            lostCancelReply = true;
            throw Error("Synthetic cancellation reply loss after physical dispatch");
          }
          return physicalResult;
        },
      };
      // The finalizer uses only this original attempt's command inventory.
      // It drains local callbacks independently from actual journal exit proof.
      scriptedInvocations.cancel();
      await scriptedInvocations.waitForDrain();
      const { acceptedActionId: _finalAction, ...finalAuthority } = context;
      const finalMachine = {
        ...preparedMachine,
        authority: finalAuthority,
        releaseRevoked: () =>
          releaseRevokedSandboxMachineAttempt(controlClient!.db, finalAuthority),
      };
      let finalRenewalStops = 0;
      let finalMcpCloses = 0;
      const finalExecution = createSandboxV2TurnExecution(
        controlClient.db,
        finalMachine,
        createSandboxV2TurnShell(controlClient.db, finalMachine, { environment: async () => ({}) }),
        new Map([["docker", { backend, transport: recoveryTransport }]]),
        {
          invocations: scriptedInvocations,
          credentialRenewal: {
            stop: async () => {
              finalRenewalStops++;
            },
          },
          runMcpCredentials: {
            close: () => {
              finalMcpCloses++;
            },
          },
        },
      );
      let recovery = await finalExecution.finalize();
      for (let i = 0; i < 50 && (await pending()); i++) {
        await Bun.sleep(20);
        recovery = await finalExecution.finalize();
      }
      expect(lostCancelReply).toBe(true);
      expect(recovery.items).toContainEqual({
        operationId: running!.command.operationId,
        state: "settled",
      });
      expect(recovery.state).toBe("drained");
      expect(finalRenewalStops).toBe(1);
      expect(finalMcpCloses).toBe(1);
      expect(await pending()).toBe(false);
      expect(
        (await listPendingSandboxJournalCommands(controlClient.db, recoveryTenant)).items,
      ).toHaveLength(0);
      expect(
        (await findSandboxMachine(controlClient.db, {
          accountId: context.accountId,
          ...machineScope,
        }))!.demands,
      ).toHaveLength(0);
      expect(starts + inputs).toBe(before);
      expect(await docker(["exec", container, "cat", "/workspace/effect"])).toBe("x");
      await lifecycle.requestDestroy(machineScope);
      expect((await lifecycle.step(machineScope)).state).toBe("destroying");
      expect((await lifecycle.step(machineScope)).state).toBe("destroyed");
    } finally {
      if (ownedMachineId) {
        const remove = Bun.spawn(
          ["docker", "rm", "--force", container ?? `opengeni-v2-${ownedMachineId}`],
          { stdout: "ignore", stderr: "ignore" },
        );
        await remove.exited;
        const volume = Bun.spawn(
          ["docker", "volume", "rm", `opengeni-v2-workspace-${ownedMachineId}`],
          { stdout: "ignore", stderr: "ignore" },
        );
        await volume.exited;
      }
      await controlClient?.close();
      await client.close();
      await fixture.release();
    }
  },
  180_000,
);
