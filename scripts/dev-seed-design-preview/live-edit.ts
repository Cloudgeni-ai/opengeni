/**
 * Fill empty editable artifacts through the same live WebSocket protocol the
 * browser editor uses: mint a ticket (cookie auth), open the stream, send one
 * OGATX001 intent carrying a modality command batch, wait for acceptance.
 *
 * Office import would be simpler, but it cannot run on the local S3-compatible
 * object store (its object HEAD carries no version token), so the seed edits
 * the artifacts like a person typing into them.
 */
import { createHash } from "node:crypto";
import {
  decodeEditableArtifactLiveServerWireFrame,
  encodeEditableArtifactLiveMutationWireFrame,
  encodeEditableArtifactLiveOpenWireFrame,
} from "@opengeni/contracts/editable-artifact-live";
import {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
  EDITABLE_ARTIFACT_INTENT_VERSION,
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  SPREADSHEET_ARTIFACT_COMMAND_VERSION,
  currentEditableArtifactCompatibility,
  encodeDocumentArtifactCommandBatch,
  encodePresentationArtifactCommandBatch,
  encodeSpreadsheetArtifactCommandBatch,
  hashEditableArtifactMutationIntent,
  type DocumentArtifactCommand,
  type PresentationArtifactCommand,
  type SpreadsheetArtifactCommand,
} from "@opengeni/contracts/editable-artifacts";

export type LiveBatch =
  | { modality: "document"; commands: (namespace: string) => DocumentArtifactCommand[] }
  | { modality: "spreadsheet"; commands: (namespace: string) => SpreadsheetArtifactCommand[] }
  | { modality: "presentation"; commands: (namespace: string) => PresentationArtifactCommand[] };

type Post = <T = any>(path: string, body: unknown) => Promise<T>;

/** Mirrors the API's genesis namespace: the first 8 bytes of sha256(artifact id). */
function namespaceForArtifact(artifactId: string): string {
  const hex = createHash("sha256").update(artifactId).digest("hex").slice(0, 16);
  return /^0+$/u.test(hex) ? "0000000000000001" : hex;
}

/** Counters above the ids an empty artifact already uses (sections, headers, masters). */
const FIRST_COUNTER = 0x100;

const bytes = (value: Uint8Array) => value as unknown as ArrayBuffer;

export async function applyLiveBatch(options: {
  apiBase: string;
  origin: string;
  workspaceBase: string;
  post: Post;
  artifactId: string;
  replicaId: string;
  batch: LiveBatch;
}): Promise<void> {
  const { batch } = options;
  const compat = currentEditableArtifactCompatibility(batch.modality);
  const ticket = await options.post<{ token: string }>(
    `${options.workspaceBase}/editable-artifacts/${options.artifactId}/live-ticket`,
    {
      replicaId: options.replicaId,
      modality: batch.modality,
      liveProtocolVersion: compat.liveProtocolVersion,
      kernelVersion: "design-preview-seed",
      modelSchemaVersion: compat.modelSchemaVersion,
      snapshotVersion: compat.snapshotVersion,
      commandProtocolVersion: compat.commandProtocolVersion,
      committedTransactionProtocolVersion: compat.committedTransactionProtocolVersion,
    },
  );
  // New structural ids must live in the artifact's own id namespace, which
  // the server derives from the artifact id when it creates the empty state.
  const namespace = namespaceForArtifact(options.artifactId);
  const commandBytes =
    batch.modality === "document"
      ? encodeDocumentArtifactCommandBatch({
          version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
          commands: batch.commands(namespace),
        })
      : batch.modality === "spreadsheet"
        ? encodeSpreadsheetArtifactCommandBatch({
            version: SPREADSHEET_ARTIFACT_COMMAND_VERSION,
            commands: batch.commands(namespace),
          })
        : encodePresentationArtifactCommandBatch({
            version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
            commands: batch.commands(namespace),
          });

  const socket = new WebSocket(
    `${options.apiBase.replace(/^http/, "ws")}/v1/editable-artifacts/live`,
    {
      protocols: ["opengeni-artifact-v2"],
      headers: { origin: options.origin },
    } as unknown as string[],
  );
  socket.binaryType = "arraybuffer";
  const frames: any[] = [];
  let wake: (() => void) | null = null;
  let closed: string | null = null;
  socket.addEventListener("message", (event) => {
    frames.push(
      decodeEditableArtifactLiveServerWireFrame(new Uint8Array(event.data as ArrayBuffer)),
    );
    wake?.();
  });
  socket.addEventListener("close", (event) => {
    closed = `${event.code} ${event.reason}`;
    wake?.();
  });
  const next = async (predicate: (frame: any) => boolean, label: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return frames.splice(index, 1)[0];
      if (closed) throw new Error(`live socket closed while waiting for ${label}: ${closed}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 250);
      });
      wake = null;
    }
  };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("live socket failed to open")), {
      once: true,
    });
  });
  try {
    socket.send(
      bytes(
        encodeEditableArtifactLiveOpenWireFrame({
          type: "open",
          protocolVersion: compat.liveProtocolVersion,
          artifactId: options.artifactId,
          token: ticket.token,
          resume:
            batch.modality === "spreadsheet"
              ? {
                  modality: "spreadsheet",
                  localCursor: null,
                  localStateHash: null,
                  localCausalFrontier: [],
                  requireSnapshot: true,
                }
              : {
                  modality: batch.modality,
                  localCursor: null,
                  localStateHash: null,
                  localNativeRevision: null,
                  requireSnapshot: true,
                },
        }),
      ),
    );
    const open = await next((frame) => frame.type === "open", "open");
    const snapshot = await next(
      (frame) => frame.type === "snapshot" && frame.final === true,
      "snapshot",
    );
    const authored = hashEditableArtifactMutationIntent({
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: EDITABLE_ARTIFACT_INTENT_PROTOCOL_VERSION,
      modelSchemaVersion: compat.modelSchemaVersion,
      commandProtocolVersion: compat.commandProtocolVersion,
      artifactId: options.artifactId,
      clientTransactionId: crypto.randomUUID().replace(/-/g, ""),
      replicaId: options.replicaId,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: open.headSequence,
      causalBase: batch.modality === "spreadsheet" ? (snapshot.causalFrontier ?? []) : [],
      selectiveUndoOperationIds: [],
      commandBytes,
    } as never);
    socket.send(
      bytes(
        encodeEditableArtifactLiveMutationWireFrame({
          type: "mutation",
          protocolVersion: compat.liveProtocolVersion,
          artifactId: options.artifactId,
          streamEpoch: open.streamEpoch,
          requestHash: authored.requestHash,
          intentBytes: authored.bytes,
        }),
      ),
    );
    const result = await next(
      (frame) => frame.type === "mutationAccepted" || frame.type === "mutationRejected",
      "mutation result",
    );
    if (result.type === "mutationRejected") {
      throw new Error(`live mutation rejected: ${result.code}`);
    }
  } finally {
    socket.close();
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type Run = { text: string; style: Record<string, unknown> };
const run = (text: string, style: Record<string, unknown> = {}): Run => ({ text, style });

function documentCommands(
  namespace: string,
  blocks: (
    | { h: 1 | 2 | 3; text: string }
    | { p: string | Run[] }
    | { bullet: string }
    | { number: string }
    | { table: string[][]; widths: number[] }
  )[],
): DocumentArtifactCommand[] {
  let counter = FIRST_COUNTER;
  const id = (prefix: string) =>
    `${prefix}/${namespace}${(++counter).toString(16).padStart(16, "0")}`;
  const body = { kind: "body" } as const;
  return blocks.map((block): DocumentArtifactCommand => {
    if ("h" in block) {
      return {
        kind: "paragraph.add",
        target: body,
        id: id("p"),
        runs: [run(block.text)],
        style: { headingLevel: block.h, keepNext: true },
      };
    }
    if ("p" in block) {
      return {
        kind: "paragraph.add",
        target: body,
        id: id("p"),
        runs: typeof block.p === "string" ? [run(block.p)] : block.p,
        style: { spaceAfterPt: 6 },
      };
    }
    if ("bullet" in block || "number" in block) {
      const numbered = "number" in block;
      return {
        kind: "paragraph.add",
        target: body,
        id: id("p"),
        runs: [run(numbered ? block.number : block.bullet)],
        style: { list: { kind: numbered ? "number" : "bullet", level: 0, instanceId: null } },
      };
    }
    return {
      kind: "table.add",
      target: body,
      id: id("dt"),
      rows: block.table.map((row, rowIndex) =>
        row.map((cell) => [run(cell, rowIndex === 0 ? { bold: true } : {})]),
      ),
      style: {
        widthPt: block.widths.reduce((sum, width) => sum + width, 0),
        columnWidthsPt: block.widths,
        headerRows: 1,
        headerFill: "#EEF2F6",
        cellPaddingPt: 5,
      },
    };
  });
}

export const POSTMORTEM_DOCUMENT: LiveBatch = {
  modality: "document",
  commands: (ns) =>
    documentCommands(ns, [
      { h: 1, text: "INC-2291: Checkout outage" },
      {
        p: [
          run("Date: ", { bold: true }),
          run("Tuesday 22 September 2026, 09:12–09:34 UTC (22 minutes)"),
        ],
      },
      { p: [run("Incident commander: ", { bold: true }), run("Maria Chen")] },
      { p: [run("Status: ", { bold: true }), run("Resolved, action items open")] },
      { h: 2, text: "Summary" },
      {
        p: "A routine kernel patch restarted cache node cache-3 in eu-north-1. The node came back empty, so checkout requests fell through to Postgres. The extra load pushed the cart lookup over its timeout and 11.8% of checkout requests failed until the cache was warmed from a replica.",
      },
      { h: 2, text: "Impact" },
      {
        table: [
          ["Metric", "Value"],
          ["Duration", "22 minutes"],
          ["Peak error rate", "11.8%"],
          ["Error budget consumed", "38% of the monthly checkout budget"],
          ["Customers who contacted support", "17"],
        ],
        widths: [200, 268],
      },
      { h: 2, text: "Timeline (UTC)" },
      {
        table: [
          ["Time", "Event"],
          ["09:10", "Patch job restarts cache-3"],
          ["09:12", "Checkout error-rate alert fires"],
          ["09:15", "Maria acknowledges and opens the incident channel"],
          ["09:21", "Cache restart identified as the trigger"],
          ["09:29", "cache-3 warmed from the replica"],
          ["09:34", "Error rate below 0.1%; incident resolved"],
        ],
        widths: [80, 388],
      },
      { h: 2, text: "Root cause" },
      {
        p: "The patch job restarts cache nodes one at a time but does not wait for a node to be warm before moving on. A cold cache node is healthy from the load balancer's point of view, so traffic returned to it immediately.",
      },
      { h: 2, text: "What went well" },
      { bullet: "Alerting fired within two minutes." },
      { bullet: "The runbook for warming a cache node from a replica worked as written." },
      { h: 2, text: "Action items" },
      { number: "PLAT-340: warm cache nodes before they receive traffic (owner: Bendik)" },
      { number: "PLAT-366: alert when the webhook consumer stalls (owner: Jonas)" },
      { number: "Add a readiness gate to the patch job (owner: Maria)" },
    ]),
};

export const PG17_DOCUMENT: LiveBatch = {
  modality: "document",
  commands: (ns) =>
    documentCommands(ns, [
      { h: 1, text: "Postgres 17 upgrade plan" },
      {
        p: "Goal: move the main database from Postgres 15 to 17 with a write pause under two minutes and a 48-hour rollback path.",
      },
      { h: 2, text: "Steps" },
      { number: "Create a Postgres 17 replica with logical replication." },
      { number: "Run the test suite and a read-only canary against it for one week." },
      { number: "Confirm extension support: pg_stat_statements, pgvector." },
      { number: "Sync sequences, pause writes, wait for zero lag, switch the connection string." },
      { number: "Run ANALYZE on all tables right after the switch." },
      { number: "Keep the old primary for 48 hours as a rollback path." },
      { h: 2, text: "Risks" },
      {
        table: [
          ["Risk", "Likelihood", "Mitigation"],
          ["Sequences not replicated", "High", "Sync with setval() before the switch"],
          ["Planner regressions", "Medium", "Compare the top 50 queries in the canary"],
          ["Large objects", "Low", "None in use; verified with lo_list"],
        ],
        widths: [170, 90, 208],
      },
      { h: 2, text: "Owners" },
      {
        p: [
          run("Bendik Hansen", { bold: true }),
          run(" drives the cutover; "),
          run("Jonas Berg", { bold: true }),
          run(" owns the canary and rollback."),
        ],
      },
    ]),
};

function sheetCommands(
  namespace: string,
  sheets: { name: string; rows: unknown[][] }[],
): SpreadsheetArtifactCommand[] {
  const commands: SpreadsheetArtifactCommand[] = [];
  sheets.forEach((sheet, index) => {
    const sheetId = `${namespace}${(FIRST_COUNTER + index + 1).toString(16).padStart(16, "0")}`;
    const createIndex = commands.length;
    commands.push({
      kind: "sheet.create",
      sheetId,
      name: sheet.name,
      after:
        index === 0
          ? null
          : {
              kind: "created-in-batch",
              sheetId: `${namespace}${(FIRST_COUNTER + index).toString(16).padStart(16, "0")}`,
              createCommandIndex: createIndex - 2,
            },
    } as SpreadsheetArtifactCommand);
    const columns = Math.max(...sheet.rows.map((row) => row.length));
    commands.push({
      kind: "cells.set",
      sheet: { kind: "created-in-batch", sheetId, createCommandIndex: createIndex },
      anchor: { row: 0, column: 0 },
      rows: sheet.rows.length,
      columns,
      cells: sheet.rows.flatMap((row) =>
        Array.from({ length: columns }, (_, column) => {
          const value = row[column] ?? null;
          return typeof value === "string" && value.startsWith("=") ? { formula: value } : value;
        }),
      ),
    } as unknown as SpreadsheetArtifactCommand);
  });
  return commands;
}

export const SPEND_SPREADSHEET: LiveBatch = {
  modality: "spreadsheet",
  commands: (ns) => {
    const categories: [string, number, number, number][] = [
      ["Cloud", 412300, 438900, 455100],
      ["Hardware", 302100, 118400, 276500],
      ["Software", 143800, 143800, 151200],
      ["Travel", 88200, 214700, 96400],
      ["Office", 61200, 58900, 63400],
      ["Training", 24000, 12500, 38000],
    ];
    const summary: unknown[][] = [
      ["Category", "Jul (NOK)", "Aug (NOK)", "Sep (NOK)", "Q3 total", "Sep vs Aug"],
      ...categories.map(([name, jul, aug, sep], index) => [
        name,
        jul,
        aug,
        sep,
        `=SUM(B${index + 2}:D${index + 2})`,
        `=ROUND(D${index + 2}/C${index + 2}-1,3)`,
      ]),
      ["Total", "=SUM(B2:B7)", "=SUM(C2:C7)", "=SUM(D2:D7)", "=SUM(E2:E7)", "=ROUND(D8/C8-1,3)"],
    ];
    const vendors: [string, string, string][] = [
      ["AWS EMEA", "Cloud", "Finance"],
      ["Hetzner", "Cloud", "Bendik Hansen"],
      ["SAS Scandinavian", "Travel", "Maria Chen"],
      ["Scandic Hamburg", "Travel", "Jonas Berg"],
      ["Figma", "Software", "Aiko Tanaka"],
      ["JetBrains", "Software", "Bendik Hansen"],
      ["Digi-Key", "Hardware", "Tom Eriksen"],
      ["Mouser", "Hardware", "Tom Eriksen"],
      ["Elkjøp", "Office", "Maria Chen"],
    ];
    const transactions: unknown[][] = [
      ["Date", "Vendor", "Category", "Cardholder", "Amount (NOK)"],
    ];
    for (let i = 0; i < 36; i++) {
      const [vendor, category, holder] = vendors[i % vendors.length]!;
      const month = 7 + Math.floor(i / 12);
      const day = 1 + ((i * 7) % 28);
      transactions.push([
        `2026-0${month}-${String(day).padStart(2, "0")}`,
        vendor,
        category,
        holder,
        Math.round(((i * 7919) % 40000) + 1200),
      ]);
    }
    return sheetCommands(ns, [
      { name: "Summary", rows: summary },
      { name: "Transactions", rows: transactions },
    ]);
  },
};

export const AWS_SPREADSHEET: LiveBatch = {
  modality: "spreadsheet",
  commands: (ns) => {
    const services: [string, number, number, number][] = [
      ["EC2", 18420, 19110, 19870],
      ["RDS", 9310, 9420, 11980],
      ["S3", 3120, 3350, 3610],
      ["EKS", 2190, 2190, 2410],
      ["CloudFront", 1480, 1720, 1650],
      ["Data transfer", 2760, 2910, 3390],
      ["Other", 1210, 1180, 1260],
    ];
    return sheetCommands(ns, [
      {
        name: "By service",
        rows: [
          ["Service", "Jul (USD)", "Aug (USD)", "Sep (USD)", "Change since Jul"],
          ...services.map(([name, jul, aug, sep], index) => [
            name,
            jul,
            aug,
            sep,
            `=ROUND(D${index + 2}/B${index + 2}-1,3)`,
          ]),
          ["Total", "=SUM(B2:B8)", "=SUM(C2:C8)", "=SUM(D2:D8)", "=ROUND(D9/B9-1,3)"],
        ],
      },
      {
        name: "Savings",
        rows: [
          ["Change", "Monthly saving (USD)", "Effort", "Owner"],
          ["Compute Savings Plan", 2600, "Low", "Bendik Hansen"],
          ["Drop CDC slot, shrink db-2", 1100, "Low", "Jonas Berg"],
          ["S3 Intelligent-Tiering", 900, "Medium", "Aiko Tanaka"],
          ["Total", "=SUM(B2:B4)", "", ""],
        ],
      },
    ]);
  },
};

// Presentation: 1280 x 720 px slides expressed in EMU.
const EMU = 9525;
const px = (value: number) => Math.round(value * EMU);
const rgba = (hex: string) => Number.parseInt(`${hex.replace("#", "")}ff`, 16);
const none = { kind: "none" } as const;
const noLine = { fill: none, width: 0, dash: "solid" } as const;
const text = (
  lines: string[],
  options: { size: number; color?: string; bold?: boolean; align?: "left" | "center" } = {
    size: 20,
  },
) => ({
  paragraphs: lines.map((line) => ({
    runs: [
      {
        text: line,
        style: {
          fontFamily: "Arial",
          fontSizeCentipoints: options.size * 100,
          color: rgba(options.color ?? "#11181C"),
          bold: options.bold ?? false,
          italic: false,
          underline: false,
          language: null,
        },
      },
    ],
    alignment: options.align ?? "left",
  })),
  verticalAlignment: "top" as const,
});

type SlideSpec = {
  title: string;
  dark?: boolean;
  nodes: {
    name: string;
    box: [number, number, number, number];
    content: Record<string, unknown>;
  }[];
};

function deckCommands(namespace: string, slides: SlideSpec[]): PresentationArtifactCommand[] {
  let counter = FIRST_COUNTER;
  const id = () => `${namespace}${(++counter).toString(16).padStart(16, "0")}`;
  const commands: PresentationArtifactCommand[] = [
    { kind: "presentation.size.set", size: { width: px(1280), height: px(720) } },
  ];
  slides.forEach((slide, index) => {
    const slideId = id();
    commands.push({
      kind: "slide.create",
      id: slideId,
      index,
      title: slide.title,
      layoutId: null,
      background: slide.dark ? { kind: "solid", color: rgba("#0F1A1C") } : none,
    });
    slide.nodes.forEach((node, nodeIndex) => {
      const [x, y, width, height] = node.box;
      commands.push({
        kind: "node.insert",
        owner: { kind: "slide", id: slideId },
        parentId: null,
        index: nodeIndex,
        node: {
          id: id(),
          name: node.name,
          bounds: { x: px(x), y: px(y), width: px(width), height: px(height) },
          transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
          content: node.content as never,
        },
      });
    });
  });
  return commands;
}

const shape = (lines: string[], options: Parameters<typeof text>[1], fill = "") => ({
  kind: "shape",
  geometry: "text-box",
  fill: fill ? { kind: "solid", color: rgba(fill) } : none,
  line: noLine,
  text: text(lines, options),
  placeholder: null,
});
const bar = (color: string) => ({
  kind: "shape",
  geometry: "rectangle",
  fill: { kind: "solid", color: rgba(color) },
  line: noLine,
  text: null,
  placeholder: null,
});
const heading = (title: string): SlideSpec["nodes"] => [
  { name: "Title", box: [72, 48, 1100, 70], content: shape([title], { size: 34, bold: true }) },
  { name: "Accent", box: [72, 122, 60, 4], content: bar("#12A594") },
];
const table = (rows: string[][], widths: number[]) => ({
  kind: "table",
  rows: rows.map((row, rowIndex) =>
    row.map((cell) => ({
      text: text([cell], { size: 16, bold: rowIndex === 0 }),
      fill: rowIndex === 0 ? { kind: "solid", color: rgba("#EEF2F6") } : none,
      rowSpan: 1,
      columnSpan: 1,
    })),
  ),
  columnWidths: widths.map(px),
  rowHeights: rows.map(() => px(48)),
  line: { fill: { kind: "solid", color: rgba("#D7DBDF") }, width: 9525, dash: "solid" },
});
const chart = (
  chartType: string,
  title: string,
  categories: string[],
  series: { name: string; values: number[] }[],
) => ({
  kind: "chart",
  chartType,
  title: text([title], { size: 18, bold: true }),
  series: series.map((entry) => ({ ...entry, categories, xValues: [], bubbleSizes: [] })),
  hasLegend: series.length > 1,
});
const titleSlide = (title: string, subtitle: string): SlideSpec => ({
  title,
  dark: true,
  nodes: [
    { name: "Accent", box: [96, 300, 80, 6], content: bar("#12A594") },
    {
      name: "Title",
      box: [96, 320, 1000, 100],
      content: shape([title], { size: 48, bold: true, color: "#FFFFFF" }),
    },
    {
      name: "Subtitle",
      box: [96, 420, 1000, 60],
      content: shape([subtitle], { size: 22, color: "#9BB5B2" }),
    },
  ],
});

export const RELIABILITY_DECK: LiveBatch = {
  modality: "presentation",
  commands: (ns) =>
    deckCommands(ns, [
      titleSlide("Q4 reliability sprint", "Platform team · 3 weeks · 2 engineers"),
      {
        title: "What we fix first",
        nodes: [
          ...heading("What we fix first"),
          {
            name: "Priorities",
            box: [72, 160, 1136, 340],
            content: table(
              [
                ["#", "Issue", "Why now", "Size"],
                ["1", "Webhook consumer stalls silently", "Caused a 1 h delay last week", "5 d"],
                ["2", "Cache restart hurts checkout p95", "38% of the error budget", "5 d"],
                ["3", "Slow backups when prune fails", "Overlaps EU morning traffic", "3 d"],
                ["4", "Certificate expiry alert", "Same failure as the March outage", "2 d"],
                ["5", "Stuck deploy lock", "Blocks hotfixes weekly", "2 d"],
                ["6", "Test mock race", "Flaky CI slows everything", "2 d"],
              ],
              [60, 440, 480, 156],
            ),
          },
        ],
      },
      {
        title: "Error budget burn by cause",
        nodes: [
          ...heading("Error budget burn by cause (September)"),
          {
            name: "Burn chart",
            box: [72, 160, 1136, 480],
            content: chart(
              "bar",
              "Budget used (%)",
              ["Cache restart", "Webhook stall", "Deploys", "Other"],
              [{ name: "Budget used (%)", values: [38, 21, 9, 4] }],
            ),
          },
        ],
      },
      {
        title: "Three weeks",
        nodes: [
          ...heading("Three weeks"),
          {
            name: "Plan",
            box: [72, 170, 1100, 320],
            content: shape(
              [
                "Week 1   Webhook alerting + consumer heartbeat, CI readiness wait",
                "Week 2   Cache warm-up on restart, certificate expiry alert",
                "Week 3   Backup prune fix, deploy lock release",
                "Friday   Retro and error-budget review",
              ],
              { size: 24 },
            ),
          },
          {
            name: "Deferred",
            box: [72, 560, 1100, 60],
            content: shape(
              ["Deferred: queue migration (own project), failover runbook (Q1 drill)"],
              {
                size: 18,
                color: "#687076",
              },
            ),
          },
        ],
      },
    ]),
};

export const ROADMAP_DECK: LiveBatch = {
  modality: "presentation",
  commands: (ns) =>
    deckCommands(ns, [
      titleSlide("Platform roadmap H1 2027", "Acme Robotics · Platform engineering"),
      {
        title: "Themes",
        nodes: [
          ...heading("Themes"),
          {
            name: "Themes",
            box: [72, 170, 1100, 360],
            content: shape(
              [
                "• Faster deploys: 12 minutes → under 6 minutes",
                "• Postgres 17 everywhere, with a tested failover",
                "• Cost: tag everything, alert on anomalies, 10% lower cloud spend",
                "• Preview environments for every pull request",
              ],
              { size: 26 },
            ),
          },
        ],
      },
      {
        title: "Deploy pipeline duration",
        nodes: [
          ...heading("Deploy pipeline duration (minutes)"),
          {
            name: "Trend",
            box: [72, 160, 1136, 480],
            content: chart(
              "line",
              "Minutes per deploy",
              ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
              [
                { name: "Actual", values: [13.1, 12.4, 12.0, 11.2, 9.8, 8.9] },
                { name: "Target", values: [12, 11, 10, 9, 8, 7] },
              ],
            ),
          },
        ],
      },
      {
        title: "By quarter",
        nodes: [
          ...heading("By quarter"),
          {
            name: "Quarters",
            box: [72, 160, 1136, 250],
            content: table(
              [
                ["", "Q1", "Q2"],
                ["Deploys", "Parallel test shards", "Canary automation"],
                ["Data", "Postgres 17 replica + canary", "Cutover, retire 15"],
                ["Cost", "Tagging + anomaly alerts", "Savings plan renewal"],
                ["DX", "Preview envs (web)", "Preview envs (all services)"],
              ],
              [200, 468, 468],
            ),
          },
        ],
      },
    ]),
};

export const INCIDENT_TEMPLATE_DOCUMENT: LiveBatch = {
  modality: "document",
  commands: (ns) =>
    documentCommands(ns, [
      { h: 1, text: "Incident review: <title>" },
      {
        p: [
          run("Use this template within 5 working days of any incident with customer impact. "),
          run("Keep it blameless.", { italic: true }),
        ],
      },
      { h: 2, text: "Summary" },
      { p: "Two or three sentences: what happened, who was affected, how long it lasted." },
      { h: 2, text: "Impact" },
      {
        table: [
          ["Metric", "Value"],
          ["Duration", ""],
          ["Customers affected", ""],
          ["Error budget consumed", ""],
        ],
        widths: [200, 268],
      },
      { h: 2, text: "Timeline (UTC)" },
      {
        table: [
          ["Time", "Event"],
          ["", ""],
          ["", ""],
        ],
        widths: [80, 388],
      },
      { h: 2, text: "Root cause" },
      { p: "Describe the technical cause and the conditions that let it reach production." },
      { h: 2, text: "Action items" },
      { number: "<action> (owner, due date, ticket)" },
    ]),
};

export const HEADCOUNT_SPREADSHEET: LiveBatch = {
  modality: "spreadsheet",
  commands: (ns) =>
    sheetCommands(ns, [
      {
        name: "Plan",
        rows: [
          [
            "Team",
            "Today",
            "Q1 hires",
            "Q2 hires",
            "End of H1",
            "Cost per head (NOK k)",
            "H1 cost (NOK k)",
          ],
          ["Platform", 6, 1, 1, "=B2+C2+D2", 1240, "=E2*F2/2"],
          ["Data", 4, 1, 0, "=B3+C3+D3", 1180, "=E3*F3/2"],
          ["Fleet software", 9, 2, 1, "=B4+C4+D4", 1210, "=E4*F4/2"],
          ["Web", 5, 0, 1, "=B5+C5+D5", 1150, "=E5*F5/2"],
          ["Support", 7, 1, 1, "=B6+C6+D6", 780, "=E6*F6/2"],
          ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)", "=SUM(E2:E6)", "", "=SUM(G2:G6)"],
        ],
      },
      {
        name: "Open roles",
        rows: [
          ["Role", "Team", "Level", "Target start", "Status"],
          ["Senior platform engineer", "Platform", "L5", "2027-02-01", "Interviewing"],
          ["Data engineer", "Data", "L4", "2027-01-15", "Offer out"],
          ["Firmware engineer", "Fleet software", "L4", "2027-03-01", "Sourcing"],
          ["Support lead, Gdańsk", "Support", "L4", "2027-02-15", "Sourcing"],
        ],
      },
    ]),
};

export const LIVE_CONTENT: Record<string, LiveBatch> = {
  postmortemDoc: POSTMORTEM_DOCUMENT,
  pg17Doc: PG17_DOCUMENT,
  incidentTemplateDoc: INCIDENT_TEMPLATE_DOCUMENT,
  spendSheet: SPEND_SPREADSHEET,
  awsSheet: AWS_SPREADSHEET,
  headcountSheet: HEADCOUNT_SPREADSHEET,
  reliabilityDeck: RELIABILITY_DECK,
  roadmapDeck: ROADMAP_DECK,
};
