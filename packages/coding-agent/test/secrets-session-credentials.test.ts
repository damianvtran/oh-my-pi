/**
 * Contract tests for the session credential vault.
 *
 * The single property everything else rests on: a stored value is absent from
 * every provider-visible byte, and present again in a tool call's arguments at
 * the moment the tool runs. Each test below pins one edge of that property.
 */
import { describe, expect, it } from "bun:test";
import { deobfuscateToolArguments, obfuscateMessages } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	MIN_CREDENTIAL_LENGTH,
	normalizeCredentialKey,
	SessionCredentials,
} from "@oh-my-pi/pi-coding-agent/secrets/session-credentials";

const TEST_KEY = "test-placeholder-key-for-session-credential-specs";
const TOKEN = "ghp_liveTokenValue1234567890";

function makeVault(): { vault: SessionCredentials; obfuscator: SecretObfuscator } {
	const obfuscator = new SecretObfuscator([], TEST_KEY);
	return { vault: new SessionCredentials(obfuscator), obfuscator };
}

describe("normalizeCredentialKey", () => {
	it("collapses separators and case so one credential has one name", () => {
		expect(normalizeCredentialKey("github token")).toBe("GITHUB_TOKEN");
		expect(normalizeCredentialKey("github-token")).toBe("GITHUB_TOKEN");
		expect(normalizeCredentialKey("  GitHub.Token  ")).toBe("GITHUB_TOKEN");
	});

	it("rejects a label with nothing addressable left", () => {
		expect(normalizeCredentialKey("---")).toBeUndefined();
		expect(normalizeCredentialKey("   ")).toBeUndefined();
	});
});

describe("SessionCredentials.store", () => {
	it("turns an empty obfuscator into an active one", () => {
		const { vault, obfuscator } = makeVault();
		expect(obfuscator.hasSecrets()).toBe(false);
		expect(vault.store("github token", TOKEN).ok).toBe(true);
		expect(obfuscator.hasSecrets()).toBe(true);
	});

	it("returns a placeholder that is not the value and carries the normalized key", () => {
		const { vault } = makeVault();
		const result = vault.store("github token", TOKEN);
		if (!result.ok) throw new Error(`expected store to succeed, got ${result.reason}`);
		expect(result.credential.key).toBe("GITHUB_TOKEN");
		expect(result.credential.placeholder).not.toContain(TOKEN);
		expect(result.credential.placeholder).toContain("GITHUBTOKEN");
		expect(result.replaced).toBe(false);
	});

	it("refuses a value too short to substitute without corrupting prose", () => {
		const { vault, obfuscator } = makeVault();
		const short = "a".repeat(MIN_CREDENTIAL_LENGTH - 1);
		expect(vault.store("PIN", short)).toEqual({ ok: false, reason: "too-short" });
		// Critically: nothing was registered, so the caller cannot mistake a
		// refusal for a stored-but-unlabelled secret.
		expect(vault.size).toBe(0);
		expect(obfuscator.hasSecrets()).toBe(false);
	});

	it("refuses an unusable key and an empty value", () => {
		const { vault } = makeVault();
		expect(vault.store("---", TOKEN)).toEqual({ ok: false, reason: "empty-key" });
		expect(vault.store("GITHUB_TOKEN", "")).toEqual({ ok: false, reason: "empty-value" });
	});

	it("reuses one placeholder when the same bytes are stored twice", () => {
		const { vault } = makeVault();
		const first = vault.store("PRIMARY", TOKEN);
		const second = vault.store("MIRROR", TOKEN);
		if (!first.ok || !second.ok) throw new Error("expected both stores to succeed");
		expect(second.credential.placeholder).toBe(first.credential.placeholder);
		expect(vault.list().map(entry => entry.key)).toEqual(["PRIMARY", "MIRROR"]);
	});

	it("reports a re-store under the same key as a replacement", () => {
		const { vault } = makeVault();
		vault.store("GITHUB_TOKEN", TOKEN);
		const again = vault.store("GITHUB_TOKEN", "ghp_rotatedValue0987654321");
		if (!again.ok) throw new Error("expected rotation to succeed");
		expect(again.replaced).toBe(true);
		expect(vault.size).toBe(1);
	});
});

describe("credential round trip", () => {
	it("hides the value from provider-visible messages", () => {
		const { vault, obfuscator } = makeVault();
		const result = vault.store("GITHUB_TOKEN", TOKEN);
		if (!result.ok) throw new Error("expected store to succeed");

		const messages = obfuscateMessages(obfuscator, [
			{ role: "user", content: `run it with ${TOKEN} please` },
		] as never);
		const serialized = JSON.stringify(messages);
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).toContain(result.credential.placeholder);
	});

	it("restores the value in tool arguments so bash receives the real secret", () => {
		const { vault, obfuscator } = makeVault();
		const result = vault.store("GITHUB_TOKEN", TOKEN);
		if (!result.ok) throw new Error("expected store to succeed");

		// Exactly what the model is told to emit: the placeholder as an env value.
		const restored = deobfuscateToolArguments(obfuscator, {
			command: "gh api /user",
			env: { GITHUB_TOKEN: result.credential.placeholder },
		});
		expect((restored.env as Record<string, string>).GITHUB_TOKEN).toBe(TOKEN);
	});

	it("does not resolve a placeholder the obfuscator never minted", () => {
		const { vault, obfuscator } = makeVault();
		vault.store("GITHUB_TOKEN", TOKEN);
		// A forged handle must stay inert: placeholder bases are HMACed under a key
		// the model never sees, so guessing one cannot exfiltrate a secret.
		const forged = "$$GITHUBTOKEN_AAAAAAAAAAAA:L$$";
		const restored = deobfuscateToolArguments(obfuscator, { env: { GITHUB_TOKEN: forged } });
		expect((restored.env as Record<string, string>).GITHUB_TOKEN).not.toBe(TOKEN);
	});
});

describe("SessionCredentials.forget", () => {
	it("revokes the reference while the value stays redacted", () => {
		const { vault, obfuscator } = makeVault();
		vault.store("GITHUB_TOKEN", TOKEN);
		expect(vault.forget("github-token")).toBe(true);
		expect(vault.list()).toEqual([]);
		// The whole point of not un-registering: bytes the operator marked secret
		// must not start flowing to the provider again mid-session.
		expect(obfuscator.obfuscate(`token ${TOKEN}`)).not.toContain(TOKEN);
	});

	it("reports an unknown key rather than silently succeeding", () => {
		const { vault } = makeVault();
		expect(vault.forget("NOPE")).toBe(false);
	});

	it("clear() returns how many references it revoked", () => {
		const { vault } = makeVault();
		vault.store("A_TOKEN", TOKEN);
		vault.store("B_TOKEN", "another-live-secret-value");
		expect(vault.clear()).toBe(2);
		expect(vault.size).toBe(0);
	});
});

describe("SecretObfuscator.addPlainSecret", () => {
	it("refuses to re-register one of its own placeholders", () => {
		const obfuscator = new SecretObfuscator([], TEST_KEY);
		const placeholder = obfuscator.addPlainSecret(TOKEN, "GITHUB_TOKEN");
		expect(placeholder).toBeDefined();
		// Registering a placeholder as a secret would make the forward and reverse
		// maps disagree about what that token means.
		expect(obfuscator.addPlainSecret(placeholder as string, "LOOP")).toBeUndefined();
	});

	it("keeps entries added at construction working alongside runtime ones", () => {
		const configured = "configured-secret-value";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: configured }], TEST_KEY);
		const runtime = obfuscator.addPlainSecret(TOKEN, "GITHUB_TOKEN");
		if (runtime === undefined) throw new Error("expected runtime registration to succeed");
		const hidden = obfuscator.obfuscate(`${configured} and ${TOKEN}`);
		expect(hidden).not.toContain(configured);
		expect(hidden).not.toContain(TOKEN);
		expect(obfuscator.deobfuscate(hidden)).toBe(`${configured} and ${TOKEN}`);
	});
});
