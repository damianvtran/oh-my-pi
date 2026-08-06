/**
 * Restoring a session that never reached disk.
 *
 * Session files are written lazily — nothing lands until the session produces
 * durable output — but the session id is published at startup, and a supervisor
 * binds it as the surface's restore command (cmux's omp template is literally
 * `{{executable}} --session {{sessionId}}`). A crash before the first assistant
 * turn therefore leaves a binding pointing at an id with no file, and the
 * restore used to die with `Session "<id>" not found.`, dropping the workspace
 * to a bare shell.
 *
 * `--session <full id>` now adopts that id instead. `--resume` / `-r`, and any
 * partial id, stay strict so a human typo still errors.
 */
import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { makeAssistantMessage } from "./session-manager/helpers";

function buildSessionArgs(sessionArg: string, sessionDir: string, adopt = true): Args {
	return {
		resume: sessionArg,
		adoptSession: adopt,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

const UNWRITTEN_ID = "019fd500-0dd8-7000-8e06-a6888f9142b5";

async function withTempProject(run: (cwd: string, sessionDir: string) => Promise<void>): Promise<void> {
	const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-adopt-session-"));
	try {
		await run(cwd, path.join(cwd, "sessions"));
	} finally {
		await fsp.rm(cwd, { recursive: true, force: true });
	}
}

describe("createSessionManager — --session adopts an unwritten id", () => {
	it("comes back as that session instead of failing the launch", async () => {
		await withTempProject(async (cwd, sessionDir) => {
			const manager = await createSessionManager(buildSessionArgs(UNWRITTEN_ID, sessionDir), cwd, stubSettings);

			expect(manager).toBeDefined();
			expect(manager?.getSessionId()).toBe(UNWRITTEN_ID);
			expect(manager?.getEntries()).toEqual([]);
			// Adoption must not defeat lazy persistence: an empty restored session
			// stays off disk exactly like a freshly typed `omp` would.
			expect(manager?.getSessionFile()).toContain(UNWRITTEN_ID);
			expect(await Bun.file(manager?.getSessionFile() as string).exists()).toBe(false);
		});
	});

	it("materializes under the adopted id, so the next restore resolves normally", async () => {
		await withTempProject(async (cwd, sessionDir) => {
			const manager = await createSessionManager(buildSessionArgs(UNWRITTEN_ID, sessionDir), cwd, stubSettings);
			manager?.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
			manager?.appendMessage(makeAssistantMessage());
			await manager?.rewriteEntries();

			const match = await resolveResumableSession(UNWRITTEN_ID, cwd, sessionDir);
			expect(match?.session.id).toBe(UNWRITTEN_ID);

			const restored = await createSessionManager(buildSessionArgs(UNWRITTEN_ID, sessionDir), cwd, stubSettings);
			expect(restored?.getSessionId()).toBe(UNWRITTEN_ID);
			expect(restored?.getEntries().length).toBe(2);
		});
	});

	it("opens an existing session rather than adopting over it", async () => {
		await withTempProject(async (cwd, sessionDir) => {
			const existing = SessionManager.create(cwd, sessionDir);
			existing.appendMessage({ role: "user", content: "already here", timestamp: Date.now() });
			await existing.rewriteEntries();
			const existingId = existing.getSessionId();

			const manager = await createSessionManager(buildSessionArgs(existingId, sessionDir), cwd, stubSettings);

			expect(manager?.getSessionId()).toBe(existingId);
			expect(manager?.getEntries().length).toBe(1);
		});
	});

	it("still rejects a partial id, which no supervisor ever produces", async () => {
		await withTempProject(async (cwd, sessionDir) => {
			await expect(
				createSessionManager(buildSessionArgs("019fd500", sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019fd500" not found.',
			});
		});
	});

	it("still rejects the same id under --resume", async () => {
		await withTempProject(async (cwd, sessionDir) => {
			await expect(
				createSessionManager(buildSessionArgs(UNWRITTEN_ID, sessionDir, false), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${UNWRITTEN_ID}" not found.`,
			});
		});
	});
});
