import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { rankSessionSearchMatches } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { listSessions, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getHistoryDbPath, getSessionsDir, TempDir } from "@oh-my-pi/pi-utils";

function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `${id}.jsonl`,
		id,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		size: 100,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

describe("slotted session headers", () => {
	it("lists and ranks sessions whose mutable title slot is the first JSONL entry", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const file = `${sessionDir}/slotted.jsonl`;
		storage.writeTextSync(
			file,
			[
				JSON.stringify({ type: "title", v: 1, title: "Slot Title", updatedAt: "2026-06-27T00:00:00.000Z" }),
				JSON.stringify({
					type: "session",
					id: "header-id",
					cwd: "/repo",
					title: "Stale Header Title",
					timestamp: "2026-06-27T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "first prompt" } }),
				"",
			].join("\n"),
		);

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions.map(session => ({ id: session.id, cwd: session.cwd, title: session.title }))).toEqual([
			{ id: "header-id", cwd: "/repo", title: "Slot Title" },
		]);
		expect(ids(rankSessionSearchMatches(sessions, "slot"))).toEqual(["header-id"]);
	});

	it("cleans history rows for archived slotted sessions by reading the header after the title slot", async () => {
		const tempDir = TempDir.createSync("@test-slotted-archive-");
		try {
			const root = tempDir.path();
			const archiveDir = path.join(root, "archive", "sessions", "project");
			const archived = path.join(archiveDir, "legacy-name.jsonl.gz");
			await Bun.write(
				archived,
				gzipSync(
					[
						JSON.stringify({
							type: "title",
							v: 1,
							title: "Archived Slot Title",
							updatedAt: "2026-06-27T00:00:00.000Z",
						}),
						JSON.stringify({
							type: "session",
							version: 3,
							id: "archive-header-id",
							timestamp: "2026-06-27T00:00:00.000Z",
							cwd: "/repo",
						}),
						"",
					].join("\n"),
				),
			);
			const dbPath = getHistoryDbPath(root);
			const db = new Database(dbPath);
			db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
			db.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-header-id')");
			db.close();

			const result = await runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					coldArchiveAfterDays: 30,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
					apply: true,
				},
			});

			const check = new Database(dbPath);
			const rows = check.prepare("SELECT session_id FROM history").all() as Array<{ session_id: string }>;
			check.close();
			expect(result.archive?.historyRowsDeleted).toBe(1);
			expect(rows).toEqual([]);
			expect(await Bun.file(path.join(getSessionsDir(root), "project", "legacy-name.jsonl")).exists()).toBe(false);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});

describe("rankSessionSearchMatches", () => {
	it("keeps equally-matched sessions in recency order", () => {
		const oldPrefix = makeSession("old-prefix", {
			title: "Resize buffer issue",
			firstMessage: "why doesnt resize properly clean the scrollback buffer",
			modified: new Date("2024-01-01T00:00:00Z"),
		});
		const oldControls = makeSession("old-controls", {
			title: "Resize controls",
			firstMessage: "can you make width height resize always clean reset",
			modified: new Date("2024-01-01T01:00:00Z"),
		});
		const recentWindow = makeSession("recent-window", {
			title: "Window resize issues",
			firstMessage: "when i resize the window rapidly i end up with this",
			modified: new Date("2024-01-03T00:00:00Z"),
		});

		// All three carry "resize" as a title word, so nothing separates them on
		// relevance and recency decides — the behaviour the old recency-first
		// ranking got right and this ranker has to preserve.
		expect(ids(rankSessionSearchMatches([oldPrefix, oldControls, recentWindow], "resize"))).toEqual([
			"recent-window",
			"old-controls",
			"old-prefix",
		]);
	});

	it("ranks a title match above a newer session that only mentions the query in its transcript", () => {
		const named = makeSession("named", {
			title: "Fix session ranking",
			modified: new Date("2024-01-01T00:00:00Z"),
		});
		const mentions = makeSession("mentions", {
			title: "Unrelated refactor",
			allMessagesText: "we should probably look at session ranking later on",
			modified: new Date("2024-06-01T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([mentions, named], "ranking"))).toEqual(["named", "mentions"]);
	});

	it("ranks a whole-word title hit above a mid-word substring hit", () => {
		const word = makeSession("word", { title: "Auth proxy rollout" });
		const substring = makeSession("substring", { title: "Reauthorize the tenant" });

		expect(ids(rankSessionSearchMatches([substring, word], "auth"))).toEqual(["word", "substring"]);
	});

	it("ranks the project directory above a body mention", () => {
		const project = makeSession("project", { cwd: "/repo/user-dashboard", title: "Ship the banner" });
		const mention = makeSession("mention", {
			cwd: "/repo/core",
			title: "Ship the banner",
			allMessagesText: "the user-dashboard team asked for this",
		});

		expect(ids(rankSessionSearchMatches([mention, project], "user-dashboard"))).toEqual(["project", "mention"]);
	});

	it("rewards the full phrase appearing in the title over the same words scattered", () => {
		const phrase = makeSession("phrase", { title: "Fix login button" });
		const scattered = makeSession("scattered", { title: "Login flow: fix the submit button" });

		expect(ids(rankSessionSearchMatches([scattered, phrase], "fix login"))).toEqual(["phrase", "scattered"]);
	});

	it("keeps literal matches ahead of pure fuzzy matches", () => {
		const fuzzyRecent = makeSession("fuzzy-recent", {
			title: "Render buffer",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const literalOld = makeSession("literal-old", {
			title: "RB notes",
			modified: new Date("2024-01-01T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([fuzzyRecent, literalOld], "rb"))).toEqual(["literal-old", "fuzzy-recent"]);
	});

	it("filters low-quality pure fuzzy matches while keeping exact matches", () => {
		const exact = makeSession("exact", { title: "MN discussion" });
		const lowQuality = makeSession("low-quality", { title: "Random notes" });

		expect(ids(rankSessionSearchMatches([exact, lowQuality], "mn"))).toEqual(["exact"]);
	});

	it("requires every query token to match", () => {
		const both = makeSession("both", { title: "Deploy the billing service" });
		const one = makeSession("one", { title: "Deploy the portal" });

		expect(ids(rankSessionSearchMatches([one, both], "deploy billing"))).toEqual(["both"]);
	});

	it("matches a session ID by prefix but not by an interior fragment", () => {
		const prefix = makeSession("abc123def", { title: "Nothing relevant" });

		expect(ids(rankSessionSearchMatches([prefix], "abc12"))).toEqual(["abc123def"]);
		expect(rankSessionSearchMatches([prefix], "23de")).toEqual([]);
	});

	it("returns all sessions unchanged for an empty query", () => {
		const sessions = [makeSession("a"), makeSession("b")];

		expect(rankSessionSearchMatches(sessions, "   ")).toBe(sessions);
	});
});

describe("rankSessionSearchMatches signals", () => {
	it("surfaces a session that only the prompt history matched", () => {
		const named = makeSession("named", { title: "Buffer resize" });
		const deep = makeSession("deep", { title: "Unrelated work" });

		// "deep" has no text match at all: the prompt lives past the 4KB listing
		// prefix, so history is the only evidence it is relevant.
		expect(ids(rankSessionSearchMatches([named, deep], "resize", { historyIds: ["deep"] }))).toEqual([
			"named",
			"deep",
		]);
	});

	it("orders history-only matches by their history rank", () => {
		const all = ["a", "b", "c"].map(id => makeSession(id, { title: "Unrelated work" }));

		expect(ids(rankSessionSearchMatches(all, "resize", { historyIds: ["c", "a"] }))).toEqual(["c", "a"]);
	});

	it("ignores history matches for sessions absent from the list", () => {
		const only = makeSession("a", { title: "Unrelated work" });

		expect(ids(rankSessionSearchMatches([only], "resize", { historyIds: ["a", "z"] }))).toEqual(["a"]);
	});

	it("never lets a history hit displace the session the query actually names", () => {
		const named = makeSession("named", { title: "Session ranking rewrite" });
		const historical = makeSession("historical", {
			title: "Something else",
			allMessagesText: "ranking",
		});

		// The regression this ranker exists to fix: promoting history matches
		// wholesale put "historical" first even though "named" is the answer.
		expect(ids(rankSessionSearchMatches([named, historical], "ranking", { historyIds: ["historical"] }))).toEqual([
			"named",
			"historical",
		]);
	});

	it("admits and orders keyword-index hits that the listing text never contained", () => {
		const indexed = makeSession("indexed", { title: "Nightly job cleanup" });
		const weaker = makeSession("weaker", { title: "Another chore" });

		const ranked = rankSessionSearchMatches([weaker, indexed], "cron", {
			indexScores: new Map([
				["indexed", 0.9],
				["weaker", 0.2],
			]),
		});
		expect(ids(ranked)).toEqual(["indexed", "weaker"]);
	});

	it("returns the text ranking unchanged when no signal fired", () => {
		const a = makeSession("a", { title: "Resize a", modified: new Date("2024-01-02T00:00:00Z") });
		const b = makeSession("b", { title: "Resize b", modified: new Date("2024-01-01T00:00:00Z") });

		expect(ids(rankSessionSearchMatches([a, b], "resize", {}))).toEqual(["a", "b"]);
	});
});
