/**
 * `ask` secret-question mode.
 *
 * The contract: when the model sets `secret: true`, the operator's pasted value
 * lands in the session credential vault and NOTHING the tool returns contains
 * it — not the response text the model reads, not `details`, which the session
 * JSONL and every transcript export serialize verbatim.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { SessionCredentials } from "@oh-my-pi/pi-coding-agent/secrets/session-credentials";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";

const TEST_KEY = "test-placeholder-key-for-ask-secret-specs";
const TOKEN = "sk-liveSecretValue1234567890";

interface InputCall {
	title: string;
	inputOptions?: { mask?: boolean };
}

interface HarnessOptions {
	/** Omit the vault to simulate a session built without credential support. */
	withVault?: boolean;
	/** Present a rich ask dialog, which a secret question must refuse to use. */
	withAskDialog?: boolean;
	/** Answer for the option selector, used by the mixed-batch case. */
	select?: () => Promise<string | undefined>;
}

function createHarness(pasted: string | undefined, options: HarnessOptions = {}) {
	const { withVault = true, withAskDialog = false, select } = options;
	const obfuscator = new SecretObfuscator([], TEST_KEY);
	const credentials = withVault ? new SessionCredentials(obfuscator) : undefined;
	const inputCalls: InputCall[] = [];
	const session = {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		credentials,
	} as unknown as ToolSession;
	// Every surface a secret question must NOT touch throws, so a regression that
	// routes a credential through a plaintext path fails loudly instead of quietly
	// working.
	const ui = {
		select:
			select ??
			(() => {
				throw new Error("secret question must not use the option selector");
			}),
		editor: () => {
			throw new Error("secret question must not use the unmasked editor");
		},
		...(withAskDialog
			? {
					askDialog: () => {
						throw new Error("secret question must not use the rich ask dialog");
					},
				}
			: {}),
		input: async (
			title: string,
			_placeholder?: string,
			_dialogOptions?: unknown,
			inputOptions?: { mask?: boolean },
		) => {
			inputCalls.push({ title, inputOptions });
			return pasted;
		},
	};
	const context = { hasUI: true, ui, abort: () => {} } as unknown as AgentToolContext;
	return { tool: new AskTool(session), context, credentials, obfuscator, inputCalls };
}

const secretQuestion = {
	id: "github_token",
	question: "Paste a GitHub token with repo scope",
	options: [],
	secret: true,
};

beforeAll(async () => {
	await initTheme(false);
});

describe("ask secret questions", () => {
	it("captures through a masked prompt and returns only the placeholder", async () => {
		const { tool, context, credentials, inputCalls } = createHarness(TOKEN);
		const result = await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);

		expect(inputCalls).toHaveLength(1);
		expect(inputCalls[0]?.inputOptions?.mask).toBe(true);

		const stored = credentials?.get("GITHUB_TOKEN");
		expect(stored).toBeDefined();

		// The two surfaces that carry the answer onward.
		const modelText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(modelText).not.toContain(TOKEN);
		expect(modelText).toContain(stored?.placeholder ?? "<missing>");
		expect(JSON.stringify(result.details)).not.toContain(TOKEN);
		expect(result.details?.customInput).toBe(stored?.placeholder);
	});

	it("names the credential after the question id", async () => {
		const { tool, context, credentials, inputCalls } = createHarness(TOKEN);
		await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		expect(credentials?.list().map(entry => entry.key)).toEqual(["GITHUB_TOKEN"]);
		expect(credentials?.list()[0]?.source).toBe("ask");
		expect(inputCalls[0]?.title).toContain("GITHUB_TOKEN");
	});

	it("stores the exact bytes a tool call will receive", async () => {
		const { tool, context, credentials, obfuscator } = createHarness(`${TOKEN}\n`);
		await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		const placeholder = credentials?.get("GITHUB_TOKEN")?.placeholder;
		if (placeholder === undefined) throw new Error("expected the credential to be stored");
		expect(obfuscator.deobfuscate(placeholder)).toBe(TOKEN);
	});

	it("reports a decline as an answer instead of aborting the turn", async () => {
		const { tool, context, credentials } = createHarness(undefined);
		const result = await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		expect(credentials?.size).toBe(0);
		const modelText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(modelText).toContain("declined");
	});

	it("reports a too-short value without storing it", async () => {
		const { tool, context, credentials } = createHarness("short");
		const result = await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		expect(credentials?.size).toBe(0);
		const modelText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(modelText).toContain("too short");
	});

	it("says so when the session has no vault rather than leaking the value", async () => {
		const { tool, context } = createHarness(TOKEN, { withVault: false });
		const result = await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		const modelText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(modelText).not.toContain(TOKEN);
		expect(modelText).toContain("unavailable");
	});

	it("bypasses the batched rich dialog, which cannot mask", async () => {
		// A rich dialog is available, but a secret question must not use it: it
		// renders free text back into its own option list before submit.
		const { tool, context, credentials, inputCalls } = createHarness(TOKEN, { withAskDialog: true });
		await tool.execute("call-1", { questions: [secretQuestion] }, undefined, undefined, context);
		expect(inputCalls).toHaveLength(1);
		expect(credentials?.get("GITHUB_TOKEN")).toBeDefined();
	});

	it("still answers a plain question asked alongside a secret one", async () => {
		const { tool, context, credentials } = createHarness(TOKEN, { select: async () => "staging" });
		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{ id: "env", question: "Which environment?", options: [{ label: "staging" }, { label: "prod" }] },
					secretQuestion,
				],
			},
			undefined,
			undefined,
			context,
		);
		const modelText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(modelText).toContain("staging");
		expect(modelText).not.toContain(TOKEN);
		expect(credentials?.get("GITHUB_TOKEN")).toBeDefined();
	});
});
