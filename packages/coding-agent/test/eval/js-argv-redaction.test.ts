import { describe, expect, it } from "bun:test";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";

/**
 * A JS eval cell that spawns a subprocess with a credential in argv used to leak
 * it into the transcript: Node bakes the whole joined argv into `Error.message`
 * for every `exec`/`execFile`/`execFileSync` failure, timeouts included, and the
 * worker forwarded that message verbatim as the cell's error.
 *
 * These tests drive the real `WorkerCore` error boundary — the code path that
 * produces the tool result — with sentinel data only.
 */
const SENTINEL_DSN =
	"postgres://sentinel_user:SENTINEL-P4ss-DO-NOT-USE@db.example.invalid:5432/sentineldb?sslmode=require";

interface WorkerHarness {
	run(code: string): Promise<Extract<WorkerOutbound, { type: "result" }>>;
	close(): void;
}

function createWorkerHarness(): WorkerHarness {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const transport: Transport = {
		send: message => {
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(message);
			});
		},
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	new WorkerCore(transport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	const send = (message: WorkerInbound): void => {
		queueMicrotask(() => {
			for (const listener of workerListeners) listener(message);
		});
	};
	const snapshot: SessionSnapshot = { cwd: process.cwd(), sessionId: "js-argv-redaction", localRoots: {} };
	send({ type: "init", snapshot });
	let cell = 0;
	return {
		async run(code) {
			const runId = `run-${++cell}`;
			const { promise, resolve } = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			const unsubscribe = ((): (() => void) => {
				const handler = (message: WorkerOutbound): void => {
					if (message.type !== "result" || message.runId !== runId) return;
					hostListeners.delete(handler);
					resolve(message);
				};
				hostListeners.add(handler);
				return () => hostListeners.delete(handler);
			})();
			try {
				send({ type: "run", runId, code, filename: `js-cell-${runId}.js`, snapshot });
				return await promise;
			} finally {
				unsubscribe();
			}
		},
		close: () => send({ type: "close" }),
	};
}

function errorText(result: Extract<WorkerOutbound, { type: "result" }>): string {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("unreachable");
	return `${result.error.message}\n${result.error.stack ?? ""}`;
}

describe("JS eval subprocess argv disclosure", () => {
	it("does not echo an undisclosed argv value when a subprocess times out", async () => {
		const harness = createWorkerHarness();
		try {
			// The DSN reaches argv through the environment, so its bytes were never
			// in the cell source and must not come back in the error.
			process.env.OMP_TEST_SENTINEL_DSN = SENTINEL_DSN;
			const result = await harness.run(`
				const { promisify } = await import("node:util");
				const cp = await import("node:child_process");
				await promisify(cp.execFile)("/bin/sh", ["-c", "sleep 30", process.env.OMP_TEST_SENTINEL_DSN], { timeout: 250 });
			`);
			const text = errorText(result);
			expect(text).not.toContain("SENTINEL");
			expect(text).not.toContain("sentinel");
			// Non-secret diagnostics survive: program, the literal arguments, and the
			// argument's length so the reader knows something was there.
			expect(text).toContain("/bin/sh -c sleep 30");
			expect(text).toContain(`<redacted:${SENTINEL_DSN.length}c>`);
		} finally {
			delete process.env.OMP_TEST_SENTINEL_DSN;
			harness.close();
		}
	});

	it("does not echo an undisclosed argv value when a subprocess exits non-zero", async () => {
		const harness = createWorkerHarness();
		try {
			process.env.OMP_TEST_SENTINEL_DSN = SENTINEL_DSN;
			const result = await harness.run(`
				const { promisify } = await import("node:util");
				const cp = await import("node:child_process");
				await promisify(cp.execFile)("/bin/sh", ["-c", "exit 7", process.env.OMP_TEST_SENTINEL_DSN]);
			`);
			const text = errorText(result);
			expect(text).not.toContain("SENTINEL");
			expect(text).toContain(`<redacted:${SENTINEL_DSN.length}c>`);
		} finally {
			delete process.env.OMP_TEST_SENTINEL_DSN;
			harness.close();
		}
	});

	it("renders an all-literal failing command in full", async () => {
		// The guard must be invisible when the cell source already disclosed every
		// argument; a feature that mangles ordinary diagnostics gets reverted.
		const harness = createWorkerHarness();
		try {
			const result = await harness.run(`
				const { promisify } = await import("node:util");
				const cp = await import("node:child_process");
				await promisify(cp.execFile)("/bin/sh", ["-c", "exit 7", "--marker=plain-literal"]);
			`);
			const text = errorText(result);
			expect(text).toContain("/bin/sh -c exit 7 --marker=plain-literal");
			expect(text).not.toContain("<redacted:");
		} finally {
			harness.close();
		}
	});

	it("treats a literal from an earlier cell of the same kernel as disclosed", async () => {
		const harness = createWorkerHarness();
		try {
			await harness.run(`globalThis.marker = "--from-an-earlier-cell";`);
			const result = await harness.run(`
				const { promisify } = await import("node:util");
				const cp = await import("node:child_process");
				await promisify(cp.execFile)("/bin/sh", ["-c", "exit 7", globalThis.marker]);
			`);
			const text = errorText(result);
			expect(text).toContain("--from-an-earlier-cell");
			expect(text).not.toContain("<redacted:");
		} finally {
			harness.close();
		}
	});

	it("leaves an ordinary cell error untouched", async () => {
		const harness = createWorkerHarness();
		try {
			const result = await harness.run(`throw new TypeError("no such method on /usr/bin/whatever");`);
			const text = errorText(result);
			expect(text).toContain("no such method on /usr/bin/whatever");
			expect(text).not.toContain("<redacted:");
		} finally {
			harness.close();
		}
	});

	it("still lets a cell disclose the invocation deliberately", async () => {
		// Redaction guards the accident, not the choice: a cell that catches the
		// error and prints `err.cmd` asked for it and still gets it.
		const harness = createWorkerHarness();
		try {
			process.env.OMP_TEST_SENTINEL_DSN = SENTINEL_DSN;
			const result = await harness.run(`
				const { promisify } = await import("node:util");
				const cp = await import("node:child_process");
				try {
					await promisify(cp.execFile)("/bin/sh", ["-c", "exit 7", process.env.OMP_TEST_SENTINEL_DSN]);
					throw new Error("expected the subprocess to fail");
				} catch (err) {
					throw new Error("deliberate: " + err.cmd.includes("SENTINEL-P4ss-DO-NOT-USE"));
				}
			`);
			expect(errorText(result)).toContain("deliberate: true");
		} finally {
			delete process.env.OMP_TEST_SENTINEL_DSN;
			harness.close();
		}
	});
});
