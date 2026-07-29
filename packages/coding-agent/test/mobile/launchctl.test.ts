/**
 * Contract for the two shell-outs the mobile stack cannot avoid.
 *
 * `launchctl bootout` returns when launchd has *accepted* the unload, not when
 * the job is gone, so a reload that boots out and immediately bootstraps loses
 * the race and fails with `EEXIST` — which is not a cosmetic failure: it leaves
 * both services down after an `omp mobile update`, exactly how this was found.
 * The retry/settle behaviour is therefore asserted here rather than trusted.
 *
 * The second contract is about secrecy: the portal password must never appear in
 * a process argument list, because argv is world-readable through `ps` for the
 * lifetime of the call.
 *
 * `ptree.exec` is spied on rather than really invoking `launchctl`: the point is
 * this module's own sequencing, and a test that loaded real LaunchAgents would
 * mutate the developer's machine.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	bootoutService,
	bootstrapService,
	LAUNCHD_EEXIST,
	readKeychainPassword,
	submitSessionHostJob,
	writeKeychainPassword,
} from "@oh-my-pi/pi-coding-agent/mobile/launchctl";
import { ptree } from "@oh-my-pi/pi-utils";

interface ExecCall {
	command: string[];
	/** Whatever was handed to the child's stdin, read through ptree's real option name. */
	input?: string;
}

/**
 * Script `ptree.exec` per invocation, recording what was asked for.
 *
 * The recorded field is read as `ExecOptions["input"]`, typed against ptree's own
 * interface rather than a hand-written shape. That matters: the first version of
 * this module passed the secret as `stdin`, which `ExecOptions` does not accept —
 * an object spread hid it from the type checker and a loosely-typed stub hid it
 * from this test, so the password write only failed when a human ran it. Reading
 * the real option makes the same mistake fail here.
 */
function stubExec(handler: (call: ExecCall, index: number) => { exitCode?: number; stdout?: string; stderr?: string }) {
	const calls: ExecCall[] = [];
	spyOn(ptree, "exec").mockImplementation(((command: string[], options?: ptree.ExecOptions) => {
		const input = options?.input;
		const call: ExecCall = { command, input: typeof input === "string" ? input : input?.toString() };
		const result = handler(call, calls.length);
		calls.push(call);
		return Promise.resolve({
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
			ok: (result.exitCode ?? 0) === 0,
		});
	}) as unknown as typeof ptree.exec);
	return calls;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("bootstrapService", () => {
	it("retries EEXIST until launchd has forgotten the old job", async () => {
		// launchd's teardown is asynchronous: the first bootstrap still sees the old
		// job, one `print` still finds it, and only once `print` fails is a second
		// bootstrap allowed to win.
		let printsRemaining = 1;
		const calls = stubExec(call => {
			const verb = call.command[1];
			if (verb === "print") {
				if (printsRemaining > 0) {
					printsRemaining--;
					return { stdout: "state = running" };
				}
				return { exitCode: 113, stderr: "Could not find service" };
			}
			// First bootstrap collides, the one after the job disappears succeeds.
			return calls.filter(entry => entry.command[1] === "bootstrap").length === 0
				? { exitCode: LAUNCHD_EEXIST, stderr: "Bootstrap failed: 5: Input/output error" }
				: {};
		});

		const result = await bootstrapService("/tmp/sh.omp.mobile-portal.plist", "sh.omp.mobile-portal");

		expect(result.ok).toBe(true);
		expect(calls.filter(call => call.command[1] === "bootstrap")).toHaveLength(2);
		// It must not blind-retry: the second attempt only happens after a `print`
		// confirms the label is gone.
		expect(calls.some(call => call.command[1] === "print")).toBe(true);
	});

	it("reports a non-EEXIST failure immediately instead of spinning", async () => {
		const calls = stubExec(() => ({ exitCode: 112, stderr: "Operation not permitted" }));

		const result = await bootstrapService("/tmp/x.plist", "sh.omp.mobile-portal");

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(112);
		expect(calls).toHaveLength(1);
	});
});

describe("bootoutService", () => {
	it("returns only once the label is gone, so a following bootstrap cannot race it", async () => {
		let printsRemaining = 2;
		const calls = stubExec(call => {
			if (call.command[1] !== "print") return {};
			if (printsRemaining > 0) {
				printsRemaining--;
				return { stdout: "state = running" };
			}
			return { exitCode: 113, stderr: "Could not find service" };
		});

		const result = await bootoutService("sh.omp.mobile-relay");

		expect(result.ok).toBe(true);
		expect(calls[0]?.command[1]).toBe("bootout");
		// Polled until the job disappeared rather than returning on the first answer.
		expect(calls.filter(call => call.command[1] === "print").length).toBeGreaterThanOrEqual(3);
	});
});

describe("submitSessionHostJob", () => {
	it("creates a self-removing sibling job without interpolating command arguments into shell source", async () => {
		const calls = stubExec(() => ({}));
		const label = "sh.omp.mobile-session.123.example";
		const command = ["/usr/bin/caffeinate", "-dims", "/tmp/omp $(touch nope)", "mobile", "host", "--cwd", "/tmp/a b"];

		const result = await submitSessionHostJob(label, command);

		expect(result.ok).toBe(true);
		const submitted = calls[0]?.command ?? [];
		expect(submitted.slice(0, 7)).toEqual(["/bin/launchctl", "submit", "-l", label, "--", "/bin/sh", "-c"]);
		expect(submitted[7]).toContain('"$@"');
		expect(submitted[7]).toContain('remove "$label"');
		expect(submitted[7]).not.toContain(command[2]);
		expect(submitted.slice(8)).toEqual(["omp-mobile-host-job", label, ...command]);
	});
});

describe("portal password storage", () => {
	it("never puts the secret in argv", async () => {
		const secret = "s3cret-value-not-in-ps";
		const calls = stubExec(() => ({}));

		await writeKeychainPassword(secret, "tester");

		const call = calls[0];
		expect(call?.command).toEqual(["/usr/bin/security", "-i"]);
		// `security -i` reads its command line from stdin, so the secret only ever
		// exists on a pipe. Anything else would be readable via `ps`.
		expect(call?.command.join(" ")).not.toContain(secret);
		expect(call?.input).toContain(secret);
		expect(call?.input).toContain("add-generic-password");
		expect(call?.input).toContain('"tester"');
		expect(call?.input).toContain('"omp-mobile"');
		// `security -i` reads one command per line, so the newline is what makes it execute.
		expect(call?.input?.endsWith("\n")).toBe(true);
	});

	it("escapes a password that would otherwise break out of the security command line", async () => {
		const calls = stubExec(() => ({}));

		await writeKeychainPassword('a"b\\c', "tester");

		// `security -i` parses its own mini command line, so an unescaped quote would
		// terminate the argument and the rest would be read as further arguments.
		expect(calls[0]?.input).toContain('"a\\"b\\\\c"');
	});

	it("treats a missing Keychain item as absent rather than an error", async () => {
		stubExec(() => ({ exitCode: 44, stderr: "SecKeychainSearchCopyNext: The specified item could not be found" }));
		expect(await readKeychainPassword("tester")).toBeUndefined();
	});

	it("trims the trailing newline security prints after the password", async () => {
		stubExec(() => ({ stdout: "hunter2\n" }));
		expect(await readKeychainPassword("tester")).toBe("hunter2");
	});
});
