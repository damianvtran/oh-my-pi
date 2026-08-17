import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	ALIBABA_TOKEN_PLAN_BASE_URL,
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	type AlibabaTokenPlanOAuth,
	serializeAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import * as AIError from "../error";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import { pollOAuthDeviceCodeFlow } from "./oauth/device-code";
import { generatePKCE } from "./oauth/pkce";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const INTERNATIONAL_AUTH_URL = "https://home.qwencloud.com/billing/subscription/token-plan-individual";
const CHINA_AUTH_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=plan";

/**
 * QwenCloud management-OAuth surface. Mirrors the endpoints the official
 * `qwencloud-cli` drives: RFC 8628 device flow with an RFC 7636 S256 challenge
 * in the query string, Pascal-cased JSON envelopes, and no registered client
 * id — the server accepts any stable identifier, so one is minted per login.
 */
const QWENCLOUD_AUTH_ENDPOINT = "https://t.qwencloud.com";

interface QwenCloudDeviceInit {
	deviceToken: string;
	verificationUrl: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

/** Fetch and validate one JSON body from the QwenCloud auth surface. */
async function fetchQwenCloudAuthJson(
	fetchImpl: FetchImpl,
	url: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchImpl(url, { method: "POST", signal });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new AIError.OAuthError(`QwenCloud authorization request failed: ${message}`, {
			kind: "polling",
			provider: "alibaba-token-plan",
		});
	}
	if (!response.ok) {
		throw new AIError.OAuthError(`QwenCloud authorization returned HTTP ${response.status}`, {
			kind: "http",
			provider: "alibaba-token-plan",
			status: response.status,
		});
	}
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null) {
		throw new AIError.OAuthError("QwenCloud authorization returned a non-JSON body", {
			kind: "validation",
			provider: "alibaba-token-plan",
		});
	}
	return payload as Record<string, unknown>;
}

function qwenCloudDeviceInit(payload: Record<string, unknown>): QwenCloudDeviceInit {
	const data = payload.Data as Record<string, unknown> | undefined;
	const deviceToken = typeof data?.Token === "string" ? data.Token : "";
	const verificationUrl = typeof data?.VerificationUrl === "string" ? data.VerificationUrl : "";
	const expiresIn = typeof data?.ExpiresIn === "number" ? data.ExpiresIn : undefined;
	const interval = typeof data?.Interval === "number" ? data.Interval : undefined;
	if (payload.Success !== true || !deviceToken || !verificationUrl || !expiresIn || !interval) {
		throw new AIError.OAuthError("QwenCloud device authorization init returned an invalid payload", {
			kind: "validation",
			provider: "alibaba-token-plan",
		});
	}
	return {
		deviceToken,
		verificationUrl,
		expiresInSeconds: expiresIn,
		intervalSeconds: interval,
	};
}

/**
 * Normalize `ExpireTime`, which the auth surface returns as either RFC 3339 or
 * epoch seconds/milliseconds depending on region deployment.
 */
function parseQwenCloudExpiry(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string" && value) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

/**
 * Complete the QwenCloud management-OAuth device flow.
 *
 * The grant is stored inside the Token Plan credential (never sent to model
 * endpoints) and authorizes quota queries against the official
 * `cli.qwencloud.com` gateway — replacing the console-cookie scrape the
 * provider used before QwenCloud shipped a first-party management API.
 */
async function loginQwenCloudManagementOAuth(options: OAuthController): Promise<AlibabaTokenPlanOAuth> {
	const fetchImpl: FetchImpl = options.fetch ?? fetch;
	const { verifier, challenge } = await generatePKCE();
	const clientId = crypto.randomUUID();
	const init = qwenCloudDeviceInit(
		await fetchQwenCloudAuthJson(
			fetchImpl,
			`${QWENCLOUD_AUTH_ENDPOINT}/cli/device/code?client_id=${encodeURIComponent(clientId)}` +
				`&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
			options.signal,
		),
	);

	options.onAuth?.({
		url: init.verificationUrl,
		instructions:
			"Open the URL, sign in to QwenCloud, and approve the CLI access request. Login continues automatically once approved — no code entry needed.",
	});
	options.onProgress?.("Waiting for QwenCloud authorization...");

	const oauth = await pollOAuthDeviceCodeFlow<AlibabaTokenPlanOAuth>({
		intervalSeconds: init.intervalSeconds,
		expiresInSeconds: init.expiresInSeconds,
		signal: options.signal,
		poll: async () => {
			const payload = await fetchQwenCloudAuthJson(
				fetchImpl,
				`${QWENCLOUD_AUTH_ENDPOINT}/cli/device/token?client_id=${encodeURIComponent(clientId)}` +
					`&token=${encodeURIComponent(init.deviceToken)}&code_verifier=${encodeURIComponent(verifier)}`,
				options.signal,
			);
			const data = payload.Data as Record<string, unknown> | undefined;
			const status = String(data?.Status ?? "authorization_pending").toLowerCase();
			if (status === "authorization_pending") return { status: "pending" as const };
			if (status === "slow_down") return { status: "slow_down" as const };
			if (status === "expired_token") {
				return {
					status: "failed" as const,
					message: "QwenCloud device code expired before approval — restart the login",
				};
			}
			if (status !== "complete") {
				return {
					status: "failed" as const,
					message:
						status === "access_denied"
							? "QwenCloud authorization was denied — approve the CLI access request and retry"
							: `QwenCloud device flow failed: ${status}`,
				};
			}
			const credentials = data?.Credentials as Record<string, unknown> | undefined;
			const accessToken = typeof credentials?.AccessToken === "string" ? credentials.AccessToken : "";
			if (!credentials || !accessToken) {
				return {
					status: "failed" as const,
					message: "QwenCloud device flow completed without an access token",
				};
			}
			const user = credentials.User as Record<string, unknown> | undefined;
			const grant: AlibabaTokenPlanOAuth = { clientId, accessToken };
			const refreshToken = typeof credentials.RefreshToken === "string" ? credentials.RefreshToken.trim() : "";
			if (refreshToken) grant.refreshToken = refreshToken;
			const expiresAt = parseQwenCloudExpiry(credentials.ExpireTime);
			if (expiresAt) grant.expiresAt = expiresAt;
			const aliyunId = typeof user?.AliyunId === "string" ? user.AliyunId.trim() : "";
			if (aliyunId) grant.aliyunId = aliyunId;
			const email = typeof user?.Email === "string" ? user.Email.trim() : "";
			if (email) grant.email = email;
			return { status: "complete" as const, value: grant };
		},
	});
	return oauth;
}

/**
 * Log in to the QwenCloud Token Plan provider.
 *
 * The Token Plan ships as two regionally separate products with
 * non-interchangeable keys — International (Singapore) and China (Beijing) —
 * so login first selects the region (or a custom base URL) before pasting the
 * key, mirroring {@link loginAlibabaCodingPlan}. The chosen region is validated
 * against its own `/models` endpoint and, when it diverges from the default
 * international endpoint, stored in the credential so inference and discovery
 * both target it (#6682).
 *
 * Quota reporting: international logins complete the QwenCloud management-OAuth
 * device flow, whose `usage:read` grant powers first-party consumption
 * tracking. The China (Beijing) product has no QwenCloud OAuth equivalent, so
 * it keeps the legacy optional console-cookie prompt as its only quota source.
 */
export async function loginAlibabaTokenPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("QwenCloud Token Plan");
	}

	const endpointChoice = await options.onPrompt({
		message:
			"Select QwenCloud Token Plan region: 1=International (default), 2=China (Beijing), 3=Custom — enter 1, 2, or 3",
		placeholder: "1",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const choice = endpointChoice.trim();
	let baseUrl: string;
	let authUrl: string;
	let instructions: string;
	if (choice === "2") {
		baseUrl = ALIBABA_TOKEN_PLAN_CN_BASE_URL;
		authUrl = CHINA_AUTH_URL;
		instructions = "Subscribe to the China (Beijing) 百炼 Token Plan and copy its dedicated API key";
	} else if (choice === "3") {
		const customUrl = await options.onPrompt({
			message: "Enter custom Token Plan base URL",
			placeholder: "https://token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1",
		});
		const trimmedUrl = customUrl.trim().replace(/\/+$/, "");
		if (!trimmedUrl) {
			throw new AIError.ConfigurationError("Custom URL is required for option 3");
		}
		baseUrl = trimmedUrl;
		authUrl = INTERNATIONAL_AUTH_URL;
		instructions = "Copy your Token Plan API key for the custom endpoint";
	} else {
		baseUrl = ALIBABA_TOKEN_PLAN_BASE_URL;
		authUrl = INTERNATIONAL_AUTH_URL;
		instructions = "Subscribe to Token Plan Individual and copy its dedicated API key";
	}

	options.onAuth?.({ url: authUrl, instructions });

	const apiKeyInput = await options.onPrompt({
		message: "Paste your QwenCloud Token Plan API key",
		placeholder: "sk-sp-...",
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const apiKey = apiKeyInput.trim();
	if (!apiKey) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.("Validating API key...");
	await validateApiKeyAgainstModelsEndpoint({
		provider: "QwenCloud Token Plan",
		apiKey,
		modelsUrl: `${baseUrl}/models`,
		signal: options.signal,
		fetch: options.fetch,
	});

	let cookie = "";
	let oauth: AlibabaTokenPlanOAuth | undefined;
	if (baseUrl === ALIBABA_TOKEN_PLAN_CN_BASE_URL) {
		const rawCookie = await options.onPrompt({
			message:
				"Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the bailian-cs.console.aliyun.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.",
			placeholder: "name=value; name=value; ...",
			allowEmpty: true,
		});
		cookie = rawCookie
			.trim()
			.replace(/^Cookie:\s*/i, "")
			.trim();
		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}
		if (
			cookie &&
			!cookie.split(";").some(segment => {
				const separator = segment.indexOf("=");
				return separator > 0 && Boolean(segment.slice(0, separator).trim() && segment.slice(separator + 1).trim());
			})
		) {
			throw new AIError.ConfigurationError(
				"Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the bailian-cs.console.aliyun.com usage request, not a single cookie value.",
			);
		}
	} else {
		options.onProgress?.("Authorizing quota reporting via QwenCloud...");
		oauth = await loginQwenCloudManagementOAuth(options);
	}

	// International (default) logins keep the API key as the inference
	// credential; only a diverging region is persisted so it can override the
	// catalog base URL at inference and discovery time.
	const regionUrl = baseUrl === ALIBABA_TOKEN_PLAN_BASE_URL ? undefined : baseUrl;
	return serializeAlibabaTokenPlanCredential(apiKey, cookie, regionUrl, oauth);
}

export const alibabaTokenPlanProvider = {
	id: "alibaba-token-plan",
	name: "QwenCloud Token Plan",
	login: (cb: OAuthLoginCallbacks) => loginAlibabaTokenPlan(cb),
} as const satisfies ProviderDefinition;
