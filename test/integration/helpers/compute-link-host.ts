/**
 * A TypeScript stand-in for a compute host's side of the agent link
 * (compute/docs/agent-link.md section 4): it dials the gateway with a host
 * token, opens sessions with sandbox tickets, subscribes, publishes and
 * receives messages, so the gateway is tested without a real compute host.
 * Also signs the control service's tokens with a test Ed25519 key.
 */

import {
  AGENT_LINK_PROTOCOL,
  decodeGatewayFrame,
  encodeFrame,
  type GatewayFrame,
  type HostFrame,
} from "../../../apps/api/src/sandbox/compute-link-frames";

export type TestLinkKey = {
  kid: string;
  privateKey: CryptoKey;
  jwk: { kty: "OKP"; crv: "Ed25519"; kid: string; x: string };
};

export async function generateTestLinkKey(kid: string): Promise<TestLinkKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: "OKP", crv: "Ed25519", kid, x: exported.x! },
  };
}

/** Sign a link token as the control service does: an EdDSA JWT naming its key. */
export async function signTestLinkToken(
  key: TestLinkKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signing = `${part({ alg: "EdDSA", typ: "JWT", kid: key.kid })}.${part(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key.privateKey,
    new TextEncoder().encode(signing),
  );
  return `${signing}.${Buffer.from(signature).toString("base64url")}`;
}

export async function hostToken(
  key: TestLinkKey,
  input: { audience: string; host: string; ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signTestLinkToken(key, {
    typ: "compute-host",
    iss: "test-fleet",
    aud: input.audience,
    sub: input.host,
    iat: now,
    exp: now + (input.ttlSeconds ?? 3600),
  });
}

export async function sandboxTicket(
  key: TestLinkKey,
  input: {
    audience: string;
    sandbox: string;
    host: string;
    epoch: number;
    team: string;
    workspaceId: string;
    agentId: string;
  },
): Promise<string> {
  return await signTestLinkToken(key, {
    typ: "compute-sandbox",
    iss: "test-fleet",
    aud: input.audience,
    sub: input.sandbox,
    host: input.host,
    epoch: input.epoch,
    team: input.team,
    workspace: input.workspaceId,
    agent: input.agentId,
  });
}

type Waiter = {
  match: (frame: GatewayFrame) => boolean;
  resolve: (frame: GatewayFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One host link to the gateway. Every frame received is kept in `frames`. */
export class TestComputeHostLink {
  readonly frames: GatewayFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private closedWith: { code: number; reason: string } | null = null;
  private readonly closedWaiters: Array<(value: { code: number; reason: string }) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") throw new Error("the gateway sent a text frame");
      const frame = decodeGatewayFrame(new Uint8Array(event.data as ArrayBuffer));
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    });
    socket.addEventListener("close", (event) => {
      this.closedWith = { code: event.code, reason: event.reason };
      for (const resolve of this.closedWaiters.splice(0)) resolve(this.closedWith);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`link closed (${event.code} ${event.reason})`));
      }
    });
  }

  /** Dial the gateway; resolves after the gateway's `hello`. */
  static async connect(url: string, token: string): Promise<TestComputeHostLink> {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      protocols: [AGENT_LINK_PROTOCOL],
    } as unknown as string[]);
    const link = new TestComputeHostLink(socket);
    const hello = link.next((frame) => frame.t === "hello", 5_000);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("link refused")), { once: true });
      socket.addEventListener(
        "close",
        (event) => reject(new Error(`link refused (${event.code})`)),
        { once: true },
      );
    });
    await hello;
    return link;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  send(frame: HostFrame): void {
    this.socket.send(Uint8Array.from(encodeFrame(frame)));
  }

  sendRaw(data: string | Uint8Array): void {
    this.socket.send(typeof data === "string" ? data : Uint8Array.from(data));
  }

  /** The next frame (received from now on, or already kept and unclaimed by
   * `since`) that matches. */
  next(
    match: (frame: GatewayFrame) => boolean,
    timeoutMs = 5_000,
    since?: number,
  ): Promise<GatewayFrame> {
    if (since !== undefined) {
      const found = this.frames.slice(since).find(match);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error("timed out waiting for a gateway frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Open a session; resolves with its `opened` or `refused`. */
  async open(input: {
    s: number;
    sandbox: string;
    ticket: string;
    connection: string;
  }): Promise<Extract<GatewayFrame, { t: "opened" | "refused" }>> {
    const answer = this.next(
      (frame) => (frame.t === "opened" || frame.t === "refused") && frame.s === input.s,
    );
    this.send({ t: "open", ...input });
    return (await answer) as Extract<GatewayFrame, { t: "opened" | "refused" }>;
  }

  close(): void {
    this.socket.close(1000, "host done");
  }

  closed(): Promise<{ code: number; reason: string }> {
    if (this.closedWith) return Promise.resolve(this.closedWith);
    return new Promise((resolve) => this.closedWaiters.push(resolve));
  }
}

/** Try to dial and report the HTTP refusal (Bun surfaces it as a close). */
export async function dialRefused(url: string, token: string | null): Promise<boolean> {
  const socket = new WebSocket(url, {
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    protocols: [AGENT_LINK_PROTOCOL],
  } as unknown as string[]);
  return await new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => {
      socket.close();
      resolve(false);
    });
    socket.addEventListener("error", () => resolve(true));
    socket.addEventListener("close", () => resolve(true));
  });
}
