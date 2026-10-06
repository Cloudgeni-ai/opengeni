declare module "libnpmpublish" {
  type PublishOptions = {
    registry: string;
    forceAuth: { token: string };
    defaultTag: "canary";
    access: "public";
    provenance: boolean;
    retry?: { retries: 0 };
    timeout?: number;
    signal?: AbortSignal;
  };

  type PublishResponse = {
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    transparencyLogUrl?: string;
  };

  const publisher: {
    publish(
      manifest: Record<string, unknown>,
      tarball: Buffer,
      options: PublishOptions,
    ): Promise<PublishResponse>;
  };

  export default publisher;
}
