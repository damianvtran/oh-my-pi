import { describe, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import {
	alibabaTokenPlanRankingStrategy,
	alibabaTokenPlanUsageProvider,
} from "@oh-my-pi/pi-ai/usage/alibaba-token-plan";
import {
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	type AlibabaTokenPlanOAuth,
	serializeAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

function params(apiKey: string): UsageFetchParams {
	return {
		provider: "alibaba-token-plan",
		credential: { type: "api_key", apiKey },
		accountKey: "account-1",
	};
}

const FUTURE_EXPIRY = Date.now() + 3_600_000;

function oauthGrant(overrides: Partial<AlibabaTokenPlanOAuth> = {}): AlibabaTokenPlanOAuth {
	return {
		clientId: "client-1",
		accessToken: "qc-access",
		expiresAt: FUTURE_EXPIRY,
		aliyunId: "damian-aliyun",
		...overrides,
	};
}

/** Route official-gateway posts by their `action`, mirroring BSS responses. */
function qwenCloudGatewayMock(
	handlers: Record<string, () => Record<string, unknown>>,
	requests?: { url: string; init?: RequestInit }[],
): FetchImpl {
	return (input, init) => {
		requests?.push({ url: String(input), init });
		const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
		const handler = handlers[body.action ?? ""];
		if (!handler) return Promise.resolve(Response.json({ code: "200", data: {} }));
		return Promise.resolve(Response.json({ code: "200", data: handler() }));
	};
}

describe("QwenCloud Token Plan opt-in usage", () => {
	test("fetches quota windows with the Cookie stored during login", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			if (requests.length === 1) {
				return Promise.resolve(
					Response.json({ code: "200", data: { secToken: "sec-token", accountId: "account-1" } }),
				);
			}
			return Promise.resolve(
				Response.json({
					data: {
						DataV2: {
							data: {
								data: {
									per5HourPercentage: 0.25,
									per5HourResetTime: 1_800_000_000_000,
									per1WeekPercentage: 0.5,
									per1WeekResetTime: 1_800_100_000_000,
								},
							},
						},
					},
				}),
			);
		};
		const cookie = "session_id=test; login_aliyunid_csrf=csrf-token; locale=en-US";
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", cookie);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://home.qwencloud.com/tool/user/info.json");
		expect(new Headers(requests[0]?.init?.headers).get("Cookie")).toBe(cookie);
		expect(requests[0]?.init?.redirect).toBe("manual");
		expect(requests[1]?.url).toBe(
			"https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
		);
		const usageHeaders = new Headers(requests[1]?.init?.headers);
		expect(usageHeaders.get("Cookie")).toBe(cookie);
		expect(usageHeaders.get("Origin")).toBe("https://home.qwencloud.com");
		expect(usageHeaders.get("Referer")).toBe("https://home.qwencloud.com/billing/subscription/token-plan-individual");
		expect(usageHeaders.get("X-Requested-With")).toBe("XMLHttpRequest");
		expect(usageHeaders.get("x-xsrf-token")).toBe("csrf-token");
		expect(usageHeaders.get("x-csrf-token")).toBe("csrf-token");
		expect(requests[1]?.init?.redirect).toBe("manual");
		const body = new URLSearchParams(String(requests[1]?.init?.body));
		expect(body.get("sec_token")).toBe("sec-token");
		expect(body.get("params")).toBe(
			JSON.stringify({
				Api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
				Data: {
					cornerstoneParam: {
						domain: "home.qwencloud.com",
						consoleSite: "QWENCLOUD",
						console: "ONE_CONSOLE",
						xsp_lang: "en-US",
						protocol: "V2",
						productCode: "p_efm",
					},
				},
				V: "1.0",
			}),
		);
		// The console gateway also reports a per5Hour percentage, but no
		// QwenCloud plan documents a 5-hour Token Plan window, so only the
		// 7-day limit is surfaced.
		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			metadata: { source: "qwencloud-console", accountId: "account-1" },
			limits: [
				{
					id: "credits:7d",
					window: { id: "7d", durationMs: 604_800_000, resetsAt: 1_800_100_000_000 },
					amount: { used: 50, usedFraction: 0.5, unit: "percent" },
				},
			],
		});
		expect(report?.limits).toHaveLength(1);
		if (!report) throw new Error("expected QwenCloud usage report");
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report, { modelId: "qwen3.8-max" });
		expect(windows.primary?.id).toBe("credits:7d");
		expect(windows.secondary).toBeUndefined();
	});

	test("fetches China quota through the Beijing console gateway", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			if (requests.length === 1) {
				return Promise.resolve(
					new Response('<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "cn-sec-token" };</script>'),
				);
			}
			return Promise.resolve(
				Response.json({
					code: "200",
					data: {
						DataV2: {
							data: {
								data: {
									per1WeekPercentage: 0.7913113,
									per1WeekResetTime: 1_786_716_480_000,
								},
							},
						},
					},
					successResponse: true,
				}),
			);
		};
		const cookie = "login_aliyunid_csrf=cn-csrf; aliyun_lang=zh";
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-beijing", cookie, ALIBABA_TOKEN_PLAN_CN_BASE_URL);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://bailian.console.aliyun.com/cn-beijing?tab=plan");
		expect(new Headers(requests[0]?.init?.headers).get("Cookie")).toBe(cookie);
		expect(requests[1]?.url).toBe(
			"https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
		);
		const usageHeaders = new Headers(requests[1]?.init?.headers);
		expect(usageHeaders.get("Origin")).toBe("https://bailian.console.aliyun.com");
		expect(usageHeaders.get("Referer")).toBe("https://bailian.console.aliyun.com/cn-beijing?tab=plan");
		const body = new URLSearchParams(String(requests[1]?.init?.body));
		expect(body.get("action")).toBe("BroadScopeAspnGateway");
		expect(body.get("region")).toBe("cn-beijing");
		expect(body.get("sec_token")).toBe("cn-sec-token");
		const gatewayParams: unknown = JSON.parse(body.get("params") ?? "null");
		expect(gatewayParams).toMatchObject({
			Api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
			Data: {
				cornerstoneParam: {
					feTraceId: expect.any(String),
					feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
					protocol: "V2",
					console: "ONE_CONSOLE",
					productCode: "p_efm",
					switchAgent: 12608464,
					switchUserType: 3,
					domain: "bailian.console.aliyun.com",
					consoleSite: "BAILIAN_ALIYUN",
					userNickName: "",
					userPrincipalName: "",
					xsp_lang: "zh-CN",
				},
			},
			V: "1.0",
		});
		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			limits: [
				{
					id: "credits:7d",
					window: { id: "7d", durationMs: 604_800_000, resetsAt: 1_786_716_480_000 },
					amount: { usedFraction: 0.7913113, unit: "percent" },
				},
			],
		});
		expect(report?.limits).toHaveLength(1);
	});

	test("fetches personal-plan consumption through the official QwenCloud OAuth API", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock = qwenCloudGatewayMock(
			{
				QuerySubscriptionGray: () => ({ IsGray: false }),
				DescribeFrInstances: () => {
					const body = requests[requests.length - 1]?.init?.body;
					const commodity = (JSON.parse(String(body)) as { params: { CommodityCode?: string } }).params
						?.CommodityCode;
					if (commodity === "sfm_tokenplanpersonal_dp_intl") {
						return {
							Data: [
								{
									Status: { Code: "valid" },
									InitCapacityBaseValue: 10_000,
									CurrCapacityBaseValue: 2_500,
									EndTime: 1_800_100_000_000,
									TemplateName: "Token Plan Individual Standard",
								},
							],
						};
					}
					if (commodity === "sfm_tokenplanteamsaddon_dp_intl") {
						return {
							Data: [{ Status: "valid", CurrCapacityBaseValue: 20_000 }],
						};
					}
					return { Data: [] };
				},
			},
			requests,
		);
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "", undefined, oauthGrant());

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		// gray probe + addon packs + (teams ∥ personal) instance queries
		expect(requests).toHaveLength(4);
		for (const request of requests) {
			expect(request.url).toBe("https://cli.qwencloud.com/data/v2/api.json");
			expect(new Headers(request.init?.headers).get("Authorization")).toBe("Bearer qc-access");
			expect(new Headers(request.init?.headers).get("Content-Type")).toBe("application/json");
		}
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			product: "BssOpenAPI-V3",
			action: "QuerySubscriptionGray",
			region: "ap-southeast-1",
			params: {},
		});
		const personalRequest = requests
			.map(request => JSON.parse(String(request.init?.body)) as { params: Record<string, string> })
			.find(body => body.params?.CommodityCode === "sfm_tokenplanpersonal_dp_intl");
		expect(personalRequest?.params).toEqual({
			Group: "tokenPlan",
			CommodityCode: "sfm_tokenplanpersonal_dp_intl",
			PageNum: "1",
			PageSize: "10",
		});

		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			metadata: {
				source: "qwencloud-oauth",
				planName: "Token Plan Individual Standard",
				accountId: "damian-aliyun",
			},
			limits: [
				{
					id: "credits:7d",
					label: "7 Day Credits",
					window: { id: "7d", durationMs: 604_800_000, resetsAt: 1_800_100_000_000 },
					amount: { used: 7_500, limit: 10_000, remaining: 2_500, usedFraction: 0.75, unit: "unknown" },
					status: "ok",
				},
				{
					id: "credits:packs",
					label: "Credit Packs",
					amount: { remaining: 20_000, unit: "unknown" },
				},
			],
		});
		if (!report) throw new Error("expected QwenCloud OAuth usage report");
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report, { modelId: "qwen3.8-max" });
		expect(windows.primary?.id).toBe("credits:7d");
		expect(windows.secondary?.id).toBe("credits:packs");
	});

	test("reports team seats on a monthly window through the seat-summary path", async () => {
		const fetchMock = qwenCloudGatewayMock({
			QuerySubscriptionGray: () => ({ IsGray: true }),
			GetSeatSubscriptionSummary: () => ({
				Data: {
					SubscriptionGroupList: [{ EquityList: [{ TotalValue: "25000", SurplusValue: "10000" }] }],
					EndTime: 1_800_200_000_000,
					PlanName: "Token Plan Team Pro",
				},
			}),
			DescribeFrInstances: () => ({ Data: [] }),
		});
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-team", "", undefined, oauthGrant());

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			metadata: { source: "qwencloud-oauth", planName: "Token Plan Team Pro" },
			limits: [
				{
					id: "credits:monthly",
					label: "Monthly Credits",
					window: { id: "monthly", resetsAt: 1_800_200_000_000 },
					amount: { used: 15_000, limit: 25_000, remaining: 10_000, usedFraction: 0.6, unit: "unknown" },
				},
			],
		});
		expect(report?.limits).toHaveLength(1);
		if (!report) throw new Error("expected QwenCloud OAuth usage report");
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe("credits:monthly");
		expect(windows.secondary).toBeUndefined();
	});

	test("falls back to the console session when the OAuth grant has expired", async () => {
		const requests: string[] = [];
		const fetchMock: FetchImpl = (input, _init) => {
			requests.push(String(input));
			if (requests.length === 1) {
				return Promise.resolve(Response.json({ data: { secToken: "sec-token" } }));
			}
			return Promise.resolve(
				Response.json({
					data: { DataV2: { data: { data: { per1WeekPercentage: 0.4, per1WeekResetTime: 1_800_100_000_000 } } } },
				}),
			);
		};
		const credential = serializeAlibabaTokenPlanCredential(
			"sk-sp-test",
			"session_id=test",
			undefined,
			oauthGrant({ expiresAt: Date.now() - 1_000 }),
		);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(requests).toEqual([
			"https://home.qwencloud.com/tool/user/info.json",
			"https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
		]);
		expect(report?.limits.map(limit => limit.id)).toEqual(["credits:7d"]);
	});

	test("does not claim quota support for API-key-only credentials", async () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({}));
		};
		const request = params("sk-sp-test");

		expect(alibabaTokenPlanUsageProvider.supports?.(request)).toBe(false);
		expect(await alibabaTokenPlanUsageProvider.fetchUsage(request, { fetch: fetchMock })).toBeNull();
		expect(fetched).toBe(false);
	});

	test("claims quota support for OAuth credentials without a console cookie", async () => {
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "", undefined, oauthGrant());
		expect(alibabaTokenPlanUsageProvider.supports?.(params(credential))).toBe(true);
	});

	test("skips an expired OAuth grant that has no cookie to fall back to", async () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({}));
		};
		const credential = serializeAlibabaTokenPlanCredential(
			"sk-sp-test",
			"",
			undefined,
			oauthGrant({ expiresAt: Date.now() - 1_000 }),
		);

		expect(await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock })).toBeNull();
		expect(fetched).toBe(false);
	});

	test("fails closed when the stored console session has expired", async () => {
		let requestCount = 0;
		const fetchMock: FetchImpl = () => {
			requestCount++;
			return Promise.resolve(
				requestCount === 1
					? Response.json({ code: "200", data: { secToken: "sec-token" } })
					: Response.json({ code: "ConsoleNeedLogin", message: "You need to log in.", successResponse: false }),
			);
		};
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=expired");

		expect(await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock })).toBeNull();
		expect(requestCount).toBe(2);
	});
});
