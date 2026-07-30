#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const PACKAGE_NAME = "@opengeni/ogtool";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function packageVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    );
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // A malformed/custom installation is reported honestly by --version and
    // doctor rather than blocking the direct MCP fallback.
  }
  return "unknown";
}

const VERSION = packageVersion();

function usage(exitCode = 1) {
  const out = [
    "usage:",
    "  ogtool list",
    "  ogtool call <tool-name> [json-object]",
    "  ogtool doctor",
    "  ogtool --version",
    "",
    "aliases: tools/list, tools/call",
    "requires OPENGENI_TOOLSPACE_TOKEN_FILE and OPENGENI_TOOLSPACE_URL for list/call",
  ].join("\n");
  (exitCode === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exitCode = exitCode;
}

function positiveIntegerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function configuredEndpoint() {
  const raw = process.env.OPENGENI_TOOLSPACE_URL;
  if (!raw) throw new Error("OPENGENI_TOOLSPACE_URL is required");
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("OPENGENI_TOOLSPACE_URL must be a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("OPENGENI_TOOLSPACE_URL must use http or https");
  }
  return target;
}

function readToken() {
  const tokenFile = process.env.OPENGENI_TOOLSPACE_TOKEN_FILE;
  if (!tokenFile) throw new Error("OPENGENI_TOOLSPACE_TOKEN_FILE is required");
  let token;
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error("OPENGENI_TOOLSPACE_TOKEN_FILE is not readable");
  }
  if (!token) throw new Error("OPENGENI_TOOLSPACE_TOKEN_FILE is empty");
  return token;
}

function doctor() {
  const tokenFile = process.env.OPENGENI_TOOLSPACE_TOKEN_FILE ?? null;
  const rawUrl = process.env.OPENGENI_TOOLSPACE_URL ?? null;
  let urlValid = false;
  let protocol = null;
  if (rawUrl) {
    try {
      const target = new URL(rawUrl);
      protocol = target.protocol;
      urlValid = protocol === "http:" || protocol === "https:";
    } catch {
      urlValid = false;
    }
  }
  let tokenFileReadable = false;
  let tokenFileNonempty = false;
  if (tokenFile) {
    try {
      tokenFileReadable = fs.statSync(tokenFile).isFile();
      tokenFileNonempty = tokenFileReadable && fs.readFileSync(tokenFile, "utf8").trim().length > 0;
    } catch {
      tokenFileReadable = false;
    }
  }
  const ok = urlValid && tokenFileReadable && tokenFileNonempty;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        package: PACKAGE_NAME,
        version: VERSION,
        node: process.version,
        urlConfigured: rawUrl !== null,
        urlValid,
        protocol,
        tokenFileConfigured: tokenFile !== null,
        tokenFileReadable,
        tokenFileNonempty,
        packageSpec: process.env.OPENGENI_OGTOOL_PACKAGE_SPEC ?? null,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = ok ? 0 : 1;
}

function parseEventStream(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      throw new Error("Toolspace returned an invalid event-stream JSON message");
    }
  }
  return messages.at(-1) ?? null;
}

function parseResponseBody(text, contentType) {
  if (!text) return null;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return parseEventStream(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Toolspace returned a non-JSON response");
  }
}

class McpClient {
  constructor(target, token) {
    this.target = target;
    this.token = token;
    this.nextId = 1;
    this.sessionId = null;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
    this.maxResponseBytes = positiveIntegerEnvironment(
      "OPENGENI_OGTOOL_MAX_RESPONSE_BYTES",
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.timeoutMs = positiveIntegerEnvironment("OPENGENI_OGTOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  }

  rpc(method, params) {
    return {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    };
  }

  notify(method, params) {
    return {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
  }

  request(payload) {
    const body = JSON.stringify(payload);
    const transport = this.target.protocol === "https:" ? https : http;
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    return new Promise((resolve, reject) => {
      const request = transport.request(
        this.target,
        { method: "POST", headers, timeout: this.timeoutMs },
        (response) => {
          const chunks = [];
          let received = 0;
          response.on("data", (chunk) => {
            received += chunk.length;
            if (received > this.maxResponseBytes) {
              response.destroy(
                new Error(`Toolspace response exceeds ${this.maxResponseBytes} bytes`),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const returnedSession = response.headers["mcp-session-id"];
            if (typeof returnedSession === "string" && returnedSession) {
              this.sessionId = returnedSession;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const preview = text.replace(/\s+/gu, " ").trim().slice(0, 1_000);
              reject(new Error(`Toolspace HTTP ${status}${preview ? `: ${preview}` : ""}`));
              return;
            }
            try {
              resolve(parseResponseBody(text, String(response.headers["content-type"] ?? "")));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Toolspace request timed out")));
      request.on("error", reject);
      request.end(body);
    });
  }

  async initialize() {
    const initialized = await this.request(
      this.rpc("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ogtool", version: VERSION },
      }),
    );
    const negotiated = initialized?.result?.protocolVersion;
    if (typeof negotiated === "string" && negotiated) this.protocolVersion = negotiated;
    await this.request(this.notify("notifications/initialized"));
  }
}

function parseToolArguments(raw) {
  if (raw === undefined) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("tool arguments must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h" || command === "help") {
    usage(0);
    return;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "doctor") {
    doctor();
    return;
  }
  if (!command) {
    usage();
    return;
  }

  const client = new McpClient(configuredEndpoint(), readToken());
  await client.initialize();
  let response;
  if (command === "list" || command === "tools/list") {
    response = await client.request(client.rpc("tools/list", {}));
  } else if (command === "call" || command === "tools/call") {
    const name = process.argv[3];
    if (!name) throw new Error("tool name is required");
    response = await client.request(
      client.rpc("tools/call", { name, arguments: parseToolArguments(process.argv[4]) }),
    );
  } else {
    usage();
    return;
  }

  if (response?.error) {
    process.stderr.write(`${JSON.stringify(response, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(response?.result ?? response, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { McpClient, parseEventStream, parseResponseBody, parseToolArguments };
