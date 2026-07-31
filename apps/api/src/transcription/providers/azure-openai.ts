import type { TranscriptionProvider } from "@opengeni/core";
import { fetchError, responseError } from "./openai";

export function createAzureOpenAiTranscriptionProvider(input: {
	endpoint: string;
	deployment: string;
	apiVersion: string;
	apiKey: string | null;
	adToken: string | null;
	fetch?: typeof fetch;
}): TranscriptionProvider {
	const fetchImpl = input.fetch ?? fetch;
	const url = `${input.endpoint}/openai/deployments/${encodeURIComponent(input.deployment)}/audio/transcriptions?api-version=${encodeURIComponent(input.apiVersion)}`;
	return {
		id: "azure-openai",
		available: () => Boolean(input.apiKey || input.adToken),
		async transcribe({ audio, mimeType, filename, signal }) {
			const form = new FormData();
			form.append(
				"file",
				new Blob([Uint8Array.from(audio).buffer], { type: mimeType }),
				filename,
			);
			const headers: Record<string, string> = input.apiKey
				? { "api-key": input.apiKey }
				: { Authorization: `Bearer ${input.adToken}` };
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers,
					body: form,
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				throw fetchError(error);
			}
			if (!response.ok) throw responseError(response.status);
			const body = await response.json().catch(() => null);
			if (!body || typeof body.text !== "string") {
				throw responseError(502);
			}
			return {
				text: body.text,
				languages:
					typeof body.language === "string" && body.language
						? [body.language]
						: [],
			};
		},
	};
}
