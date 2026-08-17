import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "../../src/eval/jl/executor";

const HAS_JULIA = Boolean($which("julia"));
const OWNER_ID = "julia-argv-redaction-tests";

/**
 * Sentinel credential. It is never written into cell source in the tests that
 * expect redaction — it reaches argv only through a file read, which is exactly
 * the "value the agent never disclosed" case the guard exists for.
 */
const SENTINEL_DSN =
	"postgres://sentinel_user:SENTINEL-P4ss-DO-NOT-USE@db.example.invalid:5432/sentineldb?sslmode=require";
const SENTINEL_FRAGMENT = "SENTINEL-P4ss";
const REDACTED_DSN = `<redacted:${SENTINEL_DSN.length}c>`;

/** Write the sentinel where a cell can read it, and hand back a Julia string literal for the path. */
async function seedSecretFile(dir: string): Promise<string> {
	const file = path.join(dir, "dsn.txt");
	await Bun.write(file, SENTINEL_DSN);
	return JSON.stringify(file);
}

describe.skipIf(!HAS_JULIA)("eval Julia process-invocation redaction", () => {
	afterEach(async () => {
		await disposeJuliaKernelSessionsByOwner(OWNER_ID);
	}, 30_000);

	it("redacts an undisclosed argument from a failed process, keeping program and exit code", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-exit-");
		const secretPath = await seedSecretFile(tempDir.path());

		const result = await executeJulia(`dsn = read(${secretPath}, String)\nrun(\`/bin/sh -c "exit 3" $dsn\`)`, {
			cwd: tempDir.path(),
			sessionId: `julia-argv-exit:${crypto.randomUUID()}`,
			kernelOwnerId: OWNER_ID,
			reset: true,
		});

		expect(result.output).not.toContain(SENTINEL_FRAGMENT);
		expect(result.output).toContain(REDACTED_DSN);
		// argv[0] and the disclosed literals stay; so does the failure detail.
		expect(result.output).toContain("/bin/sh");
		expect(result.output).toContain("'exit 3'");
		expect(result.output).toContain("ProcessExited(3)");
		expect(result.output).toContain("failed process");
	}, 60_000);

	it("redacts an undisclosed argument from a spawn failure IOError", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-spawn-");
		const secretPath = await seedSecretFile(tempDir.path());

		const result = await executeJulia(`dsn = read(${secretPath}, String)\nrun(\`/nope/omp-missing-binary $dsn\`)`, {
			cwd: tempDir.path(),
			sessionId: `julia-argv-spawn:${crypto.randomUUID()}`,
			kernelOwnerId: OWNER_ID,
			reset: true,
		});

		expect(result.output).not.toContain(SENTINEL_FRAGMENT);
		expect(result.output).toContain(REDACTED_DSN);
		expect(result.output).toContain("/nope/omp-missing-binary");
		// The libuv diagnosis is not part of the invocation and must survive.
		expect(result.output).toContain("ENOENT");
	}, 60_000);

	it("redacts an undisclosed setenv entry, which renders inside the same Cmd as argv", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-env-");
		const secretPath = await seedSecretFile(tempDir.path());

		const result = await executeJulia(
			`dsn = read(${secretPath}, String)\nrun(setenv(\`/bin/sh -c "exit 3"\`, "SECRET" => dsn))`,
			{
				cwd: tempDir.path(),
				sessionId: `julia-argv-env:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER_ID,
				reset: true,
			},
		);

		expect(result.output).not.toContain(SENTINEL_FRAGMENT);
		// The whole `SECRET=<dsn>` entry is one undisclosed string.
		expect(result.output).toContain(`<redacted:${`SECRET=${SENTINEL_DSN}`.length}c>`);
		expect(result.output).toContain("ProcessExited(3)");
	}, 60_000);

	it("does not permanently mutate the exception it redacted", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-restore-");
		const secretPath = await seedSecretFile(tempDir.path());
		const sessionId = `julia-argv-restore:${crypto.randomUUID()}`;

		const failing = await executeJulia(
			`dsn = read(${secretPath}, String)\ntry\n  run(\`/bin/sh -c "exit 3" $dsn\`)\ncatch err\n  global kept = err\n  rethrow()\nend`,
			{ cwd: tempDir.path(), sessionId, kernelOwnerId: OWNER_ID, reset: true },
		);
		expect(failing.output).not.toContain(SENTINEL_FRAGMENT);
		expect(failing.output).toContain(REDACTED_DSN);

		const inspect = await executeJulia('println("KEPT=", kept.procs[1].cmd)', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER_ID,
		});

		// The redaction is a swap held only for the duration of `showerror`.
		// Cell code still holding the exception sees its real `Cmd`, and a cell
		// that deliberately prints it is making an explicit disclosure.
		expect(inspect.output).toContain(`KEPT=\`/bin/sh -c 'exit 3' '${SENTINEL_DSN}'\``);
	}, 90_000);

	it("renders an all-literal failing command in full", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-literal-");

		const result = await executeJulia('run(`/bin/sh -c "exit 7" omp-literal-argument`)', {
			cwd: tempDir.path(),
			sessionId: `julia-argv-literal:${crypto.randomUUID()}`,
			kernelOwnerId: OWNER_ID,
			reset: true,
		});

		// Nothing here was undisclosed, so the guard must be invisible.
		expect(result.output).not.toContain("<redacted:");
		expect(result.output).toContain("/bin/sh -c 'exit 7' omp-literal-argument");
		expect(result.output).toContain("ProcessExited(7)");
	}, 60_000);

	it("keeps a literal disclosed in an earlier cell of the same kernel session", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-crosscell-");
		const sessionId = `julia-argv-crosscell:${crypto.randomUUID()}`;
		const literal = "OMP-CROSS-CELL-LITERAL-9f2a";

		const first = await executeJulia(`carried = "${literal}"\nnothing`, {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER_ID,
			reset: true,
		});
		expect(first.exitCode).toBe(0);

		const second = await executeJulia('run(`/bin/sh -c "exit 5" $carried`)', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER_ID,
		});

		// The ledger spans cells, so a value the agent typed in cell 1 is still
		// disclosed when cell 2 puts it in argv.
		expect(second.output).toContain(literal);
		expect(second.output).not.toContain("<redacted:");
		expect(second.output).toContain("ProcessExited(5)");
	}, 90_000);

	it("leaves a non-process exception untouched even when it carries undisclosed text", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-argv-plain-");
		const file = path.join(tempDir.path(), "note.txt");
		await Bun.write(file, "OMP-NOT-A-PROCESS-INVOCATION");

		const result = await executeJulia(
			`note = read(${JSON.stringify(file)}, String)\nerror("connection to $note failed")`,
			{
				cwd: tempDir.path(),
				sessionId: `julia-argv-plain:${crypto.randomUUID()}`,
				kernelOwnerId: OWNER_ID,
				reset: true,
			},
		);

		// The filter is gated on Julia's own process-failure markers, so an
		// ordinary error renders exactly as Julia wrote it.
		expect(result.output).toContain("connection to OMP-NOT-A-PROCESS-INVOCATION failed");
		expect(result.output).not.toContain("<redacted:");
	}, 60_000);
});
