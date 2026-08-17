/**
 * `/credential` behaviour: argument parsing, the ACP (`handle`) verbs, and the
 * TUI capture flow (`handleTui`) including the guarantee that the pasted value
 * reaches the vault masked and never the transcript.
 */
import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { SessionCredentials } from "@oh-my-pi/pi-coding-agent/secrets/session-credentials";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseCredentialCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/credential";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const TEST_KEY = "test-placeholder-key-for-credential-command-specs";
const TOKEN = "glpat_liveTokenValue1234567890";

const spec = () => {
	const found = lookupBuiltinSlashCommand("credential");
	if (!found) throw new Error("/credential is not registered");
	return found;
};

function makeVault(): SessionCredentials & { obfuscator: SecretObfuscator } {
	const obfuscator = new SecretObfuscator([], TEST_KEY);
	return Object.assign(new SessionCredentials(obfuscator), { obfuscator });
}

/** Minimal ACP runtime: only the members `/credential`'s `handle` touches. */
function makeAcpRuntime(vault: SessionCredentials | undefined) {
	const output: string[] = [];
	const runtime = {
		session: { credentials: vault, refreshBaseSystemPrompt: async () => {} },
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, output };
}

/** Minimal TUI runtime plus a scripted answer for the masked prompt. */
function makeTuiRuntime(vault: SessionCredentials | undefined, pasted: string | undefined) {
	const status: string[] = [];
	const errors: string[] = [];
	const prompts: Array<{ title: string; inputOptions?: { mask?: boolean } }> = [];
	let refreshed = 0;
	const runtime = {
		ctx: {
			editor: { setText: () => {} },
			showStatus: (text: string) => {
				status.push(text);
			},
			showError: (text: string) => {
				errors.push(text);
			},
			showHookInput: async (title: string, _placeholder?: string, inputOptions?: { mask?: boolean }) => {
				prompts.push({ title, inputOptions });
				return pasted;
			},
			session: {
				credentials: vault,
				refreshBaseSystemPrompt: async () => {
					refreshed += 1;
				},
			},
		},
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, status, errors, prompts, refreshCount: () => refreshed };
}

describe("parseCredentialCommand", () => {
	it("treats a bare argument as the key to store", () => {
		expect(parseCredentialCommand("github token")).toEqual({ action: "store", key: "GITHUB_TOKEN" });
	});

	it("lists when given no argument", () => {
		expect(parseCredentialCommand("   ")).toEqual({ action: "list" });
	});

	it("routes the flag-shaped verbs", () => {
		expect(parseCredentialCommand("--forget GITHUB_TOKEN")).toEqual({ action: "forget", key: "GITHUB_TOKEN" });
		expect(parseCredentialCommand("--forget-all")).toEqual({ action: "forget-all" });
	});

	it("rejects an unknown option instead of storing it as a key", () => {
		// A key can never start with `-` after normalization, so this cannot be a
		// legitimate credential name and must not be silently accepted as one.
		const parsed = parseCredentialCommand("--wipe");
		expect(parsed.action).toBe("error");
	});

	it("reports a missing key after --forget", () => {
		expect(parseCredentialCommand("--forget").action).toBe("error");
	});
});

describe("/credential registration", () => {
	it("accepts arguments, which the TUI dispatcher gates on", () => {
		// Without allowArgs the dispatcher silently refuses `/credential FOO`.
		expect(spec().allowArgs).toBe(true);
	});

	it("is reachable through its alias", () => {
		expect(lookupBuiltinSlashCommand("cred")?.name).toBe("credential");
	});

	it("exposes an ACP handler so editor clients can list and revoke", () => {
		expect(typeof spec().handle).toBe("function");
	});
});

describe("/credential handle (ACP)", () => {
	it("lists stored credentials by key and placeholder", async () => {
		const vault = makeVault();
		const stored = vault.store("GITHUB_TOKEN", TOKEN);
		if (!stored.ok) throw new Error("expected store to succeed");
		const { runtime, output } = makeAcpRuntime(vault);
		await spec().handle?.({ name: "credential", args: "", text: "/credential" }, runtime);
		expect(output.join("\n")).toContain("GITHUB_TOKEN");
		expect(output.join("\n")).toContain(stored.credential.placeholder);
	});

	it("refuses to capture a value where input cannot be masked", async () => {
		const vault = makeVault();
		const { runtime, output } = makeAcpRuntime(vault);
		await spec().handle?.({ name: "credential", args: "GITHUB_TOKEN", text: "/credential GITHUB_TOKEN" }, runtime);
		expect(output.join("\n")).toContain("interactive");
		expect(vault.size).toBe(0);
	});

	it("forgets a named credential", async () => {
		const vault = makeVault();
		vault.store("GITHUB_TOKEN", TOKEN);
		const { runtime, output } = makeAcpRuntime(vault);
		await spec().handle?.(
			{ name: "credential", args: "--forget github-token", text: "/credential --forget github-token" },
			runtime,
		);
		expect(vault.size).toBe(0);
		expect(output.join("\n")).toContain("Forgot GITHUB_TOKEN");
	});

	it("says so when the session has no vault", async () => {
		const { runtime, output } = makeAcpRuntime(undefined);
		await spec().handle?.({ name: "credential", args: "", text: "/credential" }, runtime);
		expect(output.join("\n")).toContain("not available");
	});
});

describe("/credential handleTui", () => {
	it("captures with a masked prompt and stores the value", async () => {
		const vault = makeVault();
		const { runtime, status, prompts, refreshCount } = makeTuiRuntime(vault, TOKEN);
		await spec().handleTui?.({ name: "credential", args: "github token", text: "/credential github token" }, runtime);

		expect(prompts).toHaveLength(1);
		// The whole reason this path exists: the value must never be painted.
		expect(prompts[0]?.inputOptions?.mask).toBe(true);
		expect(prompts[0]?.title).toContain("GITHUB_TOKEN");

		const stored = vault.get("GITHUB_TOKEN");
		expect(stored).toBeDefined();
		// The confirmation the operator sees names the placeholder, not the secret.
		const shown = status.join("\n");
		expect(shown).not.toContain(TOKEN);
		expect(shown).toContain(stored?.placeholder ?? "<missing>");
		// The model only learns the key exists when the prompt is rebuilt.
		expect(refreshCount()).toBe(1);
	});

	it("strips the whitespace a paste carries so the stored bytes authenticate", async () => {
		const vault = makeVault();
		const { runtime } = makeTuiRuntime(vault, `${TOKEN}\n`);
		await spec().handleTui?.({ name: "credential", args: "GITHUB_TOKEN", text: "/credential GITHUB_TOKEN" }, runtime);
		const placeholder = vault.get("GITHUB_TOKEN")?.placeholder;
		if (placeholder === undefined) throw new Error("expected the credential to be stored");
		// Resolve the handle the way a tool call would: the bytes handed to the
		// tool must be the token without the pasted newline.
		expect(vault.obfuscator.deobfuscate(placeholder)).toBe(TOKEN);
	});

	it("stores nothing and says so when the operator cancels", async () => {
		const vault = makeVault();
		const { runtime, status, refreshCount } = makeTuiRuntime(vault, undefined);
		await spec().handleTui?.({ name: "credential", args: "GITHUB_TOKEN", text: "/credential GITHUB_TOKEN" }, runtime);
		expect(vault.size).toBe(0);
		expect(status.join("\n")).toContain("Cancelled");
		expect(refreshCount()).toBe(0);
	});

	it("surfaces the length limit rather than storing an unredactable value", async () => {
		const vault = makeVault();
		const { runtime, errors, refreshCount } = makeTuiRuntime(vault, "short");
		await spec().handleTui?.({ name: "credential", args: "PIN", text: "/credential PIN" }, runtime);
		expect(vault.size).toBe(0);
		expect(errors.join("\n")).toContain("too short");
		expect(refreshCount()).toBe(0);
	});

	it("never opens a prompt for the list verb", async () => {
		const vault = makeVault();
		const { runtime, prompts, status } = makeTuiRuntime(vault, TOKEN);
		await spec().handleTui?.({ name: "credential", args: "", text: "/credential" }, runtime);
		expect(prompts).toHaveLength(0);
		expect(status.join("\n")).toContain("No credentials stored");
	});
});
