/**
 * The `<session-credentials>` prompt block.
 *
 * Two properties matter: it costs nothing when the operator has never used
 * `/credential`, and when present it names every stored key with the
 * placeholder the model must use — never a value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionCredential } from "@oh-my-pi/pi-coding-agent/secrets/session-credentials";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const credential = (key: string, placeholder: string): SessionCredential => ({
	key,
	placeholder,
	source: "command",
	storedAt: 0,
});

describe("system prompt session-credentials block", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-credentials-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-credentials-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(credentials?: readonly SessionCredential[]): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			credentials,
		});
		return systemPrompt.join("\n\n");
	}

	it("costs nothing when no credential has been stored", async () => {
		expect(await render()).not.toContain("<session-credentials>");
		expect(await render([])).not.toContain("<session-credentials>");
	});

	it("lists each key with the placeholder the model must pass to a tool", async () => {
		const rendered = await render([
			credential("GITHUB_TOKEN", "$$GITHUBTOKEN_AAAAAAAAAAAA:L$$"),
			credential("DEPLOY_KEY", "$$DEPLOYKEY_BBBBBBBBBBBB:L$$"),
		]);
		expect(rendered).toContain("<session-credentials>");
		expect(rendered).toContain("`GITHUB_TOKEN` → `$$GITHUBTOKEN_AAAAAAAAAAAA:L$$`");
		expect(rendered).toContain("`DEPLOY_KEY` → `$$DEPLOYKEY_BBBBBBBBBBBB:L$$`");
	});

	it("carries the constraints that keep a placeholder from leaking", async () => {
		const rendered = await render([credential("GITHUB_TOKEN", "$$GITHUBTOKEN_AAAAAAAAAAAA:L$$")]);
		// A subagent builds its own obfuscator and cannot resolve this handle, so
		// the raw value would be copied into its transcript instead.
		expect(rendered).toContain("subagent");
		expect(rendered).toContain("`task`");
		// Long-term storage belongs in a real vault, not a repo dotfile.
		expect(rendered).toContain("secrets manager");
	});

	it("reaches custom system prompts too", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			resolvedCustomPrompt: "You are a narrowly scoped assistant.",
			credentials: [credential("GITHUB_TOKEN", "$$GITHUBTOKEN_AAAAAAAAAAAA:L$$")],
		});
		expect(systemPrompt.join("\n\n")).toContain("<session-credentials>");
	});
});
