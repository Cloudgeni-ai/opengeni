import { expect, test } from "bun:test";
import {
  sameSitePublicationRequest,
  sitePublicationRequest,
} from "../src/site-publication-request";

test("publication retry compares upload identity, metadata and tools without content hashes", () => {
  const input = {
    uploadId: "upload-1",
    title: "Dashboard",
    description: null,
    requestedTools: [{ serverId: "one", toolName: "read" }],
  };
  const receipt = sitePublicationRequest(input);
  expect(sameSitePublicationRequest(receipt, input)).toBe(true);
  expect(
    sameSitePublicationRequest(Object.fromEntries(Object.entries(receipt).reverse()), input),
  ).toBe(true);
  for (const changed of [
    { uploadId: "upload-2" },
    { title: "Other" },
    { description: "Changed" },
    { requestedTools: [] },
  ]) {
    expect(sameSitePublicationRequest(receipt, { ...input, ...changed })).toBe(false);
  }
  expect(sameSitePublicationRequest(null, input)).toBe(true);
  expect(sameSitePublicationRequest(sitePublicationRequest({}), { description: null })).toBe(false);
});
