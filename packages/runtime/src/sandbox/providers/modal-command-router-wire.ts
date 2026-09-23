import { Client, Metadata, credentials, status, type ServiceError } from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { ProviderCommandStartRejectedError } from "../provider-command-session";

// Narrow wire projection of Modal 0.9.0's task_command_router.proto. The public
// SDK does not expose resumable byte offsets or cancellable command RPCs. Keep
// this boundary pinned and exercise it against an actual gRPC server in tests.
// Neither the JWT nor the router URL belongs in a durable command locator.
export const modalRouterWire = protobuf.parse(`syntax = "proto3";
message Identity { string task_id = 1; string exec_id = 2; }
message Pty {
  bool enabled = 1; uint32 winsz_rows = 2; uint32 winsz_cols = 3;
  string env_term = 4; string env_colorterm = 5; string env_term_program = 6;
  int32 pty_type = 7; bool no_terminate_on_idle_stdin = 8;
}
message Start {
  string task_id = 1; string exec_id = 2; repeated string command_args = 3;
  int32 stdout_config = 4; int32 stderr_config = 5;
  optional uint32 timeout_secs = 6; optional string workdir = 7;
  repeated string secret_ids = 8; optional Pty pty_info = 9;
  bool runtime_debug = 10; string container_id = 11; map<string,string> env = 12;
}
message Read {
  string task_id = 1; string exec_id = 2; uint64 offset = 3; int32 file_descriptor = 4;
}
message Data { bytes data = 1; }
message Poll { optional int32 code = 1; optional int32 signal = 2; }
message Write {
  string task_id = 1; string exec_id = 2; uint64 offset = 3; bytes data = 4; bool eof = 5;
}
message Empty {}
`).root;

const prefix = "/modal.task_command_router.TaskCommandRouter/";
const maxPageBytes = 64 * 1024;
const maxWireBytes = 4 * 1024 * 1024;

/** Only constructed at the authenticated Start RPC boundary. Transport loss,
 * deadline, cancellation and UNKNOWN are deliberately not rejection proof. */
export class ModalCommandStartRejectedError extends ProviderCommandStartRejectedError {
  constructor(
    readonly code: number,
    cause: unknown,
  ) {
    super(cause);
    this.name = "ModalCommandStartRejectedError";
  }
}

export type ModalRouterIdentity = { taskId: string; execId: string };
export type ModalRouterAccess = { url: string; jwt: string };
export type ModalRouterStart = ModalRouterIdentity & {
  commandArgs: string[];
  workdir: string;
  env: Record<string, string>;
  ptyInfo?: {
    enabled: boolean;
    winszRows: number;
    winszCols: number;
    envTerm: string;
    ptyType: number;
    noTerminateOnIdleStdin: boolean;
  };
};

function encode(type: string, value: object): Buffer {
  const codec = modalRouterWire.lookupType(type);
  return Buffer.from(codec.encode(codec.fromObject(value)).finish());
}

/** A single authenticated transport, owned and closed by its command adapter.
 * Reads may stop at a byte boundary because the next read resumes at that exact
 * offset. Mutations are never retried by this layer, including ambiguous starts.
 */
export class ModalCommandRouterWire {
  private readonly client: Client;
  private readonly metadata: Metadata;
  private closed = false;

  constructor(access: ModalRouterAccess, trustedRoots?: Buffer) {
    const url = new URL(access.url);
    if (url.protocol !== "https:" || url.username || url.password || !access.jwt)
      throw new Error("Modal command router requires authenticated TLS");
    this.client = new Client(url.host, credentials.createSsl(trustedRoots), {
      "grpc.max_receive_message_length": maxWireBytes,
      "grpc.max_send_message_length": maxWireBytes,
      "grpc.enable_retries": 0,
    });
    this.metadata = new Metadata();
    this.metadata.set("authorization", `Bearer ${access.jwt}`);
  }

  close(): void {
    this.closed = true;
    this.client.close();
  }

  private async unary(
    method: "TaskExecStart" | "TaskExecStdinWrite" | "TaskExecPoll",
    requestType: string,
    responseType: string,
    request: object,
    signal?: AbortSignal,
  ): Promise<protobuf.Message> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Modal command router is closed");
    return await new Promise((resolve, reject) => {
      const call = this.client.makeUnaryRequest(
        prefix + method,
        (value: object) => encode(requestType, value),
        (bytes) => modalRouterWire.lookupType(responseType).decode(bytes),
        request,
        this.metadata,
        { deadline: Date.now() + 30_000 },
        (error, result) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(signal.reason);
          else if (error) reject(error);
          else if (result) resolve(result);
          else reject(new Error("Modal command router returned no response"));
        },
      );
      const abort = () => call.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async start(request: ModalRouterStart, signal?: AbortSignal): Promise<void> {
    try {
      await this.unary(
        "TaskExecStart",
        "Start",
        "Empty",
        {
          ...request,
          stdoutConfig: 1,
          stderrConfig: 1,
        },
        signal,
      );
    } catch (error) {
      const code = (error as Partial<ServiceError> | null)?.code;
      if (
        typeof code === "number" &&
        [
          status.INVALID_ARGUMENT,
          status.NOT_FOUND,
          status.PERMISSION_DENIED,
          status.UNAUTHENTICATED,
          status.UNIMPLEMENTED,
        ].includes(code)
      )
        throw new ModalCommandStartRejectedError(code, error);
      throw error;
    }
  }

  async write(
    identity: ModalRouterIdentity,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid Modal stdin byte offset");
    await this.unary(
      "TaskExecStdinWrite",
      "Write",
      "Empty",
      { ...identity, offset, data, eof: false },
      signal,
    );
  }

  async poll(identity: ModalRouterIdentity, signal?: AbortSignal): Promise<number | null> {
    const value = await this.unary("TaskExecPoll", "Identity", "Poll", identity, signal);
    const decoded = modalRouterWire.lookupType("Poll").toObject(value) as {
      code?: number;
      signal?: number;
    };
    if (decoded.code !== undefined) return decoded.code;
    if (decoded.signal !== undefined) return 128 + decoded.signal;
    return null;
  }

  async read(
    identity: ModalRouterIdentity,
    stream: "stdout" | "stderr",
    offset: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; eof: boolean }> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Modal command router is closed");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 50_000
    )
      throw new Error("Invalid Modal output read bounds");
    const chunks: Buffer[] = [];
    let length = 0;
    let limited = false;
    return await new Promise((resolve, reject) => {
      const call = this.client.makeServerStreamRequest(
        prefix + "TaskExecStdioRead",
        (value: object) => encode("Read", value),
        (bytes) =>
          modalRouterWire.lookupType("Data").decode(bytes) as protobuf.Message & {
            data: Uint8Array;
          },
        { ...identity, offset, fileDescriptor: stream === "stdout" ? 0 : 1 },
        this.metadata,
        { deadline: Date.now() + Math.max(1, waitMs) },
      );
      const abort = () => call.cancel();
      const finish = (eof: boolean, error?: unknown) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else if (error) reject(error);
        else resolve({ bytes: Buffer.concat(chunks, length), eof });
      };
      call.on("data", (value: { data: Uint8Array }) => {
        if (limited) return;
        const part = Buffer.from(value.data).subarray(0, maxPageBytes - length);
        if (part.length) {
          chunks.push(part);
          length += part.length;
        }
        if (length === maxPageBytes) {
          limited = true;
          call.cancel();
        }
      });
      call.once("error", (error: ServiceError) => {
        if ((limited && error.code === status.CANCELLED) || error.code === status.DEADLINE_EXCEEDED)
          finish(false);
        else finish(false, error);
      });
      call.once("end", () => finish(!limited));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
