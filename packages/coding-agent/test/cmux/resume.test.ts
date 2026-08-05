/**
 * Contract: the cmux resume binding tracks the session this process has loaded,
 * and never writes something a restore would choke on.
 *
 * This is the difference between a cmux workspace coming back on the session you
 * left it on after a reboot and coming back as an empty shell, so the cases that
 * matter are the ones nobody notices until the machine restarts: a surface that
 * is not under cmux, a dev launch whose executable is not omp, a session id that
 * changed mid-flight, and a CLI that failed.
 *
 * The stub CLI is a shell script that appends its argv to a file — the real
 * contract is the argv cmux receives, and asserting on it is what proves the
 * `--surface … -- <exe> --session <id>` shape stays intact.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CmuxResumeBinder, type CmuxResumeEnvironment } from "@oh-my-pi/pi-coding-agent/cmux/resume";
import { TempDir } from "@oh-my-pi/pi-utils";

let temp: TempDir;
let calls: string;

/**
 * A stub `cmux` that records one line per invocation. `exit 1` mode reproduces a
 * refused write (app not running, unknown surface) without needing one.
 */
async function writeStubCli(name: string, exitCode: number): Promise<string> {
	const file = path.join(temp.path(), name);
	await Bun.write(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit ${exitCode}\n`);
	await fs.chmod(file, 0o755);
	return file;
}

async function recorded(): Promise<string[]> {
	const text = await Bun.file(calls)
		.text()
		.catch(() => "");
	return text.split("\n").filter(line => line.length > 0);
}

function environment(overrides: Partial<CmuxResumeEnvironment> = {}): CmuxResumeEnvironment {
	return {
		surfaceId: "SURFACE-1",
		cli: "/nonexistent-cmux",
		// A restore re-runs this, so the guard keys on its basename; the file need
		// not exist because the stub CLI never executes it.
		executable: "/opt/omp/bin/omp",
		// The common case for this fallback: no cmux omp integration installed, so
		// the binder is the only thing that will tell cmux about the session.
		hookExtensionInstalled: false,
		...overrides,
	};
}

describe("CmuxResumeBinder", () => {
	beforeEach(() => {
		temp = TempDir.createSync("@omp-cmux-resume-");
		calls = path.join(temp.path(), "calls.txt");
	});
	afterEach(() => {
		temp[Symbol.dispose]();
	});

	it("binds the surface to the current session and skips an unchanged re-assert", async () => {
		const cli = await writeStubCli("cmux-ok", 0);
		const binder = new CmuxResumeBinder(environment({ cli }));

		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toEqual([
			"surface resume set --surface SURFACE-1 -- /opt/omp/bin/omp --session session-a",
		]);

		// Startup registers, and so does every session-id notification; re-asserting
		// what cmux already holds must not cost a subprocess per event.
		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toHaveLength(1);
	});

	it("follows a session change and collapses a burst to the final id", async () => {
		const cli = await writeStubCli("cmux-ok", 0);
		const binder = new CmuxResumeBinder(environment({ cli }));

		binder.register("session-a");
		// `/tree` navigation walks several ids faster than the CLI runs. Only the
		// first and the last matter: an intermediate binding is never the session
		// the user ends up in, and writing each one would serialize a stall.
		binder.register("session-b");
		binder.register("session-c");
		await binder.settled();

		const lines = await recorded();
		expect(lines[0]).toContain("--session session-a");
		expect(lines.at(-1)).toContain("--session session-c");
		expect(lines).not.toContain("surface resume set --surface SURFACE-1 -- /opt/omp/bin/omp --session session-b");
	});

	it("retries after a refused write instead of believing the binding landed", async () => {
		const failing = await writeStubCli("cmux-fail", 1);
		const binder = new CmuxResumeBinder(environment({ cli: failing }));

		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toHaveLength(1);

		// Recording a failed attempt as bound would leave the surface pointing at
		// nothing for the rest of the process's life.
		binder.register("session-b");
		await binder.settled();
		expect(await recorded()).toHaveLength(2);
	});

	it("does nothing outside a cmux surface", async () => {
		const cli = await writeStubCli("cmux-ok", 0);
		const binder = new CmuxResumeBinder(environment({ cli, surfaceId: undefined }));

		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toEqual([]);
	});

	it("does nothing when the executable is not an omp binary", async () => {
		// `bun run src/main.ts`: binding `bun --session <id>` would make the next
		// restore strictly worse than leaving the surface unbound.
		const cli = await writeStubCli("cmux-ok", 0);
		const binder = new CmuxResumeBinder(environment({ cli, executable: "/opt/homebrew/bin/bun" }));

		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toEqual([]);
	});

	it("stands down when cmux's own omp hooks own the binding", async () => {
		// Both writers target the same surface, and cmux pins a `cli` binding to
		// the manual approval policy. Racing the hook's auto binding down to manual
		// is the one outcome worse than not binding at all.
		const cli = await writeStubCli("cmux-ok", 0);
		const binder = new CmuxResumeBinder(environment({ cli, hookExtensionInstalled: true }));

		binder.register("session-a");
		await binder.settled();
		expect(await recorded()).toEqual([]);
	});
});
