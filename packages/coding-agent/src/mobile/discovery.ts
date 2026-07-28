/**
 * Finding the omp sessions on this machine.
 *
 * The portal aggregates a session by joining its collab room, and it can only do
 * that with the room key — which lives in the record the host publishes to
 * `<config-root>/run/collab/<pid>.json`. **The relay cannot help here**: it
 * forwards sealed frames and never sees a key, which is the end-to-end property
 * of the whole design, so "ask the relay what rooms exist and join them" is not
 * something we are choosing not to do — it is cryptographically impossible. The
 * published record is the discovery channel, and the portal watches it.
 *
 * That leaves one blind spot this module covers: a session that is running but
 * publishing nothing (started before the services existed, or with
 * `collab.autoStart` off) is invisible to the portal, and from the phone it looks
 * indistinguishable from a session that is not running. Nothing outside a
 * session can make it start hosting — an interactive TUI has no control channel —
 * so the honest answer is to *notice* it and say so, which is what
 * {@link findUnregisteredSessions} exists for.
 */

import * as path from "node:path";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import { commands } from "../cli-commands";

/** One omp process seen in the process table. */
export interface LocalOmpProcess {
	pid: number;
	/** Full command line, for a status line that has to explain which session this is. */
	command: string;
}

/**
 * `ps` fields, in order: pid then the full argv. `-o args=` suppresses the header
 * so every line is data, and `-A` is every process the user can see — omp runs
 * unprivileged, so a session it could aggregate is always visible here.
 */
const PS_ARGV = ["/bin/ps", "-Ao", "pid=,args="] as const;
const PS_TIMEOUT_MS = 5_000;

/**
 * Every registered subcommand name plus their aliases. An interactive session is
 * `omp` with no subcommand (optionally followed by a prompt or flags), so the
 * presence of one of these words in first position is what separates a session
 * from a management invocation — including this process and the two services.
 * Derived from the command registry rather than a hand-kept list, so a new
 * subcommand cannot start showing up as a phantom session.
 */
function subcommandNames(): Set<string> {
	const names = new Set<string>();
	for (const entry of commands) {
		names.add(entry.name);
		for (const alias of entry.aliases ?? []) names.add(alias);
	}
	return names;
}

/**
 * Parse `ps -Ao pid=,args=` output into the omp *sessions* running as this user.
 *
 * Exported for tests: spawning `ps` proves nothing about the classification, and
 * the classification is the part that is easy to get wrong.
 *
 * A line qualifies when the executable's basename is `omp` (that is the name omp
 * gives its own processes) and the first argument is not a subcommand. Both
 * halves matter: without the basename check a `grep omp` in someone's pipeline
 * counts, and without the subcommand check the portal, the relay, and whatever
 * `omp mobile status` you are currently running all count as sessions.
 */
export function parseOmpSessionProcesses(
	psOutput: string,
	options: { selfPid?: number; subcommands?: Set<string> } = {},
): LocalOmpProcess[] {
	const selfPid = options.selfPid ?? process.pid;
	const subcommands = options.subcommands ?? subcommandNames();
	const found: LocalOmpProcess[] = [];
	for (const line of psOutput.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const split = trimmed.indexOf(" ");
		if (split <= 0) continue;
		const pid = Number.parseInt(trimmed.slice(0, split), 10);
		if (!Number.isInteger(pid) || pid === selfPid) continue;
		const command = trimmed.slice(split + 1).trim();
		if (command.length === 0) continue;
		// argv[0] only: a prompt like `omp "fix the omp build"` must not be parsed
		// as if its words were arguments.
		const argv = command.split(/\s+/);
		const executable = argv[0];
		if (executable === undefined) continue;
		if (path.basename(executable) !== "omp") continue;
		const firstArg = argv[1];
		if (firstArg !== undefined && subcommands.has(firstArg)) continue;
		found.push({ pid, command });
	}
	return found;
}

/**
 * omp sessions running on this machine, or an empty list when the process table
 * cannot be read. Never throws: this feeds a status report, and a machine where
 * `ps` misbehaves should still get the rest of the report.
 */
export async function listLocalOmpSessions(): Promise<LocalOmpProcess[]> {
	try {
		const result = await ptree.exec([...PS_ARGV], {
			signal: ptree.combineSignals(PS_TIMEOUT_MS),
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		if (result.exitCode !== 0) {
			logger.debug("mobile: ps returned non-zero while listing sessions", { exitCode: result.exitCode });
			return [];
		}
		return parseOmpSessionProcesses(result.stdout);
	} catch (err) {
		logger.debug("mobile: failed to list local omp sessions", { error: String(err) });
		return [];
	}
}

/**
 * Live omp sessions that publish no collab room, i.e. the ones the portal cannot
 * see. `registeredPids` are the owners of the records in the link directory.
 *
 * A session lands here for one of two reasons, and both are worth telling the
 * user about because both have a fix: it started before the relay was installed
 * (restart it, or type `/collab`), or `collab.autoStart` is off (turn it on).
 */
export async function findUnregisteredSessions(registeredPids: readonly number[]): Promise<LocalOmpProcess[]> {
	const registered = new Set(registeredPids);
	const sessions = await listLocalOmpSessions();
	return sessions.filter(session => !registered.has(session.pid));
}
