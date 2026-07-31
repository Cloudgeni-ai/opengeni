import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type Permission, signDelegatedAccessToken } from "@opengeni/contracts";
import type { TranscriptionService } from "@opengeni/core";
import * as dbModule from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const SECRET = "transcription-route-secret";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

function service(available = true): TranscriptionService {
	return {
		limits: () => ({
			maxDurationSeconds: 60,
			maxSizeBytes: 10,
			acceptedMimeTypes: ["audio/webm"],
		}),
		available: () => available,
		transcribe: async () => ({
			text: "transcribed",
			languages: ["en"],
			providerId: "test",
			audioSeconds: 0,
			latencyMs: 1,
		}),
	};
}

function app(transcription: TranscriptionService | null = service()) {
	return createApp({
		settings: testSettings({
			productAccessMode: "managed",
			delegationSecret: SECRET,
			voiceInputProviderOrder: "",
		}),
		db: {} as never,
		bus: {} as never,
		workflowClient: {} as never,
		managedAuth: null,
		transcription,
	});
}

async function bearer(
	permissions: Permission[] = ["sessions:create"],
): Promise<string> {
	return `Bearer ${await signDelegatedAccessToken(SECRET, {
		accountId: ACCOUNT,
		workspaceId: WORKSPACE,
		subjectId: "tester",
		permissions,
		principalKind: "human_session",
		exp: Math.floor(Date.now() / 1000) + 3600,
	})}`;
}

afterEach(() => {
	spyOn(dbModule, "getWorkspace").mockRestore();
});

describe("transcription routes", () => {
	test("projects capability availability", async () => {
		expect((await app(service(true)).request("/v1/config/client")).status).toBe(
			200,
		);
		expect(
			await (await app(service(true)).request("/v1/config/client")).json(),
		).toMatchObject({
			voiceInput: { available: true },
		});
		expect(
			await (await app(service(false)).request("/v1/config/client")).json(),
		).toMatchObject({
			voiceInput: { available: false },
		});
	});

	test("requires session-create access", async () => {
		const response = await app().request(
			`/v1/workspaces/${WORKSPACE}/transcriptions`,
			{
				method: "POST",
				headers: { "content-type": "audio/webm" },
				body: new Uint8Array([1]),
			},
		);
		expect(response.status).toBe(401);
	});

	test.each([
		{ voiceInput: { enabled: false } },
		{
			transcription: {
				enabled: false,
				acceptanceId: null,
				primary: null,
				language: null,
				autoDetectLanguage: true,
				diarization: { enabled: false, maxSpeakers: null },
				retention: { mode: "none", maxDays: null },
				privacy: { allowProviderLogging: false, allowProviderTraining: false },
				fallback: { mode: "disabled", targets: [] },
				cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
			},
		},
	])("blocks disabled workspace policy", async (settings) => {
		spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings } as never);
		const response = await app().request(
			`/v1/workspaces/${WORKSPACE}/transcriptions`,
			{
				method: "POST",
				headers: {
					authorization: await bearer(),
					"content-type": "audio/webm",
				},
				body: new Uint8Array([1]),
			},
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "policy_blocked" });
	});

	test("returns only transcript response fields", async () => {
		spyOn(dbModule, "getWorkspace").mockResolvedValue({
			settings: {},
		} as never);
		const response = await app().request(
			`/v1/workspaces/${WORKSPACE}/transcriptions`,
			{
				method: "POST",
				headers: {
					authorization: await bearer(),
					"content-type": "audio/webm",
				},
				body: new Uint8Array([1, 2]),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			text: "transcribed",
			languages: ["en"],
		});
	});
});
