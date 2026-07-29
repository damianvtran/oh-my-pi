/**
 * Shared types for the mobile remote-access stack (`omp mobile`).
 *
 * Two services make every running omp session reachable from a phone: a
 * loopback collab relay that sessions host their rooms on, and a portal that
 * joins every published room as a guest and re-serves them as one authenticated
 * HTTP + SSE app. This module holds only the shapes both halves and the
 * management CLI agree on, so the service code, the launchd planner and the
 * status renderer never import each other.
 */

import type { CollabSessionState, CollabUiRequest } from "../collab/protocol";

/** The two managed services. `relay` is content-blind; `portal` holds the credential. */
export type MobileServiceName = "relay" | "portal";

/**
 * Everything needed to install, probe, control and describe one service. Built
 * by `buildLaunchPlan` from the ports plus the argv that re-enters this binary,
 * so the plist, the health probe and `omp mobile status` can never disagree
 * about where a service lives.
 */
export interface MobileServiceSpec {
	name: MobileServiceName;
	/** launchd job label, also the plist and log-file basename. */
	label: string;
	/** Full argv launchd runs, including the `caffeinate` wrapper. */
	argv: string[];
	plistPath: string;
	logs: { stdout: string; stderr: string };
	/** Seconds launchd waits before restarting a crashed job. */
	throttleSeconds: number;
	/** Loopback port the service listens on. */
	port: number;
	/** Unauthenticated health endpoint used by install, status and the startup healer. */
	healthUrl: string;
}

export interface MobileLaunchPlan {
	relay: MobileServiceSpec;
	portal: MobileServiceSpec;
}

/**
 * Installed-state record at `<config-root>/run/mobile/state.json`.
 *
 * It exists because the ports and the launch argv are decided at install time
 * and every later command needs them: `status` probes the right ports, the
 * startup healer knows which endpoints to poll, and `update` can rewrite the
 * plists without re-deriving anything. `enabled` is the deliberate off switch —
 * `omp mobile stop` clears it so a later `omp` launch does not resurrect
 * services the user just stopped.
 */
export interface MobileState {
	enabled: boolean;
	relayPort: number;
	portalPort: number;
	/** Portal login username; the password lives only in the Keychain. */
	username: string;
	/** argv prefix that re-enters this omp build (compiled binary, or `bun run <cli.ts>`). */
	launchArgv: string[];
	installedAt: string;
	updatedAt: string;
}

/** One probe result. `detail` carries the observed status code or payload for status output. */
export interface MobileProbe {
	ok: boolean;
	detail?: string;
}

/**
 * Health of both services from the outside. The portal's three probes are the
 * security-relevant ones: `/healthz` must answer, a browser navigation must
 * bounce to the login form, and the form itself must render — a portal that
 * serves the app to an anonymous navigation is a boundary failure, not a
 * cosmetic one.
 */
export interface MobileHealth {
	relay: MobileProbe;
	portalHealth: MobileProbe;
	portalLoginGate: MobileProbe;
	portalLoginPage: MobileProbe;
}

export interface MobileServiceStatus {
	name: MobileServiceName;
	label: string;
	/** launchd's own state word (`running`, `waiting`, …), or undefined when the job is not loaded. */
	launchState?: string;
	loaded: boolean;
	plistInstalled: boolean;
	port: number;
	logs: { stdout: string; stderr: string };
}

/** A live omp session discovered through its published collab room. */
export interface MobileSessionRow {
	pid: number;
	cwd: string;
	sessionId: string;
	startedAt: string;
	/** False when the record's owner is gone — a leftover from an abrupt exit. */
	alive: boolean;
	/** True when the record publishes a steerable link rather than view-only. */
	steerable: boolean;
}

export interface MobileStatusReport {
	installed: boolean;
	enabled: boolean;
	binary: { path: string; version: string; compiled: boolean };
	launchArgv: string[];
	settings: { autoStart: string; publishLink: boolean; relayUrl: string };
	/** True when `collab.relayUrl` points somewhere other than the relay this install runs. */
	relayUrlMismatch: boolean;
	passwordStored: boolean;
	services: MobileServiceStatus[];
	health: MobileHealth;
	sessions: MobileSessionRow[];
	/**
	 * Live omp sessions publishing no collab room, so the portal cannot see them.
	 * Discovered from the process table — nothing outside a session can make it
	 * host, so the only useful thing to do about one is report it.
	 */
	unregistered: { pid: number; command: string }[];
}

/**
 * Prefix of the one prompt the phone may hide from its transcript: the resume
 * instruction the play button sends after a stop. A stop on the phone is the
 * Escape key (an `abort` frame), not a process signal — the session stays
 * alive and simply has no turn running — so resuming is a new prompt that
 * tells the agent to pick its work back up.
 *
 * It is a real user message on purpose: the host, the session transcript and
 * any other guest all see exactly what drove the agent, and the TUI renders
 * it like any other prompt. Only the portal's projection drops it, and only
 * by this exact prefix — a "continue" the user types by hand never matches
 * and always stays visible.
 */
export const INTERNAL_RESUME_MARKER = "[omp-mobile:resume]";

/** The prompt the phone's resume button sends. */
export const INTERNAL_RESUME_PROMPT = `${INTERNAL_RESUME_MARKER} I paused you from my phone. Continue the work you were doing before the interruption.`;

/** Directory choices for the phone's new-session picker. */
export interface PortalDirectorySuggestions {
	/** The user's home directory, always available as the safe first-use default. */
	home: string;
	/** Existing working directories from recent omp sessions, newest first. */
	recent: string[];
}

/**
 * The portal's session-spawning surface, injectable so route tests never touch
 * the process table or the PTY layer. The real implementation is
 * `defaultPortalControl` in `control.ts`.
 */
export interface PortalControl {
	/**
	 * Validate the directory and spawn a session nanny in it, answering with the
	 * resolved absolute path so the phone remembers what the server used rather
	 * than what was typed. Throws with a phone-safe message on bad input.
	 */
	startSession(cwd: string): Promise<string>;
	/** Home plus recent session directories for the new-session picker. */
	listDirectories(): Promise<PortalDirectorySuggestions>;
}

// ── Portal view state ───────────────────────────────────────────────────────
// The portal keeps one of these per attached session and pushes them to the
// phone over SSE. They are UI projections, not protocol types: the phone renders
// TUI-shaped cards, so tool calls stay structured instead of flattened to text.

export type TranscriptItem =
	/** `from` names another room participant; absent when this portal sent it. */
	| { kind: "user"; text: string; from?: string }
	| { kind: "assistant"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; id: string; name: string; args: Record<string, unknown>; output?: string; isError?: boolean };

/**
 * Todo panel state, reusing the todo tool's own shape rather than a parallel
 * one: the phases arrive as `details.phases` on a `todo` tool result and the
 * phone renders `name`, so a second declaration here would only be a place for
 * the two to drift apart. `isTodoPhase` from the tool validates them.
 */
export type { TodoItem, TodoPhase } from "../tools/todo";

/**
 * What the agent is doing right now, mirroring the TUI's working line: omp
 * titles that line with a tool call's `intent` and shows streamed thinking
 * above it, and both ride frames a guest already receives.
 */
export interface PortalActivity {
	working: boolean;
	intent?: string;
	thinking?: string;
	/**
	 * The last completed turn ended on an abort (assistant `stopReason:
	 * "aborted"`), i.e. someone hit Escape or the phone's stop button. This is
	 * what gates the phone's resume button: ordinary idle means the turn
	 * finished and there is nothing to continue, so the composer alone shows.
	 */
	interrupted?: boolean;
}

/** Callbacks the portal installs on each guest. */
export interface PortalGuestEvents {
	onState?(state: CollabSessionState): void;
	onEntry?(): void;
	/**
	 * A `welcome` and its snapshot train finished, so every projection above was
	 * replaced wholesale. Fires on join and again whenever the host rebinds the
	 * room to another session (`collab.autoStart` rooms follow an in-session
	 * `/resume`) — the only signal that the transcript was replaced rather than
	 * appended to.
	 */
	onResync?(): void;
	onEvent?(event: { type: string }): void;
	onActivity?(activity: PortalActivity): void;
	onUiRequest?(request: CollabUiRequest): void;
	onUiRequestEnd?(reqId: number): void;
	onClose?(reason: string): void;
}
