/**
 * Contract: classifying the process table into omp *sessions*.
 *
 * The portal can only aggregate a session that published a collab room, so the
 * sessions that did not are worth naming in `omp mobile status`. Getting that
 * list wrong is worse than not having it: counting the portal, the relay, or the
 * `omp mobile status` process itself would tell the user their sessions are
 * unreachable when they are fine.
 *
 * The parser is tested rather than `ps` itself — spawning `ps` proves nothing
 * about the classification, and the classification is the part that is easy to
 * get wrong.
 */
import { describe, expect, it } from "bun:test";
import { parseOmpSessionProcesses } from "@oh-my-pi/pi-coding-agent/mobile/discovery";

const SUBCOMMANDS = new Set(["mobile", "config", "stats", "join", "worktree", "wt"]);

function parse(lines: string[]) {
	return parseOmpSessionProcesses(lines.join("\n"), { selfPid: 999, subcommands: SUBCOMMANDS });
}

describe("parseOmpSessionProcesses", () => {
	it("finds interactive sessions, with or without a prompt argument", () => {
		const found = parse([
			" 1201 /Users/me/oss/oh-my-pi/packages/coding-agent/dist/omp",
			" 1202 /opt/homebrew/bin/omp",
			' 1203 /usr/local/bin/omp "fix the build"',
			" 1204 /Users/me/.local/bin/omp --model anthropic/claude-opus-5",
		]);
		expect(found.map(p => p.pid)).toEqual([1201, 1202, 1203, 1204]);
		expect(found[0]?.command).toBe("/Users/me/oss/oh-my-pi/packages/coding-agent/dist/omp");
	});

	it("excludes the two mobile services, which are the same binary as a session", () => {
		// This is the one that would make status lie: the portal and relay always
		// run, so counting them would permanently show two unreachable sessions.
		const found = parse([
			" 1301 /usr/bin/caffeinate -dims /Users/me/dist/omp mobile relay --port 7466",
			" 1302 /Users/me/dist/omp mobile serve --port 4097",
			" 1303 /Users/me/dist/omp mobile status",
			" 1304 /Users/me/dist/omp",
		]);
		expect(found.map(p => p.pid)).toEqual([1304]);
	});

	it("excludes other management invocations by consulting the command registry", () => {
		const found = parse([" 1401 /Users/me/dist/omp config get collab.autoStart", " 1402 /Users/me/dist/omp wt list"]);
		expect(found).toEqual([]);
	});

	it("excludes this process, so `omp mobile status` never lists itself", () => {
		expect(parse([" 999 /Users/me/dist/omp"])).toEqual([]);
	});

	it("ignores processes that merely mention omp", () => {
		const found = parse([
			" 1501 grep -r omp /Users/me/src",
			" 1502 /bin/zsh -c omp",
			" 1503 /Users/me/dist/omp-official",
			" 1504 /Users/me/other/ompy",
			" 1505 tail -f /Users/me/Library/Logs/sh.omp.mobile-portal.out.log",
		]);
		expect(found).toEqual([]);
	});

	it("does not treat a prompt's words as arguments", () => {
		// `omp "config get something"` is a prompt, not the config subcommand: only
		// argv[1] decides, and the whole line stays available for display.
		const found = parse([' 1601 /Users/me/dist/omp "config get the vibe right"']);
		expect(found.map(p => p.pid)).toEqual([1601]);
	});

	it("survives the garbage a process table can contain", () => {
		expect(parse(["", "   ", "notanumber /Users/me/dist/omp", " 1701 ", " 1702"])).toEqual([]);
	});
});
