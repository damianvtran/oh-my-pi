import { describe, expect, it } from "bun:test";
import {
	ArgvDisclosureLedger,
	redactCommandLine,
	redactProcessInvocation,
} from "@oh-my-pi/pi-coding-agent/utils/argv-disclosure";

/**
 * Sentinel stand-in for the credential shape that caused this guard to exist: a
 * DSN handed to a subprocess in argv. Never a real credential.
 */
const SENTINEL_DSN =
	"postgres://sentinel_user:SENTINEL-P4ss-DO-NOT-USE@db.example.invalid:5432/sentineldb?sslmode=require";

function ledgerOf(...sources: string[]): ArgvDisclosureLedger {
	const ledger = new ArgvDisclosureLedger();
	for (const source of sources) ledger.record(source);
	return ledger;
}

describe("redactCommandLine", () => {
	it("keeps a fully disclosed command line byte-identical", () => {
		const line = "/bin/sh -c 'exit 3' --flag=value";
		const ledger = ledgerOf(`execFile("/bin/sh", ["-c", "exit 3", "--flag=value"])`);
		expect(redactCommandLine(line, ledger)).toBe(line);
	});

	it("replaces an undisclosed argument with its length only", () => {
		const ledger = ledgerOf(`execFile("psql", [process.env.DSN])`);
		const redacted = redactCommandLine(`/usr/bin/psql ${SENTINEL_DSN}`, ledger);
		expect(redacted).toBe(`/usr/bin/psql <redacted:${SENTINEL_DSN.length}c>`);
		expect(redacted).not.toContain("SENTINEL");
		expect(redacted).not.toContain("sentinel");
	});

	it("always keeps argv[0] even when the runtime resolved it beyond the source", () => {
		// The cell wrote `"sh"`; the runtime spawned `/bin/sh`. The program is the
		// primary diagnostic and is never a credential, so it survives regardless.
		const ledger = ledgerOf(`execFile("sh", ["-c", "true"])`);
		expect(redactCommandLine("/bin/sh -c true", ledger)).toBe("/bin/sh -c true");
	});

	it("treats a quoted argument as one argument so innocent commands stay intact", () => {
		// Naive whitespace splitting would break `'Accept: application/json'` into
		// two tokens that match nothing, half-redacting a harmless command line.
		const ledger = ledgerOf(`exec("curl -H 'Accept: application/json' https://example.invalid")`);
		const line = "curl -H 'Accept: application/json' https://example.invalid";
		expect(redactCommandLine(line, ledger)).toBe(line);
	});

	it("redacts every argument past argv[0] when nothing is known to be disclosed", () => {
		expect(redactCommandLine(`/usr/bin/psql --quiet ${SENTINEL_DSN}`)).toBe(
			`/usr/bin/psql <redacted:7c> <redacted:${SENTINEL_DSN.length}c>`,
		);
	});

	it("counts a value assembled from parts as undisclosed", () => {
		// The template's literal halves are in the source but the interpolated
		// password is not, so the assembled argument must not be echoed.
		const ledger = ledgerOf(`execFile("psql", [\`postgres://u:\${pw}@h.invalid/db\`])`);
		expect(redactCommandLine("psql postgres://u:hunter2@h.invalid/db", ledger)).toBe("psql <redacted:33c>");
	});

	it("resolves disclosure against any recorded cell, not just the newest", () => {
		const ledger = ledgerOf(`const target = "--dry-run";`, `execFile("git", ["push", target])`);
		expect(redactCommandLine("git push --dry-run", ledger)).toBe("git push --dry-run");
	});

	it("forgets evicted cells rather than growing without bound", () => {
		const ledger = new ArgvDisclosureLedger();
		ledger.record("push --first-cell-flag");
		for (let i = 0; i < 64; i++) ledger.record(`filler-${i}`);
		// Eviction may only cost fidelity, never safety: the oldest cell stops
		// resolving (both of its arguments redact) while recent cells still do.
		expect(redactCommandLine("git push --first-cell-flag", ledger)).toBe("git <redacted:4c> <redacted:17c>");
		expect(redactCommandLine("git push filler-63", ledger)).toBe("git <redacted:4c> filler-63");
	});
});

describe("redactProcessInvocation", () => {
	it("redacts the argv Node bakes into an exec-family failure message and stack", () => {
		const ledger = ledgerOf(`execFile("/bin/sh", ["-c", "sleep 30", process.env.DSN])`);
		const error = new Error(`Command failed: /bin/sh -c sleep 30 ${SENTINEL_DSN}\n`);
		Object.assign(error, { cmd: `/bin/sh -c sleep 30 ${SENTINEL_DSN}`, killed: true, signal: "SIGTERM" });

		const display = redactProcessInvocation(error, ledger);

		expect(display.message).toBe(`Command failed: /bin/sh -c sleep 30 <redacted:${SENTINEL_DSN.length}c>\n`);
		expect(display.message).not.toContain("SENTINEL");
		expect(display.stack).toBeDefined();
		expect(display.stack).not.toContain("SENTINEL");
		// The invocation is filtered; the diagnostics around it are not.
		expect(display.message).toContain("/bin/sh -c sleep 30");
	});

	it("redacts a sync exec failure that carries no cmd property, using Node's own message prefix", () => {
		// `execFileSync` attaches no `cmd`; the joined argv exists only in the message.
		const ledger = ledgerOf(`execFileSync("/bin/sh", ["-c", "exit 3", dsn])`);
		const error = new Error(`Command failed: /bin/sh -c exit 3 ${SENTINEL_DSN}\nboom\n`);

		const display = redactProcessInvocation(error, ledger);

		expect(display.message).toBe(`Command failed: /bin/sh -c exit 3 <redacted:${SENTINEL_DSN.length}c>\nboom\n`);
	});

	it("leaves the process object untouched so cell code can still read it", () => {
		const cmd = `psql ${SENTINEL_DSN}`;
		const error = new Error(`Command failed: ${cmd}`);
		Object.assign(error, { cmd });

		redactProcessInvocation(error, ledgerOf(""));

		// Deliberate disclosure stays possible: a `catch` block that prints
		// `err.cmd` is an explicit act, not the accident this guard prevents.
		expect(error.message).toContain(SENTINEL_DSN);
		expect(Reflect.get(error, "cmd")).toBe(cmd);
	});

	it("passes an ordinary error through unchanged", () => {
		// Filtering an ordinary message would redact words no cell source mentions
		// (`posix_spawn`, type names, absolute paths) and wreck normal diagnostics.
		const error = new TypeError("undefined is not a function (near 'wat.qux')");
		const display = redactProcessInvocation(error, ledgerOf("wat.qux()"));
		expect(display.message).toBe("undefined is not a function (near 'wat.qux')");
		expect(display.stack).toBe(error.stack);
	});

	it("passes a spawn error whose message carries no argv through unchanged", () => {
		const error = new Error("spawnSync /bin/sh ETIMEDOUT");
		Object.assign(error, { syscall: "spawnSync", code: "ETIMEDOUT" });
		expect(redactProcessInvocation(error, ledgerOf("")).message).toBe("spawnSync /bin/sh ETIMEDOUT");
	});
});
