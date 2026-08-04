import type { OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	/**
	 * Row id the session is actually pinned to. Replaces the old provider-wide
	 * `activeApiKey` boolean, which marked EVERY api-key row active and so told
	 * the user nothing about which of several keys a logout would unseat.
	 */
	activeCredentialId?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The secret a stored API key is recognisable by.
 *
 * Some providers persist a JSON envelope rather than the bare key (QwenCloud
 * Token Plan carries the region alongside it), and masking the envelope would
 * show the user `{"tok…l"}`. Unwrap a `token` member when the value is one of
 * those; anything else is already the key.
 */
function displaySecret(key: string): string {
	const trimmed = key.trim();
	if (!trimmed.startsWith("{")) return trimmed;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null && "token" in parsed) {
			const token = (parsed as { token: unknown }).token;
			if (typeof token === "string" && token.trim()) return token.trim();
		}
	} catch {
		// Not JSON after all — fall through and mask the raw value.
	}
	return trimmed;
}

/**
 * Mask a secret to a recognisable-but-safe form: keep the provider prefix
 * (`sk-sp-`, `sk-ant-`, …) and the last four characters, which is what lets a
 * user tell two keys apart without the value ever being readable.
 */
function maskSecret(secret: string): string {
	const prefixMatch = /^([A-Za-z]{2,6}(?:-[A-Za-z]{2,6}){0,2}-)/.exec(secret);
	const prefix = prefixMatch?.[1] ?? "";
	const rest = secret.slice(prefix.length);
	if (rest.length <= 4) return `${prefix}${"…".repeat(rest.length > 0 ? 1 : 0)}`;
	return `${prefix}…${rest.slice(-4)}`;
}

/** Region/base URL a JSON-enveloped API key pins itself to, when it has one. */
function apiKeyBaseUrl(key: string): string | undefined {
	const trimmed = key.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null && "baseUrl" in parsed) {
			const baseUrl = (parsed as { baseUrl: unknown }).baseUrl;
			if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
		}
	} catch {
		// Not JSON — no region to report.
	}
	return undefined;
}

function credentialLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return maskSecret(displaySecret(credential.key));
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function credentialDetail(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") {
		const parts = [`api key #${row.id}`];
		// A region-scoped credential (QwenCloud Beijing, a custom endpoint) is
		// otherwise indistinguishable from an international one at the same
		// masked suffix, and they are not interchangeable.
		const baseUrl = apiKeyBaseUrl(credential.key);
		if (baseUrl) parts.push(baseUrl);
		if (credential.source) parts.push(credential.source);
		return parts.join(" · ");
	}
	const label = credentialLabel(row);
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	row: StoredAuthCredential,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity || row.credential.type !== "oauth") return false;
	const credential = row.credential;
	// The org GATES the base identity rather than replacing it: mismatched org
	// presence or different orgs never match — an org-scoped active session
	// must not preselect the bare-email legacy row, and a bare-email active
	// row must not mark org-scoped siblings active via the shared email. A
	// SHARED org still requires the base-identity match below: two Team seats
	// share one orgId yet own distinct rows. Only an org-only active identity
	// (no base identifiers recovered at all) matches on the org alone.
	if (activeIdentity.orgId !== undefined || credential.orgId !== undefined) {
		if (credential.orgId !== activeIdentity.orgId) return false;
		if (
			activeIdentity.accountId === undefined &&
			activeIdentity.email === undefined &&
			activeIdentity.projectId === undefined
		) {
			return true;
		}
	}
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.email !== undefined && credential.email === activeIdentity.email) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

export function toLogoutAccounts(
	provider: string,
	credentials: StoredAuthCredential[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			// The row id is authoritative when the caller knows it; the OAuth
			// identity match stays as the fallback for callers that only have an
			// identity (and for rows whose id predates the pinned selection).
			const active =
				options.activeCredentialId !== undefined
					? row.id === options.activeCredentialId
					: row.credential.type === "oauth" && oauthMatchesActiveIdentity(row, options.activeIdentity);
			return {
				credentialId: row.id,
				provider,
				label: credentialLabel(row),
				detail: credentialDetail(row),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}
