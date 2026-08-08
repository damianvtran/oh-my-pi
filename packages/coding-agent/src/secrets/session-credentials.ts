/**
 * Session-scoped credential vault.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some work needs a secret only the operator can produce: a short-lived API
 * token, a one-off deploy key, a password for a system the agent has no
 * standing access to. Pasting it into the chat is the obvious move and the
 * wrong one — a message is persisted verbatim to the session JSONL, replayed
 * into compaction, rendered into transcript exports, and shipped to the model
 * provider. This vault is the alternative: the operator hands the value to the
 * *process* rather than to the *conversation*.
 *
 * HOW IT KEEPS THE VALUE OUT OF THE MODEL'S CONTEXT
 * -------------------------------------------------
 * It does not invent a lookup scheme. It registers the value with the session's
 * {@link SecretObfuscator}, which already owns both halves of the round trip:
 *
 *   outbound  every provider-visible byte is rewritten, so the raw value is
 *             replaced by a keyed `$$LABEL_<hmac>:<case>$$` placeholder
 *   inbound   `deobfuscateToolArguments` restores the raw value in a tool
 *             call's arguments immediately BEFORE the tool executes
 *
 * So the model can write the placeholder into a `bash` env value and the child
 * process receives the real secret, while the provider only ever saw the
 * placeholder. The placeholder base is an HMAC under a per-install key that is
 * never sent to a provider, so a prompt-injected model cannot forge a handle
 * for a secret it was not given.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * - No persistence. This map lives in process memory for one session and is
 *   never serialized; no session entry type carries it. Long-term storage is a
 *   secrets manager or vault, and moving a credential there is exactly the kind
 *   of task the agent can perform *using* the placeholder.
 * - No un-redaction on {@link forget}. Dropping the obfuscator mapping would
 *   let the raw bytes flow to the provider again if they later appeared in tool
 *   output, which is strictly worse than a stale mapping. `forget` therefore
 *   revokes the model's *reference* while the redaction stays in force for the
 *   remainder of the session.
 */
import type { SecretObfuscator } from "./obfuscator";

/** Where a stored credential came from, used only for operator-facing display. */
export type CredentialSource = "command" | "ask";

/** A credential the operator has handed to this session. Carries no secret bytes. */
export interface SessionCredential {
	/** Operator-facing label, normalized to env-var shape (e.g. `GITHUB_TOKEN`). */
	key: string;
	/** Keyed placeholder the model uses to reference the value. Safe to display. */
	placeholder: string;
	/** How the value was captured. */
	source: CredentialSource;
	/** Epoch ms when the value was captured. */
	storedAt: number;
}

/** Why a {@link SessionCredentials.store} call did not store anything. */
export type CredentialStoreFailure = "empty-key" | "empty-value" | "too-short" | "unstorable";

export type CredentialStoreResult =
	| { ok: true; credential: SessionCredential; replaced: boolean }
	| { ok: false; reason: CredentialStoreFailure };

/**
 * Shortest value the obfuscator will substitute (`MIN_OBFUSCATE_SECRET_LEN`).
 * Duplicated as a user-facing number so error copy can name the limit without
 * importing an internal constant into UI code.
 */
export const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Normalize an operator-supplied label to env-var shape so the same credential
 * is addressable however it was typed (`github token`, `github-token`,
 * `GITHUB_TOKEN` all collapse to `GITHUB_TOKEN`). Returns `undefined` when
 * nothing usable remains, which the caller reports rather than guessing a name.
 */
export function normalizeCredentialKey(raw: string): string | undefined {
	const normalized = raw
		.trim()
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	return normalized.length > 0 ? normalized : undefined;
}

/** Operator-facing explanation for a refused store, naming the concrete limit. */
export function describeStoreFailure(reason: CredentialStoreFailure, key: string): string {
	switch (reason) {
		case "empty-key":
			return `Not a usable credential key: ${key}`;
		case "empty-value":
			return "Nothing pasted; no credential stored.";
		case "too-short":
			// Not an arbitrary limit: below this the obfuscator would substitute a
			// string short enough to collide with ordinary prose, corrupting
			// unrelated text on every outbound message.
			return `Value is too short to redact safely (needs at least ${MIN_CREDENTIAL_LENGTH} characters); no credential stored.`;
		case "unstorable":
			return "That value cannot be redacted safely; no credential stored.";
	}
}

export class SessionCredentials {
	/** Insertion-ordered so the prompt block and `/credential` listing agree. */
	readonly #entries = new Map<string, SessionCredential>();
	readonly #obfuscator: SecretObfuscator;

	constructor(obfuscator: SecretObfuscator) {
		this.#obfuscator = obfuscator;
	}

	/**
	 * Capture a secret under `rawKey` and return its placeholder.
	 *
	 * The raw value is passed straight to the obfuscator and is never retained
	 * here: after this call the only copy in this module's reach is the
	 * obfuscator's own mapping.
	 */
	store(rawKey: string, value: string, source: CredentialSource = "command"): CredentialStoreResult {
		const key = normalizeCredentialKey(rawKey);
		if (key === undefined) return { ok: false, reason: "empty-key" };
		if (value.length === 0) return { ok: false, reason: "empty-value" };
		if (value.length < MIN_CREDENTIAL_LENGTH) return { ok: false, reason: "too-short" };
		const placeholder = this.#obfuscator.addPlainSecret(value, key);
		// `addPlainSecret` only refuses values it cannot redact safely. Reporting
		// that as a failure — rather than returning the raw value under a fake
		// handle — is the whole point: a caller must never see an unredactable
		// secret succeed.
		if (placeholder === undefined) return { ok: false, reason: "unstorable" };
		const replaced = this.#entries.has(key);
		const credential: SessionCredential = { key, placeholder, source, storedAt: Date.now() };
		this.#entries.set(key, credential);
		return { ok: true, credential, replaced };
	}

	get(key: string): SessionCredential | undefined {
		const normalized = normalizeCredentialKey(key);
		return normalized === undefined ? undefined : this.#entries.get(normalized);
	}

	list(): readonly SessionCredential[] {
		return [...this.#entries.values()];
	}

	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Revoke the model's reference to a credential. The obfuscator keeps
	 * redacting the value (see the file header): forgetting a handle must not
	 * un-hide bytes the operator already marked secret.
	 */
	forget(key: string): boolean {
		const normalized = normalizeCredentialKey(key);
		return normalized === undefined ? false : this.#entries.delete(normalized);
	}

	/** Revoke every reference. Same redaction caveat as {@link forget}. */
	clear(): number {
		const count = this.#entries.size;
		this.#entries.clear();
		return count;
	}
}
