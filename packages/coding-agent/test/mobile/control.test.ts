/**
 * Contract: spawning a session from the phone is guarded by directory
 * validation that errs on the side of doing nothing — the portal runs under
 * launchd with an unpredictable working directory, so a relative path must be
 * rejected outright rather than resolved into a session started somewhere the
 * user never meant. The nanny argv is the other half: the portal and every
 * test must agree on the exact `mobile host --cwd` spelling the CLI dispatches.
 *
 * The picker suggestions run against a session store this file creates under an
 * isolated `PI_CONFIG_DIR`. Reading the developer's real store made the
 * assertions pass vacuously on a machine with no sessions, and left the one rule
 * that actually broke — the interaction between the cap and the existence filter
 * — unexpressible.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildHostArgv, listDirectorySuggestions, validateSessionCwd } from "@oh-my-pi/pi-coding-agent/mobile/control";
import { __resetDirsFromEnvForTests, getAgentDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
let sessionsRoot = "";
/** Directories the fixture sessions point at; only some of them exist. */
let liveDirs: string[] = [];
let deletedDir = "";

/** One session file, mtime-ordered by the caller writing them in sequence. */
async function writeSession(project: string, id: string, cwd: string): Promise<void> {
	const dir = path.join(sessionsRoot, project);
	await fs.mkdir(dir, { recursive: true });
	const header = JSON.stringify({ type: "session", id, timestamp: new Date().toISOString(), cwd });
	await fs.writeFile(path.join(dir, `${id}.jsonl`), `${header}\n`);
}

beforeAll(async () => {
	process.env.PI_CONFIG_DIR = `.omp-test-mobile-control-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	sessionsRoot = path.join(getAgentDir(), "sessions");
	expect(sessionsRoot).not.toBe(path.join(os.homedir(), ".omp", "sessions"));

	const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-suggest-"));
	liveDirs = [path.join(base, "alpha"), path.join(base, "beta")];
	for (const dir of liveDirs) await fs.mkdir(dir, { recursive: true });
	deletedDir = path.join(base, "gone");

	// Oldest first, so the newest write is the newest session. The deleted
	// directory is deliberately the most recent: with the cap applied before the
	// existence check it would eat the only slot a limit of 1 has.
	await writeSession("proj", "s-home", os.homedir());
	await writeSession("proj", "s-beta", liveDirs[1]!);
	await writeSession("proj", "s-beta-dup", liveDirs[1]!);
	await writeSession("other", "s-alpha", liveDirs[0]!);
	await writeSession("other", "s-gone", deletedDir);
});

afterAll(async () => {
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
});

describe("mobile session control", () => {
	it("accepts an existing absolute directory and normalizes it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-control-"));
		try {
			expect(await validateSessionCwd(`  ${dir}//  `)).toBe(path.normalize(dir));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("expands ~ the way a phone keyboard writes it", async () => {
		expect(await validateSessionCwd("~")).toBe(os.homedir());
	});

	it("rejects relative input rather than resolving it against the service's cwd", async () => {
		await expect(validateSessionCwd("tmp")).rejects.toThrow(/absolute path/);
		await expect(validateSessionCwd("")).rejects.toThrow(/required/);
		await expect(validateSessionCwd("   ")).rejects.toThrow(/required/);
	});

	it("rejects a path that does not exist", async () => {
		await expect(validateSessionCwd("/definitely/not/here-omp-mobile-control")).rejects.toThrow(/does not exist/);
	});

	it("rejects a path that is a file, not a directory", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-control-"));
		const file = path.join(dir, "file.txt");
		await fs.writeFile(file, "x");
		try {
			await expect(validateSessionCwd(file)).rejects.toThrow(/not a directory/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("builds the nanny argv as `mobile host --cwd` on the launch argv", () => {
		expect(buildHostArgv(["/usr/local/bin/omp"], "/tmp/work")).toEqual([
			"/usr/local/bin/omp",
			"mobile",
			"host",
			"--cwd",
			"/tmp/work",
		]);
	});

	it("refuses to build a nanny argv from an empty launch argv", () => {
		// An `[]` in the install record passes the state file's shape check, and
		// without this guard "mobile" itself becomes the executable.
		expect(() => buildHostArgv([], "/tmp/work")).toThrow(/launch argv/);
	});

	it("offers home as its own choice, newest first, deduped, existing only", async () => {
		const suggestions = await listDirectorySuggestions();

		expect(suggestions.home).toBe(os.homedir());
		// Home has a named choice of its own, so it must not also appear as an
		// anonymous path in the recent list.
		expect(suggestions.recent).not.toContain(os.homedir());
		// Newest session first, one entry per directory, and the deleted directory
		// dropped — a phone cannot browse its way out of a dead path.
		expect(suggestions.recent).toEqual([liveDirs[0], liveDirs[1]]);
		expect(suggestions.recent).not.toContain(deletedDir);
	});

	it("fills the limit with directories that exist rather than spending it on deleted ones", async () => {
		// The newest session points at a deleted directory. Applying the cap before
		// the existence check returned an empty list here while a live directory sat
		// one place further down.
		expect(await listDirectorySuggestions(1)).toEqual({ home: os.homedir(), recent: [liveDirs[0]] });
	});
});
