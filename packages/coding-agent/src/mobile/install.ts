/**
 * Install, control and describe the mobile stack.
 *
 * One command has to leave the machine in a state where a phone reaches every
 * omp session: two LaunchAgents loaded and healthy, a portal credential in the
 * Keychain, and the three collab settings that make sessions publish rooms at
 * all. Doing that in one place is what keeps the pieces consistent — the ports
 * baked into the plists, recorded in the install state, used by the health
 * probes, and reported by `status` are all the same numbers.
 *
 * Everything is idempotent: re-running install rewrites the plists, reloads the
 * jobs, and leaves an existing password and a deliberate `view` share alone.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, procmgr, ptree, VERSION } from "@oh-my-pi/pi-utils";
import { type CollabLinkRecord, collabLinkDir } from "../collab/link-file";
import { Settings, settings } from "../config/settings";
import { probeMobileHealth, waitForHealthy } from "./health";
import {
	bootoutService,
	bootstrapService,
	deleteKeychainPassword,
	generatePortalPassword,
	isDarwin,
	kickstartService,
	LAUNCHD_ESRCH,
	readKeychainPassword,
	serviceState,
	writeKeychainPassword,
} from "./launchctl";
import {
	DEFAULT_PORTAL_PORT,
	DEFAULT_PORTAL_USERNAME,
	DEFAULT_RELAY_PORT,
	relayPortFromUrl,
	SERVICE_LABELS,
} from "./paths";
import { buildLaunchPlan, renderLaunchAgentPlist, resolveOmpLaunchArgv } from "./service";
import { clearMobileState, readMobileState, setMobileEnabled, writeMobileState } from "./state";
import type {
	MobileHealth,
	MobileLaunchPlan,
	MobileServiceName,
	MobileServiceSpec,
	MobileSessionRow,
	MobileState,
	MobileStatusReport,
} from "./types";

/** Plists carry no secret, so they are world-readable like every other LaunchAgent. */
const PLIST_MODE = 0o644;

export const MACOS_ONLY_MESSAGE =
	"omp mobile manages macOS LaunchAgents and is only supported on macOS. The relay and portal themselves are portable — run `omp mobile relay` and `omp mobile serve` under your own supervisor.";

export interface FileAction {
	path: string;
	action: "wrote" | "unchanged" | "would-write" | "removed" | "would-remove" | "missing";
}

export interface SettingAction {
	key: string;
	value: string;
	changed: boolean;
}

export interface ServiceAction {
	label: string;
	name: MobileServiceName;
	action: "bootstrap" | "bootout" | "kickstart" | "would-load" | "would-unload" | "skipped";
	ok: boolean;
	detail?: string;
}

export interface MobileInstallOptions {
	relayPort?: number;
	portalPort?: number;
	username?: string;
	dryRun?: boolean;
	/** Leave `collab.autoStart`/`publishLink`/`relayUrl` untouched. */
	skipSettings?: boolean;
	homeDir?: string;
}

export interface MobileInstallResult {
	dryRun: boolean;
	plan: MobileLaunchPlan;
	files: FileAction[];
	settings: SettingAction[];
	passwordCreated: boolean;
	services: ServiceAction[];
	health: MobileHealth;
	state: MobileState;
}

export interface MobileUninstallResult {
	dryRun: boolean;
	files: FileAction[];
	services: ServiceAction[];
	passwordRemoved: boolean;
}

export interface MobileControlResult {
	action: "start" | "stop" | "restart";
	services: ServiceAction[];
	health?: MobileHealth;
	enabled: boolean;
}

export interface MobileUpdateResult {
	built: boolean;
	buildOutput?: string;
	install?: MobileInstallResult;
	control?: MobileControlResult;
}

function assertDarwin(): void {
	if (!isDarwin()) throw new Error(MACOS_ONLY_MESSAGE);
}

/**
 * Ports, in precedence order: an explicit flag, then what is already installed,
 * then whatever `collab.relayUrl` already points at (a relay port chosen earlier
 * must not silently move — sessions would publish rooms on a relay nothing
 * serves), then the defaults.
 */
async function resolvePorts(
	options: MobileInstallOptions,
	state: MobileState | undefined,
): Promise<{ relayPort: number; portalPort: number }> {
	const settingRelayPort = relayPortFromUrl(settings.get("collab.relayUrl") ?? "");
	return {
		relayPort: options.relayPort ?? state?.relayPort ?? settingRelayPort ?? DEFAULT_RELAY_PORT,
		portalPort: options.portalPort ?? state?.portalPort ?? DEFAULT_PORTAL_PORT,
	};
}

/**
 * Turn on the three settings that make a session reachable, without overriding
 * deliberate choices: an existing `view` share stays read-only (upgrading it to
 * `full` behind the user's back would hand out write access), and a relay URL
 * that already matches the installed port is left alone.
 */
async function applyCollabSettings(relayPort: number, dryRun: boolean): Promise<SettingAction[]> {
	const relayUrl = `ws://localhost:${relayPort}`;
	const currentAutoStart = settings.get("collab.autoStart");
	const currentPublish = settings.get("collab.publishLink");
	const currentRelay = settings.get("collab.relayUrl");
	const actions: SettingAction[] = [
		{
			key: "collab.autoStart",
			value: currentAutoStart === "view" ? "view" : "full",
			changed: currentAutoStart === "off",
		},
		{ key: "collab.publishLink", value: "true", changed: currentPublish !== true },
		{ key: "collab.relayUrl", value: relayUrl, changed: currentRelay !== relayUrl },
	];
	if (dryRun || !actions.some(action => action.changed)) return actions;
	if (currentAutoStart === "off") settings.set("collab.autoStart", "full");
	if (currentPublish !== true) settings.set("collab.publishLink", true);
	if (currentRelay !== relayUrl) settings.set("collab.relayUrl", relayUrl);
	await settings.flush();
	return actions;
}

/** Write a plist only when its content actually changed, so `status` stays quiet on a no-op install. */
async function writePlist(spec: MobileServiceSpec, homeDir: string, dryRun: boolean): Promise<FileAction> {
	const rendered = renderLaunchAgentPlist(spec, homeDir);
	let existing: string | undefined;
	try {
		existing = await fs.readFile(spec.plistPath, "utf8");
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	if (existing === rendered) return { path: spec.plistPath, action: "unchanged" };
	if (dryRun) return { path: spec.plistPath, action: "would-write" };
	await fs.mkdir(path.dirname(spec.plistPath), { recursive: true });
	await fs.writeFile(spec.plistPath, rendered, { mode: PLIST_MODE });
	await fs.chmod(spec.plistPath, PLIST_MODE);
	return { path: spec.plistPath, action: "wrote" };
}

/**
 * Reload a job from its plist.
 *
 * `bootout` first, unconditionally: `bootstrap` fails with `EEXIST` on a loaded
 * job, and a job loaded from the *previous* plist would otherwise keep running
 * the old argv after an install that changed ports or binary path. `ESRCH` from
 * the bootout of an unloaded job is the normal case, not an error.
 */
async function reloadService(spec: MobileServiceSpec): Promise<ServiceAction> {
	await bootoutService(spec.label);
	const result = await bootstrapService(spec.plistPath, spec.label);
	if (!result.ok) {
		return {
			label: spec.label,
			name: spec.name,
			action: "bootstrap",
			ok: false,
			detail: result.stderr || `exit ${result.exitCode}`,
		};
	}
	const healthy = await waitForHealthy(spec.healthUrl);
	return {
		label: spec.label,
		name: spec.name,
		action: "bootstrap",
		ok: healthy,
		detail: healthy ? undefined : "loaded but not answering — check the service log",
	};
}

export async function installMobile(options: MobileInstallOptions = {}): Promise<MobileInstallResult> {
	assertDarwin();
	await Settings.init();
	const homeDir = options.homeDir ?? os.homedir();
	const dryRun = options.dryRun === true;
	const existing = await readMobileState();
	const { relayPort, portalPort } = await resolvePorts(options, existing);
	const username = options.username ?? existing?.username ?? DEFAULT_PORTAL_USERNAME;
	const launchArgv = resolveOmpLaunchArgv();
	const plan = buildLaunchPlan({ relayPort, portalPort, launchArgv, homeDir });

	// The credential comes first: a portal that starts without one crash-loops,
	// and generating it before the job is loaded means the first start already has
	// it. An existing password is kept — rotating it would log the phone out.
	let passwordCreated = false;
	if (!dryRun && (await readKeychainPassword()) === undefined) {
		const result = await writeKeychainPassword(generatePortalPassword());
		if (!result.ok) throw new Error(`Failed to store the portal password in the Keychain: ${result.stderr}`);
		passwordCreated = true;
	}

	const files = [await writePlist(plan.relay, homeDir, dryRun), await writePlist(plan.portal, homeDir, dryRun)];
	const settingActions = options.skipSettings ? [] : await applyCollabSettings(relayPort, dryRun);

	const now = new Date().toISOString();
	const state: MobileState = {
		enabled: true,
		relayPort,
		portalPort,
		username,
		launchArgv,
		installedAt: existing?.installedAt ?? now,
		updatedAt: now,
	};

	if (dryRun) {
		return {
			dryRun,
			plan,
			files,
			settings: settingActions,
			passwordCreated,
			services: [
				{ label: plan.relay.label, name: "relay", action: "would-load", ok: true },
				{ label: plan.portal.label, name: "portal", action: "would-load", ok: true },
			],
			health: await probeMobileHealth(relayPort, portalPort),
			state,
		};
	}

	await writeMobileState(state);
	// Relay first: the portal dials rooms that live on it, and a session that
	// auto-hosts during the install should find the relay already up.
	const services = [await reloadService(plan.relay), await reloadService(plan.portal)];
	return {
		dryRun,
		plan,
		files,
		settings: settingActions,
		passwordCreated,
		services,
		health: await probeMobileHealth(relayPort, portalPort),
		state,
	};
}

export async function uninstallMobile(
	options: { dryRun?: boolean; purgePassword?: boolean; homeDir?: string } = {},
): Promise<MobileUninstallResult> {
	assertDarwin();
	const homeDir = options.homeDir ?? os.homedir();
	const dryRun = options.dryRun === true;
	const state = await readMobileState();
	const plan = buildLaunchPlan({
		relayPort: state?.relayPort,
		portalPort: state?.portalPort,
		launchArgv: state?.launchArgv,
		homeDir,
	});

	const services: ServiceAction[] = [];
	const files: FileAction[] = [];
	for (const spec of [plan.portal, plan.relay]) {
		if (dryRun) {
			services.push({ label: spec.label, name: spec.name, action: "would-unload", ok: true });
			files.push({ path: spec.plistPath, action: "would-remove" });
			continue;
		}
		const result = await bootoutService(spec.label);
		// Exit 3 is `ESRCH`: the job was not loaded, which is the desired end state.
		services.push({
			label: spec.label,
			name: spec.name,
			action: "bootout",
			ok: result.ok || result.exitCode === LAUNCHD_ESRCH,
			detail: result.ok ? undefined : result.stderr || `exit ${result.exitCode}`,
		});
		try {
			await fs.unlink(spec.plistPath);
			files.push({ path: spec.plistPath, action: "removed" });
		} catch (err) {
			if (!isEnoent(err)) throw err;
			files.push({ path: spec.plistPath, action: "missing" });
		}
	}

	let passwordRemoved = false;
	if (!dryRun) {
		await clearMobileState();
		if (options.purgePassword) passwordRemoved = (await deleteKeychainPassword()).ok;
	}
	return { dryRun, files, services, passwordRemoved };
}

/**
 * Start, stop or restart both services.
 *
 * `stop` clears the install state's `enabled` flag so the startup healer does
 * not bring them straight back on the next `omp` launch; `start` sets it again.
 * That flag is the difference between "stopped" and "broken", and only the user
 * can express it.
 */
export async function controlMobile(
	action: "start" | "stop" | "restart",
	options: { service?: MobileServiceName; homeDir?: string } = {},
): Promise<MobileControlResult> {
	assertDarwin();
	const state = await readMobileState();
	if (!state) throw new Error("The mobile stack is not installed. Run `omp mobile install` first.");
	const plan = buildLaunchPlan({
		relayPort: state.relayPort,
		portalPort: state.portalPort,
		launchArgv: state.launchArgv,
		homeDir: options.homeDir ?? os.homedir(),
	});
	// Relay before portal on the way up, portal before relay on the way down: the
	// portal is the one holding guest sockets, so it should be the first to go and
	// the last to arrive.
	const specs = options.service
		? [plan[options.service]]
		: action === "stop"
			? [plan.portal, plan.relay]
			: [plan.relay, plan.portal];

	const services: ServiceAction[] = [];
	for (const spec of specs) {
		if (action === "stop") {
			const result = await bootoutService(spec.label);
			services.push({
				label: spec.label,
				name: spec.name,
				action: "bootout",
				ok: result.ok || result.exitCode === LAUNCHD_ESRCH,
				detail: result.ok ? undefined : result.stderr || `exit ${result.exitCode}`,
			});
			continue;
		}
		const loaded = (await serviceState(spec.label)) !== undefined;
		if (!loaded) {
			services.push(await reloadService(spec));
			continue;
		}
		const result = await kickstartService(spec.label);
		const healthy = result.ok && (await waitForHealthy(spec.healthUrl));
		services.push({
			label: spec.label,
			name: spec.name,
			action: "kickstart",
			ok: healthy,
			detail: healthy ? undefined : result.stderr || "restarted but not answering — check the service log",
		});
	}

	const enabled = action !== "stop";
	await setMobileEnabled(enabled);
	return {
		action,
		services,
		health: action === "stop" ? undefined : await probeMobileHealth(state.relayPort, state.portalPort),
		enabled,
	};
}

/** Live sessions, read from the collab link records the hosts publish. */
async function readSessionRows(): Promise<MobileSessionRow[]> {
	const dir = collabLinkDir();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (!isEnoent(err)) logger.warn("mobile: failed to read collab link dir", { dir, error: String(err) });
		return [];
	}
	const rows: MobileSessionRow[] = [];
	for (const name of names.filter(entry => entry.endsWith(".json"))) {
		let record: CollabLinkRecord;
		try {
			record = (await Bun.file(path.join(dir, name)).json()) as CollabLinkRecord;
		} catch {
			continue;
		}
		// `pid` is a liveness heuristic, not proof: an abrupt exit leaves a record
		// behind and a recycled pid can make a dead one look live.
		rows.push({
			pid: record.pid,
			cwd: record.cwd,
			sessionId: record.sessionId,
			startedAt: record.startedAt,
			alive: procmgr.isPidRunning(record.pid),
			steerable: typeof record.link === "string" && record.link.length > 0,
		});
	}
	return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function mobileStatus(options: { homeDir?: string } = {}): Promise<MobileStatusReport> {
	await Settings.init();
	const state = await readMobileState();
	const relayPort = state?.relayPort ?? relayPortFromUrl(settings.get("collab.relayUrl") ?? "") ?? DEFAULT_RELAY_PORT;
	const portalPort = state?.portalPort ?? DEFAULT_PORTAL_PORT;
	const launchArgv = state?.launchArgv ?? resolveOmpLaunchArgv();
	const plan = buildLaunchPlan({ relayPort, portalPort, launchArgv, homeDir: options.homeDir ?? os.homedir() });

	const services = await Promise.all(
		[plan.relay, plan.portal].map(async spec => {
			const [launchState, plistInstalled] = await Promise.all([
				isDarwin() ? serviceState(spec.label) : Promise.resolve(undefined),
				fs
					.access(spec.plistPath)
					.then(() => true)
					.catch(() => false),
			]);
			return {
				name: spec.name,
				label: spec.label,
				launchState,
				loaded: launchState !== undefined,
				plistInstalled,
				port: spec.port,
				logs: spec.logs,
			};
		}),
	);

	const relayUrl = settings.get("collab.relayUrl") ?? "";
	const [health, sessions, password] = await Promise.all([
		probeMobileHealth(relayPort, portalPort),
		readSessionRows(),
		isDarwin() ? readKeychainPassword() : Promise.resolve(undefined),
	]);
	return {
		installed: state !== undefined,
		enabled: state?.enabled === true,
		binary: { path: process.execPath, version: VERSION, compiled: process.env.PI_COMPILED === "true" },
		launchArgv,
		settings: {
			autoStart: settings.get("collab.autoStart"),
			publishLink: settings.get("collab.publishLink") === true,
			relayUrl,
		},
		relayUrlMismatch: relayPortFromUrl(relayUrl) !== relayPort,
		passwordStored: password !== undefined,
		services,
		health,
		sessions,
	};
}

/**
 * Locate the checkout this build came from, so `update` can rebuild it.
 *
 * A compiled binary lives at `<repo>/packages/coding-agent/dist/omp`, and a
 * source run resolves relative to this module. Either way the answer is only
 * trusted when the root actually looks like the omp repo — a binary copied
 * somewhere else must report "no checkout" rather than run `bun run build` in a
 * stranger's directory.
 */
export async function resolveRepoRoot(): Promise<string | undefined> {
	const candidates =
		process.env.PI_COMPILED === "true"
			? [path.resolve(path.dirname(process.execPath), "..", "..", "..")]
			: [path.resolve(import.meta.dir, "..", "..", "..", "..")];
	for (const candidate of candidates) {
		try {
			const manifest = (await Bun.file(path.join(candidate, "package.json")).json()) as { name?: string };
			if (manifest.name === "omp") return candidate;
		} catch {
			// Not a checkout root; fall through.
		}
	}
	return undefined;
}

/**
 * Rebuild the binary from its checkout, then reinstall and restart.
 *
 * This is the "I changed the code, ship it locally" path: the LaunchAgents point
 * at `dist/omp`, so a source change does nothing until that binary is rebuilt and
 * the jobs are reloaded. `--no-build` covers the case where the binary was
 * already rebuilt (e.g. by a fork-update script) and only the services need to
 * catch up.
 */
export async function updateMobile(options: { build?: boolean; dryRun?: boolean } = {}): Promise<MobileUpdateResult> {
	assertDarwin();
	const build = options.build !== false;
	let built = false;
	let buildOutput: string | undefined;
	if (build) {
		const repoRoot = await resolveRepoRoot();
		if (!repoRoot) {
			throw new Error(
				"Cannot rebuild: this omp was not started from a source checkout. Re-run with --no-build to reinstall and restart the services only.",
			);
		}
		const result = await ptree.exec(["bun", "run", "build"], {
			cwd: path.join(repoRoot, "packages", "coding-agent"),
			signal: ptree.combineSignals(900_000),
			allowNonZero: true,
			stderr: "full",
		});
		built = result.exitCode === 0;
		buildOutput = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
		if (!built) throw new Error(`Rebuild failed:\n${buildOutput}`);
	}
	const install = await installMobile({ dryRun: options.dryRun });
	return { built, buildOutput, install };
}

/**
 * Resolve the portal's credential for `omp mobile serve`.
 *
 * The Keychain is the source of truth; `OMP_MOBILE_PASSWORD` exists for
 * containers and for a foreground run against a throwaway credential. There is
 * deliberately no fall-back to "no auth": the portal can prompt agents and
 * approve their tool calls, so an unauthenticated one is a remote shell.
 */
export async function resolvePortalCredentials(
	options: { username?: string } = {},
): Promise<{ username: string; password: string }> {
	const state = await readMobileState();
	const username = options.username ?? process.env.OMP_MOBILE_USERNAME ?? state?.username ?? DEFAULT_PORTAL_USERNAME;
	const password = process.env.OMP_MOBILE_PASSWORD || (isDarwin() ? await readKeychainPassword() : undefined);
	if (!password) {
		throw new Error(
			`No portal password found (Keychain service "omp-mobile", account "${os.userInfo().username}"). Run \`omp mobile install\` to generate one, or set OMP_MOBILE_PASSWORD.`,
		);
	}
	return { username, password };
}

/** Labels of both services, for log tailing and error messages. */
export const MOBILE_SERVICE_LABELS = SERVICE_LABELS;
