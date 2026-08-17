import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import {
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	type AlibabaTokenPlanOAuth,
	parseAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";
import { DAY_MS, parsePositiveTimestamp, WEEK_MS } from "./shared";

const PROVIDER = "alibaba-token-plan";
const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/**
 * Official QwenCloud management gateway — the same `data/v2/api.json` surface
 * the first-party `qwencloud-cli` posts flat BSS calls to, authenticated with
 * the device-flow bearer token captured at login. Preferred quota source
 * whenever the credential carries an OAuth grant.
 */
const QWENCLOUD_API_ENDPOINT = "https://cli.qwencloud.com/data/v2/api.json";
const QWENCLOUD_REGION = "ap-southeast-1";
const BSS_PRODUCT = "BssOpenAPI-V3";
/** Token Plan commodity codes on the international product (qwencloud-cli `site.ts`). */
const COMMODITY_CODES = {
	teams: "sfm_tokenplanteams_dp_intl",
	personal: "sfm_tokenplanpersonal_dp_intl",
	addon: "sfm_tokenplanteamsaddon_dp_intl",
} as const;
/** Approximate month length for `windowDefaults` only; real resets come from `EndTime`. */
const APPROXIMATE_MONTH_MS = 30 * DAY_MS;

const INTERNATIONAL_CONSOLE = {
	origin: "https://home.qwencloud.com",
	dashboardUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
	sessionUrl: "https://home.qwencloud.com/tool/user/info.json",
	gatewayAction: "IntlBroadScopeAspnGateway",
	region: "ap-southeast-1",
	usageUrl: `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=${encodeURIComponent(USAGE_API)}`,
	cornerstoneParam: {
		domain: "home.qwencloud.com",
		consoleSite: "QWENCLOUD",
		console: "ONE_CONSOLE",
		xsp_lang: "en-US",
		protocol: "V2",
		productCode: "p_efm",
	},
} as const;
const CHINA_CONSOLE = {
	origin: "https://bailian.console.aliyun.com",
	dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	sessionUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	gatewayAction: "BroadScopeAspnGateway",
	region: "cn-beijing",
	usageUrl: `https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(USAGE_API)}`,
	cornerstoneParam: {
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
} as const;

function extractCookieValue(header: string, name: string): string | undefined {
	for (const segment of header.split(";")) {
		const separator = segment.indexOf("=");
		if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
		const value = segment.slice(separator + 1).trim();
		return value || undefined;
	}
	return undefined;
}

function unwrapGatewayData(value: Record<string, unknown>): Record<string, unknown> {
	let current = value;
	if (typeof current.Data === "string") {
		try {
			const parsed: unknown = JSON.parse(current.Data);
			if (isRecord(parsed)) current = parsed;
		} catch {
			return current;
		}
	}
	if (isRecord(current.DataV2) && isRecord(current.DataV2.data)) current = current.DataV2.data;
	if (isRecord(current.data)) current = current.data;
	return current;
}

function parseUsedFraction(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || parsed < 0) return undefined;
	return Math.min(1, parsed > 1 ? parsed / 100 : parsed);
}

function usageStatus(usedFraction: number): UsageLimit["status"] {
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.8) return "warning";
	return "ok";
}

function accountIdFromUserData(value: Record<string, unknown>): string | undefined {
	for (const key of ["accountId", "userId", "aliyunId", "loginId"]) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
	}
	return undefined;
}

function buildConsoleLimit(
	id: "7d" | "monthly",
	label: string,
	durationMs: number | undefined,
	usedFraction: number | undefined,
	resetsAt: number | undefined,
	accountId: string | undefined,
): UsageLimit | undefined {
	if (usedFraction === undefined) return undefined;
	return {
		id: `credits:${id}`,
		label,
		scope: { provider: PROVIDER, ...(accountId ? { accountId } : {}), windowId: id },
		window: { id, label, ...(durationMs ? { durationMs } : {}), ...(resetsAt ? { resetsAt } : {}) },
		amount: { used: usedFraction * 100, usedFraction, unit: "percent" },
		status: usageStatus(usedFraction),
	};
}

/**
 * Build a credits window limit from absolute subscription capacity. Personal
 * plans carry a 7-day window, Team seats a monthly one; both report
 * `InitCapacityBaseValue` as the window total and `CurrCapacityBaseValue` as
 * the live remaining balance, so consumption falls out as total − remaining.
 */
function buildCreditsWindowLimit(args: {
	id: "7d" | "monthly";
	windowLabel: string;
	durationMs?: number;
	total: number;
	remaining: number;
	resetsAt?: number;
	accountId?: string;
}): UsageLimit | undefined {
	if (!(args.total > 0)) return undefined;
	const used = Math.max(0, args.total - args.remaining);
	const usedFraction = Math.min(1, used / args.total);
	return {
		id: `credits:${args.id}`,
		label: `${args.windowLabel} Credits`,
		scope: { provider: PROVIDER, ...(args.accountId ? { accountId: args.accountId } : {}), windowId: args.id },
		window: {
			id: args.id,
			label: args.windowLabel,
			...(args.durationMs ? { durationMs: args.durationMs } : {}),
			...(args.resetsAt ? { resetsAt: args.resetsAt } : {}),
		},
		amount: {
			used,
			limit: args.total,
			remaining: args.remaining,
			usedFraction,
			remainingFraction: 1 - usedFraction,
			unit: "unknown",
		},
		status: usageStatus(usedFraction),
	};
}

/** Credit Packs are add-on capacity outside every subscription window. */
function buildCreditPacksLimit(remaining: number, accountId: string | undefined): UsageLimit | undefined {
	if (!(remaining > 0)) return undefined;
	return {
		id: "credits:packs",
		label: "Credit Packs",
		scope: { provider: PROVIDER, ...(accountId ? { accountId } : {}) },
		amount: { remaining, unit: "unknown" },
		status: "ok",
		notes: ["Add-on capacity that draws down outside the subscription window"],
	};
}

interface BssCallArgs {
	action: string;
	params: Record<string, unknown>;
	accessToken: string;
	ctx: UsageFetchContext;
	signal: AbortSignal | undefined;
}

/**
 * POST one flat-parameter BSS call through the official QwenCloud gateway and
 * unwrap the `{ code, data }` envelope. Returns null (with a warn log) on any
 * transport or envelope failure so callers can degrade per-API.
 */
async function callBssApi(args: BssCallArgs): Promise<Record<string, unknown> | null> {
	const flattened: Record<string, string> = {};
	for (const [key, value] of Object.entries(args.params)) {
		flattened[key] =
			typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value);
	}
	try {
		const response = await args.ctx.fetch(QWENCLOUD_API_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				product: BSS_PRODUCT,
				action: args.action,
				region: QWENCLOUD_REGION,
				params: flattened,
			}),
			signal: args.signal,
		});
		if (!response.ok) {
			args.ctx.logger?.warn("QwenCloud gateway call failed", {
				provider: PROVIDER,
				action: args.action,
				status: response.status,
			});
			return null;
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload) || payload.code !== "200" || !isRecord(payload.data)) {
			args.ctx.logger?.warn("QwenCloud gateway envelope invalid", { provider: PROVIDER, action: args.action });
			return null;
		}
		return payload.data;
	} catch (error) {
		args.ctx.logger?.warn("QwenCloud gateway request failed", {
			provider: PROVIDER,
			action: args.action,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

/** `Status` arrives as `"valid"` or as `{ Code: "valid" }` depending on BSS version. */
function frInstanceStatusCode(item: Record<string, unknown>): string {
	const status = item.Status;
	if (typeof status === "object" && status !== null) {
		const code = (status as Record<string, unknown>).Code;
		return typeof code === "string" ? code.toLowerCase() : "";
	}
	return typeof status === "string" ? status.toLowerCase() : "";
}

async function fetchFrInstances(
	commodityCode: string,
	pageSize: number,
	args: Omit<BssCallArgs, "action" | "params">,
): Promise<Record<string, unknown>[]> {
	const data = await callBssApi({
		...args,
		action: "DescribeFrInstances",
		params: { Group: "tokenPlan", CommodityCode: commodityCode, PageNum: 1, PageSize: pageSize },
	});
	if (!Array.isArray(data?.Data)) return [];
	return data.Data.filter(item => isRecord(item));
}

/** Sum the remaining capacity of valid add-on (Credit Pack) instances. */
function creditPacksRemaining(instances: Record<string, unknown>[]): number {
	return instances
		.filter(item => frInstanceStatusCode(item) === "valid")
		.reduce((sum, item) => sum + (toNumber(item.CurrCapacityBaseValue) ?? 0), 0);
}

/**
 * Fetch Token Plan consumption through the official QwenCloud management API.
 *
 * Mirrors the first-party CLI: accounts migrated to seat-based subscriptions
 * (`QuerySubscriptionGray` → true) answer through `GetSeatSubscriptionSummary`
 * with a monthly window; everyone else reports per-commodity
 * `DescribeFrInstances`, where the personal commodity carries the 7-day credit
 * window and team seats the monthly one. Credit Packs are summed separately
 * because they are not window-limited. QwenCloud documents no 5-hour window
 * for Token Plan (personal = 7-day, team = monthly), so none is synthesized.
 */
async function fetchQwenCloudOAuthUsage(
	oauth: AlibabaTokenPlanOAuth,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (oauth.expiresAt !== undefined && oauth.expiresAt <= Date.now()) return null;
	const accountId = oauth.aliyunId ?? oauth.email;
	const callArgs = { accessToken: oauth.accessToken, ctx, signal: params.signal };

	const grayData = await callBssApi({ ...callArgs, action: "QuerySubscriptionGray", params: {} });
	if (!grayData) return null;
	const packsInstances = await fetchFrInstances(COMMODITY_CODES.addon, 100, callArgs);
	const packsRemaining = creditPacksRemaining(packsInstances);

	const limits: UsageLimit[] = [];
	let planName: string | undefined;
	if (grayData.IsGray === true) {
		const seatData = await callBssApi({
			...callArgs,
			action: "GetSeatSubscriptionSummary",
			params: { productCode: COMMODITY_CODES.teams },
		});
		if (!seatData) return null;
		// BSS sometimes nests the summary under a second Data envelope.
		const inner = isRecord(seatData.Data) ? seatData.Data : seatData;
		const groups = Array.isArray(inner.SubscriptionGroupList)
			? inner.SubscriptionGroupList.filter(item => isRecord(item))
			: [];
		let total = 0;
		let remaining = 0;
		for (const group of groups) {
			const equity =
				Array.isArray(group.EquityList) && isRecord(group.EquityList[0]) ? group.EquityList[0] : undefined;
			total += toNumber(equity?.TotalValue ?? group.TotalValue) ?? 0;
			remaining += toNumber(equity?.SurplusValue ?? group.SurplusValue) ?? 0;
		}
		if (typeof inner.PlanName === "string" && inner.PlanName) planName = inner.PlanName;
		const monthly = buildCreditsWindowLimit({
			id: "monthly",
			windowLabel: "Monthly",
			total,
			remaining,
			resetsAt: parsePositiveTimestamp(inner.EndTime),
			accountId,
		});
		if (monthly) limits.push(monthly);
	} else {
		const [teamsInstances, personalInstances] = await Promise.all([
			fetchFrInstances(COMMODITY_CODES.teams, 10, callArgs),
			fetchFrInstances(COMMODITY_CODES.personal, 10, callArgs),
		]);
		const candidates: { instance: Record<string, unknown>; monthly: boolean }[] = [
			...teamsInstances.map(instance => ({ instance, monthly: true })),
			...personalInstances.map(instance => ({ instance, monthly: false })),
		];
		const pick = candidates.find(({ instance }) => frInstanceStatusCode(instance) === "valid") ?? candidates[0];
		if (pick) {
			const { instance } = pick;
			const periodMonthlyShift = instance.CapacityTypeCode === "periodMonthlyShift";
			const total = toNumber(instance.InitCapacityBaseValue) ?? 0;
			const remaining = periodMonthlyShift
				? (toNumber(instance.periodCapacityBaseValue) ?? toNumber(instance.CurrCapacityBaseValue) ?? 0)
				: (toNumber(instance.CurrCapacityBaseValue) ?? 0);
			const templateName = typeof instance.TemplateName === "string" ? instance.TemplateName : undefined;
			const commodityName = typeof instance.CommodityName === "string" ? instance.CommodityName : undefined;
			planName = templateName ?? commodityName;
			const window = pick.monthly || periodMonthlyShift ? "monthly" : "7d";
			const limit = buildCreditsWindowLimit({
				id: window,
				windowLabel: window === "monthly" ? "Monthly" : "7 Day",
				...(window === "7d" ? { durationMs: WEEK_MS } : {}),
				total,
				remaining,
				resetsAt: parsePositiveTimestamp(instance.EndTime),
				accountId,
			});
			if (limit) limits.push(limit);
		}
	}
	const packs = buildCreditPacksLimit(packsRemaining, accountId);
	if (packs) limits.push(packs);
	if (limits.length === 0) return null;
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			source: "qwencloud-oauth",
			endpoint: QWENCLOUD_API_ENDPOINT,
			...(planName ? { planName } : {}),
			...(accountId ? { accountId } : {}),
		},
	};
}

/**
 * Legacy quota source: scrape the QwenCloud / Bailian console data gateway
 * with the browser Cookie header stored at login. Retained for China (Beijing)
 * credentials — the QwenCloud OAuth product does not exist there — and as a
 * transitional fallback while pre-OAuth credentials are re-logged-in.
 */
async function fetchConsoleUsage(
	cookie: string,
	isChina: boolean,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	const consoleConfig = isChina ? CHINA_CONSOLE : INTERNATIONAL_CONSOLE;

	try {
		const sessionResponse = await ctx.fetch(consoleConfig.sessionUrl, {
			headers: {
				Accept: isChina
					? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
					: "application/json, text/plain, */*",
				Cookie: cookie,
				Referer: `${consoleConfig.origin}/`,
				"User-Agent": BROWSER_USER_AGENT,
			},
			redirect: "manual",
			signal: params.signal,
		});
		if (!sessionResponse.ok) {
			ctx.logger?.warn("Alibaba Token Plan session lookup failed", {
				provider: PROVIDER,
				status: sessionResponse.status,
			});
			return null;
		}

		let secToken: string | undefined;
		let accountId: string | undefined;
		if (isChina) {
			const html = await sessionResponse.text();
			secToken = /\bSEC_TOKEN\s*:\s*"([^"]+)"/.exec(html)?.[1];
			if (!secToken) {
				ctx.logger?.warn("Alibaba Token Plan China session response invalid", { provider: PROVIDER });
				return null;
			}
		} else {
			const userPayload: unknown = await sessionResponse.json();
			if (!isRecord(userPayload) || !isRecord(userPayload.data) || typeof userPayload.data.secToken !== "string") {
				ctx.logger?.warn("QwenCloud session response invalid", { provider: PROVIDER });
				return null;
			}
			secToken = userPayload.data.secToken;
			accountId = accountIdFromUserData(userPayload.data);
		}

		const csrf = extractCookieValue(cookie, "login_aliyunid_csrf") ?? extractCookieValue(cookie, "csrf");
		const headers: Record<string, string> = {
			Accept: "application/json, text/plain, */*",
			"Content-Type": "application/x-www-form-urlencoded",
			Cookie: cookie,
			Origin: consoleConfig.origin,
			Referer: consoleConfig.dashboardUrl,
			"User-Agent": BROWSER_USER_AGENT,
			"X-Requested-With": "XMLHttpRequest",
		};
		if (csrf) {
			headers["x-xsrf-token"] = csrf;
			headers["x-csrf-token"] = csrf;
		}
		const body = new URLSearchParams({
			product: "sfm_bailian",
			action: consoleConfig.gatewayAction,
			region: consoleConfig.region,
			sec_token: secToken,
			params: JSON.stringify({
				Api: USAGE_API,
				Data: {
					cornerstoneParam: {
						...(isChina ? { feTraceId: crypto.randomUUID() } : {}),
						...consoleConfig.cornerstoneParam,
					},
				},
				V: "1.0",
			}),
		});
		const usageResponse = await ctx.fetch(consoleConfig.usageUrl, {
			method: "POST",
			headers,
			body,
			redirect: "manual",
			signal: params.signal,
		});
		if (!usageResponse.ok) {
			ctx.logger?.warn("Alibaba Token Plan usage fetch failed", {
				provider: PROVIDER,
				status: usageResponse.status,
			});
			return null;
		}
		const payload: unknown = await usageResponse.json();
		if (!isRecord(payload) || payload.successResponse === false || !isRecord(payload.data)) {
			ctx.logger?.warn("Alibaba Token Plan usage response invalid", { provider: PROVIDER });
			return null;
		}
		const responseData = unwrapGatewayData(payload.data);
		const limits = [
			// Only the 7-day window is real for Token Plan; the gateway also
			// returns a per5Hour percentage, but no QwenCloud plan documents a
			// 5-hour limit (personal is 7-day, team monthly), so it is ignored.
			buildConsoleLimit(
				"7d",
				"7 Day Credits",
				WEEK_MS,
				parseUsedFraction(responseData.per1WeekPercentage),
				parsePositiveTimestamp(responseData.per1WeekResetTime),
				accountId,
			),
		].filter((limit): limit is UsageLimit => limit !== undefined);
		if (limits.length === 0) return null;
		return {
			provider: PROVIDER,
			fetchedAt: Date.now(),
			limits,
			metadata: { source: isChina ? "bailian-console" : "qwencloud-console", ...(accountId ? { accountId } : {}) },
		};
	} catch (error) {
		ctx.logger?.warn("Alibaba Token Plan usage request failed", {
			provider: PROVIDER,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

async function fetchAlibabaTokenPlanUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER || params.credential.type !== "api_key" || !params.credential.apiKey) return null;
	const credential = parseAlibabaTokenPlanCredential(params.credential.apiKey);
	if (!credential) return null;

	if (credential.oauth && (credential.oauth.expiresAt === undefined || credential.oauth.expiresAt > Date.now())) {
		const report = await fetchQwenCloudOAuthUsage(credential.oauth, params, ctx);
		if (report) return report;
		// A healthy OAuth grant that the gateway just refused should not be
		// masked by an older console session, but a transitional credential
		// carrying both deserves whatever the cookie can still produce.
		if (!credential.cookie) return null;
		ctx.logger?.warn("QwenCloud OAuth usage unavailable; falling back to the console session", {
			provider: PROVIDER,
		});
	}
	if (!credential.cookie) return null;
	return fetchConsoleUsage(credential.cookie, credential.baseUrl === ALIBABA_TOKEN_PLAN_CN_BASE_URL, params, ctx);
}

export const alibabaTokenPlanUsageProvider: UsageProvider = {
	id: PROVIDER,
	retainLastGoodOnFailure: false,
	fetchUsage: fetchAlibabaTokenPlanUsage,
	supports: params => {
		if (params.provider !== PROVIDER || params.credential.type !== "api_key" || !params.credential.apiKey) {
			return false;
		}
		const credential = parseAlibabaTokenPlanCredential(params.credential.apiKey);
		return Boolean(credential?.oauth ?? credential?.cookie);
	},
};

export const alibabaTokenPlanRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits: report => {
		const primary =
			report.limits.find(limit => limit.id === "credits:7d") ??
			report.limits.find(limit => limit.id === "credits:monthly");
		// The secondary limit must be a different constraint than the primary:
		// personal plans fall 7d → monthly (a team seat held alongside) → packs,
		// team-only accounts already burn monthly as primary so packs is next.
		const secondary =
			primary?.id === "credits:monthly"
				? report.limits.find(limit => limit.id === "credits:packs")
				: (report.limits.find(limit => limit.id === "credits:monthly") ??
					report.limits.find(limit => limit.id === "credits:packs"));
		return { primary, secondary };
	},
	windowDefaults: {
		primaryMs: WEEK_MS,
		secondaryMs: APPROXIMATE_MONTH_MS,
	},
};
