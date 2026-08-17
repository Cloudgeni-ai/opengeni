export type ApiWebSocketConnection = Readonly<{
  attach(socket: ApiWebSocketLike): void;
  receive(message: string | Uint8Array | ArrayBuffer): void;
  transportClosed(): void;
}>;

export type ApiWebSocketLike = Readonly<{
  data: ApiWebSocketConnection;
  send(data: Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
  getBufferedAmount?(): number;
}>;

export type ApiWebSocketUpgradeServer = Readonly<{
  upgrade(
    request: Request,
    options: Readonly<{
      data: ApiWebSocketConnection;
      headers: HeadersInit;
    }>,
  ): boolean;
}>;
