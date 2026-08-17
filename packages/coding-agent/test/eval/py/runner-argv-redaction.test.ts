import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
	ename?: string;
	evalue?: string;
	traceback?: string[];
}

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const encoder = new TextEncoder();

/**
 * A credential-shaped value the cells only ever read from the environment, so
 * its bytes never appear in any cell source and the ledger must refuse to
 * render it. Not a real credential — the host is `.invalid`.
 */
const SENTINEL_DSN =
	"postgres://sentinel_user:SENTINEL-P4ss-DO-NOT-USE@db.example.invalid:5432/sentineldb?sslmode=require";

/** Run cells in order against one long-lived kernel; kernel state persists. */
async function runCells(codes: string[]): Promise<RunnerFrame[][]> {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			OMP_TEST_SENTINEL_DSN: SENTINEL_DSN,
		},
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				return JSON.parse(line) as RunnerFrame;
			}
			const { value, done } = await reader.read();
			if (done) {
				throw new Error(`Python runner exited before done frame: ${await stderr}`);
			}
			pending += decoder.decode(value, { stream: true });
		}
	}

	try {
		const cells: RunnerFrame[][] = [];
		for (const [index, code] of codes.entries()) {
			proc.stdin.write(encoder.encode(`${JSON.stringify({ id: `r${index + 1}`, code })}\n`));
			proc.stdin.flush();
			const frames: RunnerFrame[] = [];
			while (true) {
				const frame = await readFrame();
				frames.push(frame);
				if (frame.type === "done") break;
			}
			cells.push(frames);
		}
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		}
		return cells;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released by stream closure.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

function errorFrame(frames: RunnerFrame[]): RunnerFrame {
	const frame = frames.find(candidate => candidate.type === "error");
	if (frame === undefined) throw new Error(`no error frame: ${JSON.stringify(frames)}`);
	return frame;
}

/** Everything the host would surface for an error: value plus traceback text. */
function errorText(frames: RunnerFrame[]): string {
	const frame = errorFrame(frames);
	return `${frame.evalue ?? ""}\n${(frame.traceback ?? []).join("\n")}`;
}

function stdoutText(frames: RunnerFrame[]): string {
	return frames
		.filter(frame => frame.type === "stdout")
		.map(frame => frame.data ?? "")
		.join("");
}

const readSentinel = ["import os, subprocess", 'dsn = os.environ["OMP_TEST_SENTINEL_DSN"]'].join("\n");

describe.skipIf(process.platform === "win32")("Python runner argv disclosure gating", () => {
	it("redacts an undisclosed argv element from a subprocess timeout", async () => {
		const [cell] = await runCells([
			[readSentinel, 'subprocess.run(["/bin/sh", "-c", "sleep 30", dsn], timeout=0.4)'].join("\n"),
		]);
		const frame = errorFrame(cell as RunnerFrame[]);
		const text = errorText(cell as RunnerFrame[]);

		expect(text).not.toContain(SENTINEL_DSN);
		expect(text).not.toContain("SENTINEL-P4ss");
		expect(frame.ename).toBe("TimeoutExpired");
		expect(frame.evalue).toContain("/bin/sh");
		expect(frame.evalue).toContain(`<redacted:${SENTINEL_DSN.length}c>`);
		expect(frame.evalue).toContain("timed out after 0.4 seconds");
	});

	it("redacts an undisclosed argv element from a non-zero exit and keeps the exit code", async () => {
		const [cell] = await runCells([
			[readSentinel, 'subprocess.run(["/bin/sh", "-c", "exit 7", dsn], check=True)'].join("\n"),
		]);
		const frame = errorFrame(cell as RunnerFrame[]);

		expect(errorText(cell as RunnerFrame[])).not.toContain("SENTINEL-P4ss");
		expect(frame.ename).toBe("CalledProcessError");
		expect(frame.evalue).toBe(
			`Command '['/bin/sh', '-c', 'exit 7', '<redacted:${SENTINEL_DSN.length}c>']' returned non-zero exit status 7.`,
		);
	});

	it("leaves a fully disclosed argv rendered in full", async () => {
		const [cell] = await runCells([
			["import subprocess", 'subprocess.run(["/bin/sh", "-c", "exit 3"], check=True)'].join("\n"),
		]);
		const frame = errorFrame(cell as RunnerFrame[]);

		expect(frame.evalue).toBe("Command '['/bin/sh', '-c', 'exit 3']' returned non-zero exit status 3.");
		expect(errorText(cell as RunnerFrame[])).not.toContain("<redacted:");
	});

	it("renders a literal disclosed by an earlier cell of the same session", async () => {
		const cells = await runCells([
			'import subprocess\nlater_arg = "SENTINEL-literal-written-in-cell-one"',
			'subprocess.run(["/bin/sh", "-c", "exit 4", later_arg], check=True)',
		]);
		const frame = errorFrame(cells[1] as RunnerFrame[]);

		expect(frame.evalue).toBe(
			"Command '['/bin/sh', '-c', 'exit 4', 'SENTINEL-literal-written-in-cell-one']' returned non-zero exit status 4.",
		);
		expect(frame.evalue).not.toContain("<redacted:");
	});

	it("leaves an ordinary exception untouched", async () => {
		const [cell] = await runCells(['raise ValueError("SENTINEL-plain-value-error /bin/sh -c oops")']);
		const frame = errorFrame(cell as RunnerFrame[]);

		expect(frame.ename).toBe("ValueError");
		expect(frame.evalue).toBe("SENTINEL-plain-value-error /bin/sh -c oops");
		expect(errorText(cell as RunnerFrame[])).not.toContain("<redacted:");
	});

	it("leaves a deliberate print of the invocation alone", async () => {
		const [cell] = await runCells([
			[
				readSentinel,
				"try:",
				'    subprocess.run(["/bin/sh", "-c", "exit 5", dsn], check=True)',
				"except subprocess.CalledProcessError as exc:",
				'    print("caught=" + repr(exc.cmd))',
			].join("\n"),
		]);

		expect(cell?.at(-1)?.status).toBe("ok");
		expect(stdoutText(cell as RunnerFrame[])).toContain(`caught=['/bin/sh', '-c', 'exit 5', '${SENTINEL_DSN}']`);
	});

	it("restores the live exception after emitting a redacted error", async () => {
		const cells = await runCells([
			[
				readSentinel,
				"try:",
				'    subprocess.run(["/bin/sh", "-c", "exit 6", dsn], check=True)',
				"except subprocess.CalledProcessError as exc:",
				"    kept = exc",
				"    raise",
			].join("\n"),
			'print("cmd=" + repr(kept.cmd) + " args=" + repr(kept.args))',
		]);

		expect(errorFrame(cells[0] as RunnerFrame[]).evalue).toContain(`<redacted:${SENTINEL_DSN.length}c>`);
		const restored = stdoutText(cells[1] as RunnerFrame[]);
		expect(restored).toContain(`cmd=['/bin/sh', '-c', 'exit 6', '${SENTINEL_DSN}']`);
		expect(restored).toContain(`args=(6, ['/bin/sh', '-c', 'exit 6', '${SENTINEL_DSN}'])`);
	});
});
