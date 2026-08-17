/**
 * International (Singapore) Token Plan endpoint. Default region; keys issued by
 * the international product authenticate only here.
 */
export const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
/**
 * China (Beijing) Token Plan endpoint (百炼 Token Plan). Keys are region-locked:
 * a Beijing-issued key is rejected by the international endpoint with
 * `invalid_api_key`, and vice versa (#6682).
 */
export const ALIBABA_TOKEN_PLAN_CN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

export interface AlibabaTokenPlanOAuth {
	/**
	 * Device-flow client id. QwenCloud accepts any stable identifier (the
	 * official CLI persists a random UUID per machine); ours is minted per
	 * login and stored so a future token refresh can reuse the same client.
	 */
	clientId: string;
	/** Management-API bearer token (scopes include `usage:read`). */
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires (QwenCloud `ExpireTime`). */
	expiresAt?: number;
	aliyunId?: string;
	email?: string;
}

export interface AlibabaTokenPlanCredential {
	token: string;
	cookie?: string;
	/**
	 * Region base URL the key authenticates against. Absent means the default
	 * international endpoint ({@link ALIBABA_TOKEN_PLAN_BASE_URL}).
	 */
	baseUrl?: string;
	/**
	 * QwenCloud management-OAuth grant captured at login via the device flow
	 * at t.qwencloud.com. Powers quota reporting through the official
	 * cli.qwencloud.com gateway. Absent on China (Beijing) credentials, where
	 * the QwenCloud OAuth product does not exist and the console-cookie
	 * fallback remains the only quota source.
	 */
	oauth?: AlibabaTokenPlanOAuth;
}

const TOKEN_PATTERN = /^sk-[A-Za-z0-9._~+/-]+={0,2}$/;

export function parseAlibabaTokenPlanCredential(value: string): AlibabaTokenPlanCredential | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("{")) return TOKEN_PATTERN.test(trimmed) ? { token: trimmed } : null;
	try {
		const parsed = JSON.parse(trimmed) as {
			token?: unknown;
			cookie?: unknown;
			baseUrl?: unknown;
			oauth?: unknown;
		};
		if (typeof parsed.token !== "string" || !TOKEN_PATTERN.test(parsed.token.trim())) return null;
		if (parsed.cookie !== undefined && typeof parsed.cookie !== "string") return null;
		if (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string") return null;
		const oauth = parseAlibabaTokenPlanOAuth(parsed.oauth);
		if (oauth === null) return null;
		const token = parsed.token.trim();
		const cookie = parsed.cookie?.trim();
		const baseUrl = parsed.baseUrl?.trim();
		const credential: AlibabaTokenPlanCredential = { token };
		if (cookie) credential.cookie = cookie;
		if (baseUrl) credential.baseUrl = baseUrl;
		if (oauth) credential.oauth = oauth;
		return credential;
	} catch {
		return null;
	}
}

/**
 * Validate the embedded OAuth grant. `undefined` means the credential predates
 * OAuth login (cookie-only); `null` means an `oauth` key exists but is
 * malformed, which must poison the whole credential rather than silently
 * degrade quota reporting to the console scrape.
 */
function parseAlibabaTokenPlanOAuth(value: unknown): AlibabaTokenPlanOAuth | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
	const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim() : "";
	if (!clientId || !accessToken) return null;
	if (
		raw.expiresAt !== undefined &&
		(typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0)
	) {
		return null;
	}
	const oauth: AlibabaTokenPlanOAuth = { clientId, accessToken };
	const refreshToken = typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : "";
	if (refreshToken) oauth.refreshToken = refreshToken;
	if (typeof raw.expiresAt === "number") oauth.expiresAt = raw.expiresAt;
	const aliyunId = typeof raw.aliyunId === "string" ? raw.aliyunId.trim() : "";
	if (aliyunId) oauth.aliyunId = aliyunId;
	const email = typeof raw.email === "string" ? raw.email.trim() : "";
	if (email) oauth.email = email;
	return oauth;
}

export function serializeAlibabaTokenPlanCredential(
	token: string,
	cookie: string,
	baseUrl?: string,
	oauth?: AlibabaTokenPlanOAuth,
): string {
	const trimmedCookie = cookie.trim();
	const trimmedBaseUrl = baseUrl?.trim();
	if (!trimmedCookie && !trimmedBaseUrl && !oauth) return token;
	const payload: { token: string; cookie?: string; baseUrl?: string; oauth?: AlibabaTokenPlanOAuth } = {
		token,
	};
	if (trimmedCookie) payload.cookie = trimmedCookie;
	if (trimmedBaseUrl) payload.baseUrl = trimmedBaseUrl;
	if (oauth) payload.oauth = oauth;
	return JSON.stringify(payload);
}
