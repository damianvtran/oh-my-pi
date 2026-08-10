/**
 * Disclosure-gated redaction of process-invocation text in error rendering.
 *
 * ## Why this exists
 *
 * A tool or eval cell that spawns a subprocess routinely puts a credential in
 * argv (`psql <dsn>`, `mongosh <uri>`, `curl -H "Authorization: …"`). Every
 * runtime we host re-renders that argv when the spawn fails, and none of them
 * knows an argument is a secret:
 *
 * - Node writes `Command failed: <joined argv>` into `Error.message` for
 *   `exec`/`execFile`/`execFileSync` — on non-zero exit *and* on timeout.
 * - Python's `subprocess.TimeoutExpired.__str__` interpolates `self.cmd`.
 * - Julia's `showerror` prints the whole `Cmd` for `ProcessFailedException`.
 *
 * The exception escapes to the tool result, so the credential lands in the
 * agent transcript and in the session file on disk even though the agent asked
 * for none of it. A timing-out subprocess is the worst case: the agent gets no
 * useful output, only an error whose one piece of content is the argv it must
 * not see.
 *
 * ## The rule: prior disclosure, not secret detection
 *
 * Guessing which argv elements "look like" secrets fails in both directions —
 * it misses bespoke credential formats and mangles innocent arguments. So gate
 * on *prior disclosure* instead: an argument is rendered only when its exact
 * bytes already appear in code the agent itself wrote. Those bytes are already
 * in the transcript, so re-rendering them discloses nothing new. Everything
 * else — a value read from the environment, a file, an API response, or a
 * session credential that `deobfuscateToolArguments` substituted into the tool
 * call — is replaced by {@link redactedArg}, which keeps only its length.
 *
 * This needs no secret detector to be correct, and it keeps the diagnostics
 * that actually matter: `['git', 'status']` still renders in full, and so do
 * the program, the argument count, the exit code, the signal and the timeout.
 *
 * The one deliberate exception is **argv[0]**, which is always rendered: an
 * executable path is the single most useful piece of a spawn failure, it is not
 * a credential, and the runtime resolves it (`"sh"` → `/bin/sh`) so it often
 * fails a literal disclosure check that the agent's own source should pass.
 *
 * ## Scope
 *
 * This covers the *accidental* path — an exception nobody chose to print. Code
 * that deliberately renders a value (`display(err.cmd)`, `console.error(err)`,
 * `print(dsn)`) is an explicit disclosure and is left alone, exactly like any
 * other deliberate print of a secret.
 *
 * The ledger is fed the source **as executed**, which is one step past what the
 * transcript holds: `deobfuscateToolArguments` substitutes registered secrets
 * into a tool call's arguments just before the tool runs, so a credential the
 * agent referenced as `$$KEY_<hmac>$$` inside cell code arrives here as raw
 * bytes and therefore counts as disclosed. That case is not this module's to
 * close — it is the pre-existing behaviour that tool results echo deobfuscated
 * arguments at all, which `bash` shares (it renders its `command` verbatim) —
 * and the obfuscator still re-masks those values at the provider boundary, so
 * the model does not see them. Every value the harness has *not* been told
 * about, which is the case that caused this module to exist, is covered.
 *
 * The Python and Julia runners implement the same rule in their own languages
 * (they run out of process, so they cannot import this module); keep
 * {@link REDACTED_ARG_PATTERN} and the rendering in sync when changing either.
 */

/** Cell sources retained for disclosure checks, newest last. */
const LEDGER_MAX_ENTRIES = 64;

/** Total bytes of retained cell source. Bounds a long-lived kernel's ledger. */
const LEDGER_MAX_BYTES = 256 * 1024;

/**
 * Matches the rendering used for an argument whose bytes were never disclosed
 * to the transcript: `<redacted:71c>`. Deliberately space-free so it reads as a
 * single token inside a rendered command line, and length-only so it carries no
 * bytes of the value — not even a digest, which would be a (small) partial
 * oracle on a secret. The Python and Julia runners emit the same shape.
 */
export const REDACTED_ARG_PATTERN = /<redacted:\d+c>/;

/**
 * Bounded record of the code an agent has run in one kernel, used to decide
 * whether re-rendering a string discloses anything new.
 *
 * A persistent kernel keeps state across cells, so a literal written in cell 1
 * can reach argv in cell 5; checking only the failing cell would redact values
 * that are plainly visible in the transcript. Retention is bounded because a
 * long session's cell history is otherwise unbounded, and an evicted entry only
 * costs fidelity (over-redaction), never safety.
 */
export class ArgvDisclosureLedger {
	#entries: string[] = [];
	#bytes = 0;

	/** Record cell source as disclosed to the transcript. */
	record(source: string): void {
		if (source.length === 0) return;
		this.#entries.push(source);
		this.#bytes += source.length;
		while (
			this.#entries.length > LEDGER_MAX_ENTRIES ||
			(this.#bytes > LEDGER_MAX_BYTES && this.#entries.length > 1)
		) {
			const evicted = this.#entries.shift();
			if (evicted === undefined) break;
			this.#bytes -= evicted.length;
		}
	}

	/**
	 * True when `text`'s exact bytes already appear in recorded source. Substring
	 * containment is the right test and not a weakening: a match means those
	 * bytes are literally present in code the agent wrote.
	 */
	discloses(text: string): boolean {
		if (text.length === 0) return true;
		for (const entry of this.#entries) {
			if (entry.includes(text)) return true;
		}
		return false;
	}
}

/** A whitespace run, or one argument with its original (possibly quoted) spelling. */
type CommandPiece = { gap: string } | { raw: string; value: string };

/**
 * Split a rendered command line into arguments, honouring single and double
 * quotes so a quoted argument stays one piece.
 *
 * Quote awareness is fidelity, not safety: without it `sh -c 'exit 3'` splits
 * into `'exit` and `3'`, neither of which matches the agent's `"exit 3"`
 * literal, and a perfectly innocent command line comes back half-redacted.
 * Unbalanced quotes simply run to end of input — the worst case is one large
 * piece, which fails the disclosure check and over-redacts.
 */
function splitCommandLine(line: string): CommandPiece[] {
	const pieces: CommandPiece[] = [];
	let index = 0;
	while (index < line.length) {
		const wsStart = index;
		while (index < line.length && /\s/.test(line[index] as string)) index++;
		if (index > wsStart) pieces.push({ gap: line.slice(wsStart, index) });
		if (index >= line.length) break;
		const rawStart = index;
		let value = "";
		while (index < line.length && !/\s/.test(line[index] as string)) {
			const ch = line[index] as string;
			if (ch === "'" || ch === '"') {
				const close = line.indexOf(ch, index + 1);
				const end = close === -1 ? line.length : close;
				value += line.slice(index + 1, end);
				index = close === -1 ? line.length : close + 1;
				continue;
			}
			value += ch;
			index++;
		}
		pieces.push({ raw: line.slice(rawStart, index), value });
	}
	return pieces;
}

/**
 * Redact every argument of a rendered command line whose bytes the ledger has
 * not seen. argv[0] is preserved verbatim (see the module comment); original
 * spacing and quoting of preserved arguments are kept so an all-disclosed
 * command line comes back byte-identical.
 */
export function redactCommandLine(line: string, ledger?: ArgvDisclosureLedger): string {
	const pieces = splitCommandLine(line);
	let seenArg = false;
	let out = "";
	for (const piece of pieces) {
		if ("gap" in piece) {
			out += piece.gap;
			continue;
		}
		if (!seenArg) {
			seenArg = true;
			out += piece.raw;
			continue;
		}
		out += ledger?.discloses(piece.value) ? piece.raw : `<redacted:${piece.value.length}c>`;
	}
	return out;
}

/** Prefix Node uses for every `exec`/`execFile`/`execFileSync` failure message. */
const NODE_COMMAND_FAILED_PREFIX = "Command failed: ";

/**
 * True when `error` is a failed process invocation whose rendering embeds argv.
 *
 * Gating matters: the token filter must never touch an ordinary error, whose
 * message legitimately contains words (`posix_spawn`, a type name, a file path)
 * that no cell source mentions. The two markers below are Node's own, not
 * guesses about content — `cmd` is the property `child_process` attaches to
 * exec-family errors, and `Command failed: ` is the literal prefix it builds
 * for both the async and sync variants.
 */
function processInvocationCommand(error: Error): string | undefined {
	const carrier = "cmd" in error ? error.cmd : undefined;
	if (typeof carrier === "string" && carrier.length > 0) return carrier;
	if (error.message.startsWith(NODE_COMMAND_FAILED_PREFIX)) {
		const rest = error.message.slice(NODE_COMMAND_FAILED_PREFIX.length);
		const end = rest.indexOf("\n");
		const command = end === -1 ? rest : rest.slice(0, end);
		return command.length > 0 ? command : undefined;
	}
	return undefined;
}

/**
 * Display strings for `error` with any embedded process invocation redacted.
 *
 * Returns the originals untouched when the error is not a process invocation,
 * so this is safe to call on every error at a serialization boundary. The live
 * error object is never mutated: cell code may still be holding it, and
 * silently rewriting `err.cmd` under a `catch` block would be a surprise.
 */
export function redactProcessInvocation(
	error: Error,
	ledger?: ArgvDisclosureLedger,
): { message: string; stack?: string } {
	const command = processInvocationCommand(error);
	if (command === undefined) return { message: error.message, stack: error.stack };
	const redacted = redactCommandLine(command, ledger);
	if (redacted === command) return { message: error.message, stack: error.stack };
	const message = error.message.replaceAll(command, redacted);
	// The stack's first line is `${name}: ${message}`, so the same substitution
	// covers it; frame lines never contain argv and are left alone.
	const stack = error.stack?.replaceAll(command, redacted);
	return { message, stack };
}
