import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractSessionKeywords, SessionIndexStorage } from "@oh-my-pi/pi-coding-agent/session/session-index-storage";

let tempDir: string | null = null;
let dbPath: string | null = null;

/**
 * Every test gets its own temp-file database. `SessionIndexStorage.open()`
 * defaults to `~/.omp/agent/session-index.db`, so an explicit path is not
 * optional here — the singleton would otherwise index the developer's real
 * sessions and the prune test would delete from them.
 */
function freshStorage(): SessionIndexStorage {
	SessionIndexStorage.resetInstance();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-index-"));
	dbPath = path.join(tempDir, "session-index.db");
	return SessionIndexStorage.open(dbPath);
}

afterEach(() => {
	SessionIndexStorage.resetInstance();
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
		dbPath = null;
	}
});

/**
 * Filler rows with no overlapping vocabulary. FTS5's bm25 clamps a
 * non-positive IDF to 1e-6, and IDF only stays positive while a term appears
 * in fewer than half the rows, so a two-row table collapses every score to the
 * same -0.000001 and the weighting cannot be observed. Padding the corpus is
 * what makes the ranking assertions meaningful rather than accidental.
 */
function seedFiller(storage: SessionIndexStorage): void {
	storage.upsert({ sessionId: "filler-1", title: "zeta eta", keywords: "theta", summary: "iota kappa" });
	storage.upsert({ sessionId: "filler-2", title: "lambda mu", keywords: "nu", summary: "xi omicron" });
	storage.upsert({ sessionId: "filler-3", title: "rho sigma", keywords: "tau", summary: "upsilon phi" });
}

describe("SessionIndexStorage.search", () => {
	it("finds a session by a title, keyword, or summary word", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({
			sessionId: "s1",
			cwd: "/tmp/project",
			title: "kubernetes rollback",
			keywords: "helm chart staging",
			summary: "Reverted the ingress controller to the previous revision.",
		});

		expect(storage.search("kubernetes").map(h => h.sessionId)).toEqual(["s1"]);
		expect(storage.search("helm").map(h => h.sessionId)).toEqual(["s1"]);
		expect(storage.search("ingress").map(h => h.sessionId)).toEqual(["s1"]);
	});

	it("stems both the stored text and the query", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "stored-stem", title: "deploy the gateway" });
		storage.upsert({ sessionId: "stored-inflected", keywords: "migrating databases" });

		// Porter stems the indexed term and the query term to the same root, so
		// the match works in both directions.
		expect(storage.search("deploying").map(h => h.sessionId)).toEqual(["stored-stem"]);
		expect(storage.search("migrate").map(h => h.sessionId)).toEqual(["stored-inflected"]);
	});

	it("merges partial upserts instead of clearing absent fields", () => {
		const storage = freshStorage();
		seedFiller(storage);
		// The two real call sites: a rename supplies title/cwd, the theme pass
		// supplies keywords/summary. Neither may erase the other.
		storage.upsert({ sessionId: "s1", cwd: "/tmp/project", title: "kubernetes rollback" });
		storage.upsert({ sessionId: "s1", keywords: "helm chart", summary: "Reverted the ingress controller." });

		expect(storage.search("kubernetes").map(h => h.sessionId)).toEqual(["s1"]);
		expect(storage.search("helm").map(h => h.sessionId)).toEqual(["s1"]);
		expect(storage.search("ingress").map(h => h.sessionId)).toEqual(["s1"]);
	});

	it("ranks a title match above a summary match of the same token", () => {
		const storage = freshStorage();
		seedFiller(storage);
		// Same token, same document length, different column.
		storage.upsert({ sessionId: "in-title", title: "deploy pipeline", keywords: "alpha", summary: "beta gamma" });
		storage.upsert({ sessionId: "in-summary", title: "alpha beta", keywords: "gamma", summary: "deploy pipeline" });

		const hits = storage.search("deploy");
		expect(hits.map(h => h.sessionId)).toEqual(["in-title", "in-summary"]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
	});

	it("scores every hit inside (0, 1]", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "strong", title: "deploy deploy deploy", keywords: "deploy", summary: "deploy" });
		storage.upsert({ sessionId: "weak", summary: "one passing mention of deploy in a much longer blurb of text" });

		const hits = storage.search("deploy");
		expect(hits.length).toBe(2);
		for (const hit of hits) {
			expect(hit.score).toBeGreaterThan(0);
			expect(hit.score).toBeLessThanOrEqual(1);
		}
	});

	it("requires every query token to match (AND, not OR)", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "pipeline", title: "deploy pipeline" });
		storage.upsert({ sessionId: "dashboard", title: "deploy dashboard" });

		expect(
			storage
				.search("deploy")
				.map(h => h.sessionId)
				.sort(),
		).toEqual(["dashboard", "pipeline"]);
		expect(storage.search("deploy dashboard").map(h => h.sessionId)).toEqual(["dashboard"]);
		// A token no row carries kills the whole conjunction.
		expect(storage.search("deploy nonexistentword")).toEqual([]);
	});

	it("respects the result limit", () => {
		const storage = freshStorage();
		seedFiller(storage);
		for (let i = 0; i < 5; i++) {
			storage.upsert({ sessionId: `s${i}`, title: `deploy service ${i}` });
		}

		expect(storage.search("deploy", 2).length).toBe(2);
		expect(storage.search("deploy", 0)).toEqual([]);
	});

	it("falls back to substring matching at a score below any stemmed hit", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "infix", title: "kubernetes rollback" });

		// FTS5's `*` is prefix-only, so `ubernet` is unreachable by MATCH.
		const fallback = storage.search("ubernet");
		expect(fallback.map(h => h.sessionId)).toEqual(["infix"]);

		const stemmed = storage.search("kubernetes");
		expect(fallback[0].score).toBeLessThan(stemmed[0].score);
	});
});

describe("SessionIndexStorage.prune", () => {
	it("removes the row and its FTS mirror entry", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "doomed", title: "kubernetes rollback", keywords: "helm chart" });
		storage.upsert({ sessionId: "keeper", title: "kubernetes upgrade", keywords: "helm release" });
		expect(storage.search("rollback").map(h => h.sessionId)).toEqual(["doomed"]);

		storage.prune(["doomed"]);

		// A stale external-content mirror would still answer this query with
		// `doomed`, which is exactly the failure the AFTER DELETE trigger exists
		// to prevent.
		expect(storage.search("rollback")).toEqual([]);
		expect(storage.search("upgrade").map(h => h.sessionId)).toEqual(["keeper"]);

		const probe = new Database(dbPath as string);
		try {
			probe.run("PRAGMA busy_timeout = 5000");
			const row = probe.prepare("SELECT COUNT(*) AS n FROM session_index WHERE session_id = ?").get("doomed") as {
				n: number;
			};
			expect(row.n).toBe(0);
			// Throws when the mirror disagrees with the content table.
			expect(() =>
				probe.run("INSERT INTO session_index_fts(session_index_fts) VALUES('integrity-check')"),
			).not.toThrow();
		} finally {
			probe.close();
		}
	});

	it("prunes more sessions than one statement batch holds", () => {
		const storage = freshStorage();
		const ids = Array.from({ length: 950 }, (_, i) => `bulk-${i}`);
		for (const id of ids) storage.upsert({ sessionId: id, title: `deploy ${id}` });
		expect(storage.search("deploy", 1000).length).toBe(950);

		storage.prune(ids);

		expect(storage.search("deploy", 1000)).toEqual([]);
	});

	it("ignores an empty id list", () => {
		const storage = freshStorage();
		storage.upsert({ sessionId: "keeper", title: "kubernetes rollback" });
		storage.prune([]);
		expect(storage.search("rollback").map(h => h.sessionId)).toEqual(["keeper"]);
	});
});

describe("SessionIndexStorage.search hostile input", () => {
	it("returns an empty result instead of throwing", () => {
		const storage = freshStorage();
		seedFiller(storage);
		storage.upsert({ sessionId: "s1", title: "kubernetes rollback", keywords: "helm chart staging" });

		expect(storage.search("nonexistentword")).toEqual([]);
		// FTS5 operators the user meant as words, an unbalanced quote, an empty
		// query: all of these are one unquoted token away from a syntax error.
		expect(storage.search("a AND OR ( *")).toEqual([]);
		expect(storage.search("NEAR")).toEqual([]);
		expect(storage.search('"')).toEqual([]);
		expect(storage.search("")).toEqual([]);
		expect(storage.search("   ")).toEqual([]);
		expect(storage.search("*** ( ) ~")).toEqual([]);
		// Punctuation around a real token is stripped, not treated as syntax.
		expect(storage.search("^rollback~").map(h => h.sessionId)).toEqual(["s1"]);

		// The index still answers a legitimate query afterwards.
		expect(storage.search("rollback").map(h => h.sessionId)).toEqual(["s1"]);
	});
});

describe("extractSessionKeywords", () => {
	it("drops stopwords, function words and code noise", () => {
		const terms = extractSessionKeywords("The function should return the const value for this deployment");
		expect(terms).toContain("deployment");
		expect(terms).not.toContain("should");
		expect(terms).not.toContain("the");
		expect(terms).not.toContain("function");
		expect(terms).not.toContain("return");
		expect(terms).not.toContain("const");
		expect(terms).not.toContain("value");
		expect(terms).not.toContain("file");
	});

	it("splits camelCase and snake_case while keeping the whole identifier", () => {
		const terms = extractSessionKeywords("call getUserToken and refresh_session_cookie");
		expect(terms).toContain("getusertoken");
		expect(terms).toContain("user");
		expect(terms).toContain("token");
		expect(terms).toContain("refresh");
		expect(terms).toContain("cookie");
		// The whole snake_case identifier has no separator left after the
		// non-alphanumeric split, so only its parts survive.
		expect(terms).toContain("session");
	});

	it("keeps letter-digit terms but drops pure numbers", () => {
		const terms = extractSessionKeywords("upload to s3 with oauth2 on v1 at 42 and 1234");
		expect(terms).toContain("s3");
		expect(terms).toContain("oauth2");
		expect(terms).toContain("v1");
		expect(terms).not.toContain("42");
		expect(terms).not.toContain("1234");
	});

	it("orders by frequency, then by first occurrence", () => {
		const terms = extractSessionKeywords("alpha bravo charlie bravo delta charlie bravo");
		// bravo x3, charlie x2, then the singletons in the order they appeared.
		expect(terms).toEqual(["bravo", "charlie", "alpha", "delta"]);
	});

	it("respects the limit and returns unique terms", () => {
		const text = "kubernetes cluster rollback ingress controller staging";
		expect(extractSessionKeywords(text, 3)).toEqual(["kubernetes", "cluster", "rollback"]);
		expect(extractSessionKeywords(text, 0)).toEqual([]);
		const all = extractSessionKeywords("deploy deploy deploy staging staging");
		expect(all).toEqual(["deploy", "staging"]);
	});

	it("bounds the input it scans", () => {
		// Everything past 32 KiB is ignored, so a term that only appears in the
		// tail of a huge transcript cannot show up.
		const text = `${"kubernetes ".repeat(4000)}sentinelterm`;
		expect(text.length).toBeGreaterThan(32 * 1024);
		const terms = extractSessionKeywords(text);
		expect(terms).toContain("kubernetes");
		expect(terms).not.toContain("sentinelterm");
	});
});
