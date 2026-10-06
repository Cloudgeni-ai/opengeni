declare module "libnpmpublish" {
  type PublishOptions = {
    registry: string;
    forceAuth: { token: string };
    defaultTag: "canary";
    access: "public";
    provenance: boolean;
  };

  type PublishResponse = {
    ok: boolean;
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
