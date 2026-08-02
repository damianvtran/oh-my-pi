/**
 * Contract: `SessionManager.onSessionIdChanged` fires for every change of the
 * active session id, and only for a real change.
 *
 * It is the trigger a process-scoped collab room (`collab.autoStart`) rebinds
 * on, which is what lets an in-session `/resume` keep remote access instead of
 * ending the room until the next launch. Every id write funnels through one
 * setter precisely so a future transition cannot bypass the tap — these cover
 * the transitions that reach it (new session, resume, fork, branch) plus the
 * no-op reload that must stay silent, since a rebind means re-sending every
 * guest a full snapshot.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** A resumable session file with a known id and one user message. */
async function writeSession(sessionDir: string, id: string, cwd: string): Promise<string> {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd };
	const message = {
		type: "message",
		id: `${id}-m1`,
		parentId: null,
		timestamp,
		message: { role: "user", content: "hello", timestamp: Date.now() },
	};
	const file = path.join(sessionDir, `${id}.jsonl`);
	await Bun.write(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
	return file;
}

describe("SessionManager.onSessionIdChanged", () => {
	it("fires once per real session change and stays silent on a same-session reload", async () => {
		using tempDir = TempDir.createSync("@omp-session-id-tap-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const resumable = await writeSession(sessionDir, "resumed-session", cwd);

			const manager = SessionManager.create(cwd, sessionDir);
			const observed: string[] = [];
			manager.onSessionIdChanged(sessionId => observed.push(sessionId));

			// `/new`: a minted id the tap must report.
			await manager.newSession();
			const fresh = manager.getSessionId();
			expect(observed).toEqual([fresh]);

			// `/resume`: the id comes from the loaded header, not a mint.
			await manager.setSessionFile(resumable);
			expect(manager.getSessionId()).toBe("resumed-session");
			expect(observed).toEqual([fresh, "resumed-session"]);

			// Re-loading the same file is not a session change: re-welcoming every
			// guest with an identical snapshot would be pure churn.
			await manager.setSessionFile(resumable);
			expect(observed).toEqual([fresh, "resumed-session"]);

			// `/fork` mints a new id for the copy.
			const forked = await manager.fork();
			expect(forked).toBeDefined();
			const forkedId = manager.getSessionId();
			expect(forkedId).not.toBe("resumed-session");
			expect(observed).toEqual([fresh, "resumed-session", forkedId]);

			// `/tree` / rewind: branching off an existing entry is also a new session.
			const leafId = manager.getEntries().find(entry => entry.type === "message")?.id;
			expect(leafId).toBeDefined();
			manager.createBranchedSession(leafId as string);
			expect(observed).toEqual([fresh, "resumed-session", forkedId, manager.getSessionId()]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("does not abort a session switch when the observer throws", async () => {
		// The tap runs inside the transition, so a broken observer must not be able
		// to leave the manager pointing at neither session.
		using tempDir = TempDir.createSync("@omp-session-id-tap-throw-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const resumable = await writeSession(sessionDir, "target-session", cwd);

			const manager = SessionManager.create(cwd, sessionDir);
			manager.onSessionIdChanged(() => {
				throw new Error("observer exploded");
			});

			await manager.setSessionFile(resumable);
			expect(manager.getSessionId()).toBe("target-session");
			expect(manager.getSessionFile()).toBe(resumable);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("notifies every subscriber, survives a broken one, and stops after unsubscribe", async () => {
		// Two features subscribe in a real session — the collab room and the cmux
		// resume binding — so a single-slot tap would silently unhook whichever
		// registered first, and one throwing observer must not cost the other its
		// notification.
		using tempDir = TempDir.createSync("@omp-session-id-tap-multi-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const first = await writeSession(sessionDir, "first-session", cwd);
			const second = await writeSession(sessionDir, "second-session", cwd);

			const manager = SessionManager.create(cwd, sessionDir);
			const quiet: string[] = [];
			const noisy: string[] = [];
			manager.onSessionIdChanged(sessionId => {
				noisy.push(sessionId);
				throw new Error("observer exploded");
			});
			const unsubscribe = manager.onSessionIdChanged(sessionId => quiet.push(sessionId));

			await manager.setSessionFile(first);
			expect(noisy).toEqual(["first-session"]);
			expect(quiet).toEqual(["first-session"]);

			unsubscribe();
			await manager.setSessionFile(second);
			expect(noisy).toEqual(["first-session", "second-session"]);
			expect(quiet).toEqual(["first-session"]);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});
});
