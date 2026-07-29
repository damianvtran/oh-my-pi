/**
 * Contract: spawning a session from the phone is guarded by directory
 * validation that errs on the side of doing nothing — the portal runs under
 * launchd with an unpredictable working directory, so a relative path must be
 * rejected outright rather than resolved into a session started somewhere the
 * user never meant. The nanny argv is the other half: the portal and every
 * test must agree on the exact `mobile host --cwd` spelling the CLI dispatches.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildHostArgv, listDirectorySuggestions, validateSessionCwd } from "@oh-my-pi/pi-coding-agent/mobile/control";

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

	it("offers home as its own choice and never repeats it among the recent directories", async () => {
		const suggestions = await listDirectorySuggestions();

		expect(suggestions.home).toBe(os.homedir());
		expect(suggestions.recent).not.toContain(os.homedir());
		// Deleted directories would be dead ends on a phone that cannot browse.
		for (const dir of suggestions.recent) {
			expect(await fs.stat(dir).then(stat => stat.isDirectory())).toBe(true);
		}
		expect(new Set(suggestions.recent).size).toBe(suggestions.recent.length);
	});
});
