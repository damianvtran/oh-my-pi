import { describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { loginAlibabaTokenPlan } from "@oh-my-pi/pi-ai/registry/alibaba-token-plan";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const OAUTH_EXPIRY = Date.parse("2030-01-01T00:00:00Z");

/**
 * Route login fetches: model-endpoint validation plus the QwenCloud device
 * flow (code init + first poll already complete).
 */
function loginFetchMock(urls?: string[]): FetchImpl {
	return input => {
		const url = String(input);
		urls?.push(url);
		if (url.includes("/cli/device/code")) {
			return Promise.resolve(
				Response.json({
					Success: true,
					Data: {
						Token: "device-token",
						VerificationUrl: "https://t.qwencloud.com/verify",
						ExpiresIn: 600,
						Interval: 1,
					},
				}),
			);
		}
		if (url.includes("/cli/device/token")) {
			return Promise.resolve(
				Response.json({
					Success: true,
					Data: {
						Status: "complete",
						Credentials: {
							AccessToken: "qc-access",
							RefreshToken: "qc-refresh",
							ExpireTime: "2030-01-01T00:00:00Z",
							User: { AliyunId: "damian-aliyun", Email: "damian@example.com" },
						},
					},
				}),
			);
		}
		return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus" }] }));
	};
}

describe("QwenCloud Token Plan login", () => {
	test("International (default) region runs the OAuth device flow and stores the grant", async () => {
		const authRequests: { url: string; instructions?: string }[] = [];
		let requestedUrl = "";
		let authorization = "";
		const urls: string[] = [];
		const prompts = ["1", " sk-sp-test "];
		const credential = await loginAlibabaTokenPlan({
			onAuth: request => authRequests.push(request),
			onPrompt: async prompt => (prompt.allowEmpty ? "" : (prompts.shift() ?? "")),
			fetch: (input, init) => {
				const url = String(input);
				if (url.endsWith("/models")) {
					requestedUrl = url;
					authorization = new Headers(init?.headers).get("Authorization") ?? "";
				}
				return loginFetchMock(urls)(input, init);
			},
		});

		// The OAuth grant rides inside the compound credential; inference
		// itself still sees only the API key.
		expect(JSON.parse(credential)).toEqual({
			token: "sk-sp-test",
			oauth: {
				clientId: expect.any(String),
				accessToken: "qc-access",
				refreshToken: "qc-refresh",
				expiresAt: OAUTH_EXPIRY,
				aliyunId: "damian-aliyun",
				email: "damian@example.com",
			},
		});
		expect(authRequests).toHaveLength(2);
		expect(authRequests[0]?.url).toBe("https://home.qwencloud.com/billing/subscription/token-plan-individual");
		expect(authRequests[1]).toMatchObject({ url: "https://t.qwencloud.com/verify" });
		expect(
			urls.some(
				url =>
					url.startsWith("https://t.qwencloud.com/cli/device/code?") && url.includes("code_challenge_method=S256"),
			),
		).toBe(true);
		expect(urls.some(url => url.startsWith("https://t.qwencloud.com/cli/device/token?"))).toBe(true);
		expect(requestedUrl).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models");
		expect(authorization).toBe("Bearer sk-sp-test");

		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.8-max");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");
		const setup = resolveOpenAIRequestSetup(model, { apiKey: credential, messages: [] });
		expect(setup.headers.Authorization).toBe("Bearer sk-sp-test");
	});

	test("China (Beijing) region keeps the console-cookie prompt instead of the device flow", async () => {
		const authRequests: { url: string; instructions?: string }[] = [];
		let requestedUrl = "";
		let cookiePrompt = "";
		const prompts = ["2", "sk-sp-beijing"];
		const urls: string[] = [];
		const credential = await loginAlibabaTokenPlan({
			onAuth: request => authRequests.push(request),
			onPrompt: async prompt => {
				if (prompt.allowEmpty) {
					cookiePrompt = prompt.message;
					return "";
				}
				return prompts.shift() ?? "";
			},
			fetch: (input, init) => {
				const url = String(input);
				if (url.endsWith("/models")) requestedUrl = url;
				return loginFetchMock(urls)(input, init);
			},
		});

		expect(requestedUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models");
		expect(authRequests).toEqual([
			{ url: "https://www.aliyun.com/benefit/scene/tokenplan", instructions: expect.any(String) },
		]);
		expect(cookiePrompt).toContain("bailian-cs.console.aliyun.com/data/api.json");
		expect(urls.filter(url => url.includes("t.qwencloud.com"))).toEqual([]);
		expect(JSON.parse(credential)).toEqual({
			token: "sk-sp-beijing",
			baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		});

		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");
		const setup = resolveOpenAIRequestSetup(model, { apiKey: credential, messages: [] });
		expect(setup.baseUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
		expect(setup.headers.Authorization).toBe("Bearer sk-sp-beijing");
	});

	test("custom region is validated against and stored as its own base URL", async () => {
		let requestedUrl = "";
		const prompts = ["3", "https://token-plan.example.com/v1/", "sk-sp-custom"];
		const credential = await loginAlibabaTokenPlan({
			onAuth: () => {},
			onPrompt: async prompt => (prompt.allowEmpty ? "" : (prompts.shift() ?? "")),
			fetch: (input, init) => {
				const url = String(input);
				if (url.endsWith("/models")) requestedUrl = url;
				return loginFetchMock()(input, init);
			},
		});

		expect(requestedUrl).toBe("https://token-plan.example.com/v1/models");
		expect(JSON.parse(credential)).toEqual({
			token: "sk-sp-custom",
			baseUrl: "https://token-plan.example.com/v1",
			oauth: {
				clientId: expect.any(String),
				accessToken: "qc-access",
				refreshToken: "qc-refresh",
				expiresAt: OAUTH_EXPIRY,
				aliyunId: "damian-aliyun",
				email: "damian@example.com",
			},
		});
	});

	test("stores an optional console Cookie on China logins while sending only the API key to inference", async () => {
		const prompts = ["2", "sk-sp-beijing", "session_id=test; login_aliyunid_csrf=csrf-token"];
		const credential = await loginAlibabaTokenPlan({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: loginFetchMock(),
		});

		expect(JSON.parse(credential)).toEqual({
			token: "sk-sp-beijing",
			cookie: "session_id=test; login_aliyunid_csrf=csrf-token",
			baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		});

		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.8-max");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");
		const setup = resolveOpenAIRequestSetup(model, { apiKey: credential, messages: [] });
		expect(setup.headers.Authorization).toBe("Bearer sk-sp-beijing");
	});

	test("rejects a single cookie value with actionable guidance", async () => {
		const prompts = ["2", "sk-sp-beijing", "5123456789012345"];
		await expect(
			loginAlibabaTokenPlan({
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
				fetch: loginFetchMock(),
			}),
		).rejects.toThrow("bailian-cs.console.aliyun.com usage request");
	});

	test("rejects the login when the QwenCloud device code expires before approval", async () => {
		const fetchMock: FetchImpl = input => {
			const url = String(input);
			if (url.includes("/cli/device/code")) {
				return Promise.resolve(
					Response.json({
						Success: true,
						Data: {
							Token: "device-token",
							VerificationUrl: "https://t.qwencloud.com/verify",
							ExpiresIn: 600,
							Interval: 1,
						},
					}),
				);
			}
			if (url.includes("/cli/device/token")) {
				return Promise.resolve(Response.json({ Success: true, Data: { Status: "expired_token" } }));
			}
			return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus" }] }));
		};
		const prompts = ["1", "sk-sp-test"];

		await expect(
			loginAlibabaTokenPlan({
				onAuth: () => {},
				onPrompt: async prompt => (prompt.allowEmpty ? "" : (prompts.shift() ?? "")),
				fetch: fetchMock,
			}),
		).rejects.toThrow("device code expired");
	});

	test("rejects malformed compound credentials before inference setup", () => {
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");

		for (const apiKey of [
			'  {"token":"sk-sp-test","cookie":"session=secret"',
			'"token":"sk-sp-test","cookie":"session=secret"}',
		]) {
			expect(() => resolveOpenAIRequestSetup(model, { apiKey, messages: [] })).toThrow(
				"Invalid QwenCloud Token Plan credential",
			);
		}
	});

	test("never falls back to the generic OPENAI_API_KEY as the QwenCloud bearer", () => {
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");

		const previous = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "sk-generic-openai-secret";
		try {
			expect(() => resolveOpenAIRequestSetup(model, { messages: [] })).toThrow(
				"No API key for provider: alibaba-token-plan",
			);
		} finally {
			if (previous === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previous;
		}
	});

	test("registers Token Plan separately from the legacy Alibaba Coding Plan", () => {
		const providers = getOAuthProviders();
		expect(providers.find(provider => provider.id === "alibaba-token-plan")).toMatchObject({
			name: "QwenCloud Token Plan",
			available: true,
		});
		expect(providers.some(provider => provider.id === "alibaba-coding-plan")).toBe(true);
	});
});
