import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import postgres from "postgres";
import { Client, Connection } from "@temporalio/client";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  bootstrapWorkspace,
  createDb,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { startTestServices, testSettings, waitFor, type TestServices } from "@opengeni/testing";
import { Document, DocumentFile } from "../../packages/artifact-tool/src/document";
import { Presentation, PresentationFile } from "../../packages/artifact-tool/src/presentation";
import { Workbook } from "../../packages/artifact-tool/src/spreadsheet";
import { SpreadsheetFile } from "../../packages/artifact-tool/src/spreadsheet-file";

// Explicit built-image gate. No host converter, source mount, or live provider
// credential can mask a missing runtime dependency. Run on Linux Docker with
// OPENGENI_CONVERTER_API_IMAGE and OPENGENI_CONVERTER_WORKER_IMAGE set.
const apiImage = process.env.OPENGENI_CONVERTER_API_IMAGE;
const workerImage = process.env.OPENGENI_CONVERTER_WORKER_IMAGE;
const enabled = Boolean(apiImage && workerImage);
const marker = "Opengeni converter verification";
const containers: string[] = [];
let directory: string;
let services: TestServices;
let db: ReturnType<typeof createDb>;
let admin: postgres.Sql;
let temporalConnection: Connection;
let temporal: Client;
let taskQueue: string;
let provider: ReturnType<typeof Bun.serve>;
let origin: string;
let workspaceId: string;
let baseId: string;
let authorization: string;
let workerContainer: string;
let providerCalls = 0;
let fixtures: Map<string, { bytes: Uint8Array; contentType: string }>;

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`${args[0]} exited ${status}: ${stderr}\n${stdout}`);
  return (args[1] === "logs" ? stdout + stderr : stdout).trim();
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${origin}/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: { authorization, "content-type": "application/json", ...init.headers },
  });
}

async function upload(filename: string) {
  const { bytes, contentType } = fixtures.get(filename)!;
  const begin = await request("/files/uploads", {
    method: "POST",
    body: JSON.stringify({ filename, contentType, sizeBytes: bytes.length }),
  });
  expect(begin.status, await begin.clone().text()).toBe(201);
  const ticket = (await begin.json()) as {
    fileId: string;
    uploadId: string;
    putUrl: string;
    requiredHeaders: Record<string, string>;
  };
  const put = await fetch(ticket.putUrl, {
    method: "PUT",
    headers: ticket.requiredHeaders,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  const complete = await request(`/files/uploads/${ticket.uploadId}/complete`, { method: "POST" });
  expect(complete.status, await complete.clone().text()).toBe(200);
  const accepted = await request(`/document-bases/${baseId}/documents`, {
    method: "POST",
    body: JSON.stringify({ fileId: ticket.fileId }),
  });
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  const document = (await accepted.json()) as { id: string; status: string };
  expect(document.status).toBe("queued");
  let settled: { status: string; error: string | null } | undefined;
  await waitFor(
    async () => {
      const [row] = await admin<{ status: string; error: string | null }[]>`
      SELECT status, error FROM documents WHERE id=${document.id}`;
      settled = row;
      return row?.status === "ready" || row?.status === "failed";
    },
    { timeoutMs: 90_000 },
  );
  return { ...settled!, id: document.id };
}

describe.skipIf(!enabled)("built workload converter ownership", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "opengeni-converters-"));
    fixtures = await makeFixtures();
    services = await startTestServices({ temporal: true, objectStorage: true });
    await services.migrate();
    temporalConnection = await Connection.connect({ address: services.temporalHost });
    temporal = new Client({ connection: temporalConnection });
    db = createDb(services.databaseUrl);
    admin = postgres(services.databaseUrl, { max: 2 });
    const access = await bootstrapWorkspace(db.db, {
      accountExternalSource: "test:converter-images",
      accountExternalId: crypto.randomUUID(),
      accountName: "Converter verification",
      workspaceExternalSource: "test:converter-images",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Converter verification",
      subjectId: "test:converter-human",
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    workspaceId = access.defaultWorkspaceId!;
    const delegationSecret = "converter-image-test-delegation-secret";
    authorization = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/audio/transcriptions") {
          const form = await req.formData();
          const file = form.get("file") as File;
          expect(file.size).toBeGreaterThan(44);
          providerCalls++;
          return Response.json({ text: marker, language: "en", duration: 1 });
        }
        return new Response("Unexpected provider request", { status: 500 });
      },
    });
    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const apiPort = portProbe.port!;
    portProbe.stop(true);
    origin = `http://127.0.0.1:${apiPort}`;
    const settings = testSettings({
      databaseUrl: services.runtimeDatabaseUrl,
      natsUrl: services.natsUrl,
      temporalHost: services.temporalHost,
      apiPort,
      apiHost: "127.0.0.1",
      productAccessMode: "managed",
      delegationSecret,
      betterAuthSecret: "converter-image-test-auth-secret-32-characters",
      sandboxBackend: "none",
      objectStorageEndpoint: services.objectStorageEndpoint,
      objectStorageAccessKeyId: services.objectStorageAccessKeyId,
      objectStorageSecretAccessKey: services.objectStorageSecretAccessKey,
      objectStorageS3Provider: services.objectStorageS3Provider!,
      voiceInputProviderOrder: "openai",
      voiceInputOpenaiApiKey: "test-only-provider-key",
      voiceInputOpenaiBaseUrl: `http://127.0.0.1:${provider.port}`,
    });
    taskQueue = settings.temporalTaskQueue;
    await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
    for (const [filename, fixture] of fixtures)
      await writeFile(join(directory, filename), fixture.bytes);
    const apiContainer = `converter-api-${crypto.randomUUID()}`;
    workerContainer = `converter-worker-${crypto.randomUUID()}`;
    for (const [name, image, program] of [
      [
        apiContainer,
        apiImage!,
        `const {startApi}=await import('/app/apps/api/dist/process/index.js'); await startApi({settings:await Bun.file('/verification/settings.json').json()});`,
      ],
      [
        workerContainer,
        workerImage!,
        `const {createOpenGeniWorker}=await import('/app/apps/worker/dist/process/index.js'); const settings=await Bun.file('/verification/settings.json').json(); const {worker}=await createOpenGeniWorker({role:'control',settings,activityDependencies:{settings}}); process.on('SIGTERM',()=>worker.shutdown()); await worker.run();`,
      ],
    ]) {
      containers.push(name!);
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        name!,
        "--network",
        "host",
        "-v",
        `${directory}:/verification:ro`,
        "--entrypoint",
        "bun",
        image!,
        "-e",
        program!,
      ]);
    }
    try {
      await waitFor(async () => (await fetch(`${origin}/healthz`).catch(() => null))?.ok === true, {
        timeoutMs: 90_000,
      });
      const base = await request("/document-bases", {
        method: "POST",
        body: JSON.stringify({ name: "Converter fixtures" }),
      });
      expect(base.status, await base.clone().text()).toBe(201);
      baseId = ((await base.json()) as { id: string }).id;
    } catch (error) {
      for (const name of containers) console.error(await command(["docker", "logs", name]));
      throw error;
    }
  }, 900_000);

  afterAll(async () => {
    for (const name of containers) {
      console.log(await command(["docker", "inspect", "--format", "{{json .State}}", name]));
      console.log(await command(["docker", "logs", "--tail", "15", name]));
      await command(["docker", "rm", "-f", name]);
    }
    provider?.stop(true);
    await db?.close();
    await admin?.end();
    await temporalConnection?.close();
    await services?.down();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 180_000);

  test.each(["source.docx", "source.xlsx", "source.pptx", "scan.pdf", "scan.png"])(
    "uploads and indexes %s through API → Temporal → worker",
    async (filename) => {
      const result = await upload(filename);
      expect(result.status, result.error ?? "").toBe("ready");
      const rows = await admin`
        SELECT e.id, r.body->>'content' AS content FROM knowledge_entries e JOIN knowledge_entry_revisions r
        ON r.id=e.published_revision_id WHERE e.legacy_document_id=${result.id}`;
      expect(JSON.stringify(rows)).toContain(marker);
      await temporal.workflow.execute("knowledgeIndexingWorkflow", {
        taskQueue,
        workflowId: `converter-index-${crypto.randomUUID()}`,
        args: [],
      });
      const [index] = await admin`
        SELECT j.state FROM knowledge_index_jobs j JOIN knowledge_entries e
        ON e.id=j.entry_id WHERE e.legacy_document_id=${result.id}`;
      expect(index?.state).toBe("ready");
      const search = await request("/knowledge/entries/search", {
        method: "POST",
        body: JSON.stringify({ query: marker, mode: "vector", includeEvidence: true, limit: 50 }),
      });
      expect(search.status, await search.clone().text()).toBe(200);
      expect(await search.text()).toContain(rows[0]!.id);
    },
    120_000,
  );

  test("missing Office converter persists an explicit indexing failure", async () => {
    await command([
      "docker",
      "exec",
      "--user",
      "root",
      workerContainer,
      "mv",
      "/usr/lib/libreoffice/program/soffice",
      "/usr/lib/libreoffice/program/soffice-disabled",
    ]);
    try {
      const result = await upload("source.docx");
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/libreoffice|soffice/i);
    } finally {
      await command([
        "docker",
        "exec",
        "--user",
        "root",
        workerContainer,
        "mv",
        "/usr/lib/libreoffice/program/soffice-disabled",
        "/usr/lib/libreoffice/program/soffice",
      ]);
    }
  }, 120_000);

  test("missing OCR data persists an explicit indexing failure", async () => {
    const data = "/opt/opengeni/tessdata/eng.traineddata";
    await command([
      "docker",
      "exec",
      "--user",
      "root",
      workerContainer,
      "mv",
      data,
      `${data}.disabled`,
    ]);
    try {
      const result = await upload("scan.png");
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/ocr|tess|traineddata/i);
    } finally {
      await command([
        "docker",
        "exec",
        "--user",
        "root",
        workerContainer,
        "mv",
        `${data}.disabled`,
        data,
      ]);
    }
  }, 120_000);

  test("voice input keeps real local FFmpeg decoding and the provider round trip", async () => {
    // Generate valid compressed audio in the API image itself; no host FFmpeg.
    const apiContainer = containers[0]!;
    await command([
      "docker",
      "exec",
      apiContainer,
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "libopus",
      "/tmp/voice.webm",
    ]);
    await command([
      "docker",
      "cp",
      `${apiContainer}:/tmp/voice.webm`,
      join(directory, "voice.webm"),
    ]);
    const response = await request("/transcriptions", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: await Bun.file(join(directory, "voice.webm")).bytes(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ text: marker });
    expect(providerCalls).toBe(1);
  }, 30_000);
});

async function makeFixtures() {
  const result = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const document = Document.create();
  document.blocks.addParagraph(marker);
  const workbook = Workbook.create();
  workbook.worksheets.add("Verification").getRange("A1").values = [[marker]];
  const deck = Presentation.create({ slideSize: { width: 960, height: 540 } });
  const shape = deck.slides
    .add()
    .shapes.add({ geometry: "textbox", position: { left: 40, top: 40, width: 880, height: 120 } });
  shape.text = marker;
  shape.text.style = { fontSize: 32 };
  for (const [name, file] of [
    ["source.docx", await DocumentFile.exportDocx(document)],
    ["source.xlsx", await SpreadsheetFile.exportXlsx(workbook)],
    ["source.pptx", await PresentationFile.exportPptx(deck)],
  ] as const)
    result.set(name, { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type });
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="220"><rect width="100%" height="100%" fill="white"/><text x="60" y="130" font-family="sans-serif" font-size="64" fill="black">${marker}</text></svg>`,
  );
  result.set("scan.png", { bytes: await sharp(svg).png().toBuffer(), contentType: "image/png" });
  const jpeg = await sharp(svg).jpeg().toBuffer();
  // Image-only PDF: successful extraction proves OCR rather than a hidden text layer.
  const content = "q 700 0 0 110 0 0 cm /Image Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 110] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1400 /Height 220 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(parts).length);
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
  }
  const xref = Buffer.concat(parts).length;
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  );
  result.set("scan.pdf", { bytes: Buffer.concat(parts), contentType: "application/pdf" });
  return result;
}
