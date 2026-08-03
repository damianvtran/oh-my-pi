/**
 * Argument parsing and operator-facing copy for `/credential`.
 *
 * Kept out of the registry entry so the decision logic is testable without a
 * TUI: the registry handler only supplies the masked prompt and the vault, and
 * everything that decides *what happened* lives here.
 */
import { normalizeCredentialKey, type SessionCredential } from "../../secrets/session-credentials";

/**
 * What `/credential <args>` asked for.
 *
 * Verbs are flag-shaped (`--forget`) rather than bare words so they can never
 * collide with a credential key: keys normalize to `[A-Z0-9_]`, which cannot
 * begin with `-`.
 */
export type CredentialCommand =
	| { action: "list" }
	| { action: "store"; key: string }
	| { action: "forget"; key: string }
	| { action: "forget-all" }
	| { action: "error"; message: string };

export const CREDENTIAL_USAGE =
	"Usage: /credential <KEY> | /credential | /credential --forget <KEY> | /credential --forget-all";

export function parseCredentialCommand(args: string): CredentialCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { action: "list" };

	if (trimmed === "--forget-all") return { action: "forget-all" };

	if (trimmed.startsWith("--forget")) {
		const rest = trimmed.slice("--forget".length).trim();
		if (rest.length === 0) return { action: "error", message: `Missing key. ${CREDENTIAL_USAGE}` };
		const key = normalizeCredentialKey(rest);
		if (key === undefined) return { action: "error", message: `Not a usable credential key: ${rest}` };
		return { action: "forget", key };
	}

	if (trimmed.startsWith("-")) {
		return { action: "error", message: `Unknown option: ${trimmed.split(/\s+/)[0]}. ${CREDENTIAL_USAGE}` };
	}

	const key = normalizeCredentialKey(trimmed);
	if (key === undefined) return { action: "error", message: `Not a usable credential key: ${trimmed}` };
	return { action: "store", key };
}

export function formatCredentialList(credentials: readonly SessionCredential[]): string {
	if (credentials.length === 0) {
		return `No credentials stored for this session. ${CREDENTIAL_USAGE}`;
	}
	const width = Math.max(...credentials.map(credential => credential.key.length));
	const rows = credentials.map(credential => `  ${credential.key.padEnd(width)}  ${credential.placeholder}`);
	return [
		`Session credentials (${credentials.length}) — held in memory for this session only:`,
		...rows,
		"The agent sees only the placeholder and can pass it to a tool; it can never read the value.",
	].join("\n");
}

/**
 * Both forget messages restate the redaction caveat. It is the one part of the
 * model that surprises people: revoking the handle stops the agent referencing
 * the credential, but the obfuscator keeps hiding those bytes for the rest of
 * the session (un-hiding them would be a downgrade, not a cleanup).
 */
export function formatCredentialForget(removed: boolean, key: string): string {
	return removed
		? `Forgot ${key}. The agent can no longer reference it; the value stays redacted for the rest of this session.`
		: `No credential named ${key}.`;
}

export function formatCredentialForgetAll(count: number): string {
	if (count === 0) return "No credentials stored for this session.";
	return `Forgot ${count} credential${count === 1 ? "" : "s"}. Their values stay redacted for the rest of this session.`;
}

/** Shown when a session was built without a vault (embedded SDK callers). */
export const CREDENTIAL_UNAVAILABLE = "Credential storage is not available in this session.";
