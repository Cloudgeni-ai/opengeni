import { describe, expect, test } from "bun:test";
import {
  getSettings,
  sandboxBackendServed,
  servedSandboxBackends,
  unservedSandboxBackendMessage,
} from "../src";

const base = { OPENGENI_ENV: "test" };
const modalCredentials = {
  OPENGENI_MODAL_APP_NAME: "opengeni",
  OPENGENI_MODAL_TOKEN_ID: "id",
  OPENGENI_MODAL_TOKEN_SECRET: "secret",
};
const computeCredentials = {
  OPENGENI_COMPUTE_API_URL: "https://compute.example",
  OPENGENI_COMPUTE_API_KEY: "key",
};

describe("sandbox backends a deployment serves for new sessions", () => {
  test("a cloud deployment never serves host backends", () => {
    const settings = getSettings({
      ...base,
      OPENGENI_SANDBOX_BACKEND: "modal",
      ...modalCredentials,
    });
    expect(sandboxBackendServed(settings, "modal")).toBe(true);
    expect(sandboxBackendServed(settings, "none")).toBe(true);
    expect(sandboxBackendServed(settings, "local")).toBe(false);
    expect(sandboxBackendServed(settings, "docker")).toBe(false);
    expect(sandboxBackendServed(settings, "compute")).toBe(false);
    expect(sandboxBackendServed(settings, "daytona")).toBe(false);
    expect(servedSandboxBackends(settings)).toEqual(["modal", "none"]);
  });

  test("a provider with configured credentials is served beside the default", () => {
    const settings = getSettings({
      ...base,
      OPENGENI_SANDBOX_BACKEND: "modal",
      ...modalCredentials,
      ...computeCredentials,
      OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
    });
    expect(servedSandboxBackends(settings)).toEqual(["modal", "none", "selfhosted", "compute"]);
    expect(sandboxBackendServed(settings, "local")).toBe(false);
  });

  test("partial or blank provider credentials do not serve that provider", () => {
    const settings = getSettings({
      ...base,
      OPENGENI_SANDBOX_BACKEND: "local",
      OPENGENI_COMPUTE_API_URL: "https://compute.example",
      OPENGENI_MODAL_APP_NAME: "opengeni",
      OPENGENI_VERCEL_TOKEN: "token",
      OPENGENI_E2B_API_KEY: "   ",
    });
    expect(sandboxBackendServed(settings, "compute")).toBe(false);
    expect(sandboxBackendServed(settings, "modal")).toBe(false);
    expect(sandboxBackendServed(settings, "vercel")).toBe(false);
    expect(sandboxBackendServed(settings, "e2b")).toBe(false);
  });

  test("host backends are served only as the configured default", () => {
    const local = getSettings({ ...base, OPENGENI_SANDBOX_BACKEND: "local" });
    expect(sandboxBackendServed(local, "local")).toBe(true);
    expect(sandboxBackendServed(local, "docker")).toBe(false);
    const docker = getSettings({ ...base, OPENGENI_SANDBOX_BACKEND: "docker" });
    expect(sandboxBackendServed(docker, "docker")).toBe(true);
    expect(sandboxBackendServed(docker, "local")).toBe(false);
  });

  test("selfhosted follows the Connected Machines switch", () => {
    const off = getSettings({ ...base, OPENGENI_SANDBOX_BACKEND: "local" });
    expect(sandboxBackendServed(off, "selfhosted")).toBe(false);
    const on = getSettings({
      ...base,
      OPENGENI_SANDBOX_BACKEND: "local",
      OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
    });
    expect(sandboxBackendServed(on, "selfhosted")).toBe(true);
    const primary = getSettings({ ...base, OPENGENI_SANDBOX_BACKEND: "selfhosted" });
    expect(sandboxBackendServed(primary, "selfhosted")).toBe(true);
  });

  test("the error names the served backends and the default", () => {
    const settings = getSettings({
      ...base,
      OPENGENI_SANDBOX_BACKEND: "modal",
      ...modalCredentials,
    });
    expect(unservedSandboxBackendMessage(settings, "local")).toBe(
      'sandboxBackend "local" is not available in this deployment. Available: modal, none. Omit sandboxBackend to use the deployment default ("modal").',
    );
  });
});
