/**
 * `omp mobile` command handlers: output formatting for the mobile remote-access
 * stack, plus the two foreground service entry points the LaunchAgents run.
 *
 * The orchestration lives in `src/mobile/**`; this file owns only the human and
 * `--json` renderings and the process lifetime of `serve`/`relay`. Every action
 * has a JSON form because this is the surface a script would drive.
 */

import chalk from "chalk";
import { runSessionHost } from "../mobile/control";
import {
	controlMobile,
	installMobile,
	MACOS_ONLY_MESSAGE,
	type MobileInstallResult,
	mobileStatus,
	resolvePortalCredentials,
	uninstallMobile,
	updateMobile,
} from "../mobile/install";
import { generatePortalPassword, isDarwin, writeKeychainPassword } from "../mobile/launchctl";
import { DEFAULT_RELAY_PORT } from "../mobile/paths";
import { startPortal } from "../mobile/portal";
import { startRelay } from "../mobile/relay";
import { buildLaunchPlan } from "../mobile/service";
import { readMobileState } from "../mobile/state";
import type { MobileHealth, MobileServiceName, MobileStatusReport } from "../mobile/types";

export type MobileAction =
	| "install"
	| "uninstall"
	| "status"
	| "start"
	| "stop"
	| "restart"
	| "update"
	| "logs"
	| "serve"
	| "relay"
	| "host"
	| "password";

export interface MobileCommandArgs {
	action: MobileAction;
	flags: {
		json?: boolean;
		dryRun?: boolean;
		port?: number;
		relayPort?: number;
		username?: string;
		service?: MobileServiceName;
		lines?: number;
		follow?: boolean;
		build?: boolean;
		purge?: boolean;
		skipSettings?: boolean;
		/** host: working directory for the spawned session. */
		cwd?: string;
	};
}

const OK = chalk.green("ok");
const BAD = chalk.red("FAILED");

function tick(ok: boolean): string {
	return ok ? OK : BAD;
}

function printHealth(health: MobileHealth): void {
	console.log(chalk.bold("\nendpoints"));
	console.log(`  relay          ${tick(health.relay.ok)}  ${chalk.dim(health.relay.detail ?? "")}`);
	console.log(`  portal health  ${tick(health.portalHealth.ok)}  ${chalk.dim(health.portalHealth.detail ?? "")}`);
	console.log(
		`  portal gate    ${tick(health.portalLoginGate.ok)}  ${chalk.dim(health.portalLoginGate.detail ?? "")}`,
	);
	console.log(
		`  login page     ${tick(health.portalLoginPage.ok)}  ${chalk.dim(health.portalLoginPage.detail ?? "")}`,
	);
}

function printInstall(result: MobileInstallResult, verb: string): void {
	console.log(chalk.bold(result.dryRun ? `${verb} — dry run, nothing was changed` : verb));
	for (const file of result.files) {
		const label = file.action === "unchanged" ? chalk.dim("unchanged") : chalk.yellow(file.action);
		console.log(`  ${label} ${file.path}`);
	}
	if (result.passwordCreated)
		console.log(`  ${chalk.yellow("created")} portal password (Keychain service "omp-mobile")`);
	for (const setting of result.settings) {
		const label = setting.changed ? chalk.yellow("set") : chalk.dim("kept");
		console.log(`  ${label} ${setting.key} = ${setting.value}`);
	}
	for (const service of result.services) {
		console.log(`  ${tick(service.ok)} ${service.action} ${service.label} ${chalk.dim(service.detail ?? "")}`);
	}
	printHealth(result.health);
	if (!result.dryRun) {
		console.log(
			chalk.dim(
				`\nportal http://127.0.0.1:${result.state.portalPort} · login as "${result.state.username}" with the password in the Keychain (service "omp-mobile").`,
			),
		);
		console.log(chalk.dim("Expose it remotely with a tunnel in front — see docs/mobile.md. Never bind it publicly."));
	}
	if (result.services.some(service => !service.ok)) process.exitCode = 1;
}

function printStatus(report: MobileStatusReport): void {
	console.log(chalk.bold("omp mobile"));
	console.log(
		`  install        ${report.installed ? OK : chalk.yellow("not installed")}${report.installed && !report.enabled ? chalk.yellow("  (stopped — services stay down until `omp mobile start`)") : ""}`,
	);
	console.log(`  binary         ${report.binary.path} ${chalk.dim(`omp/${report.binary.version}`)}`);
	console.log(`  launch argv    ${chalk.dim(report.launchArgv.join(" "))}`);
	console.log(`  password       ${report.passwordStored ? OK : chalk.red("missing — run `omp mobile install`")}`);

	console.log(chalk.bold("\nsettings") + chalk.dim("  (user-scoped; a project config cannot set these)"));
	console.log(
		`  collab.autoStart    ${report.settings.autoStart === "off" ? chalk.red("off") : chalk.green(report.settings.autoStart)}`,
	);
	console.log(`  collab.publishLink  ${report.settings.publishLink ? chalk.green("true") : chalk.red("false")}`);
	console.log(
		`  collab.relayUrl     ${report.settings.relayUrl || chalk.red("(unset)")}${report.relayUrlMismatch ? chalk.red("  ← does not point at the installed relay") : ""}`,
	);

	console.log(chalk.bold("\nservices"));
	for (const service of report.services) {
		const state = service.loaded ? chalk.green(service.launchState ?? "loaded") : chalk.yellow("unloaded");
		const plist = service.plistInstalled ? "" : chalk.red(" (no plist)");
		console.log(`  ${service.name.padEnd(7)} ${service.label}  ${state}  ${chalk.dim(`:${service.port}`)}${plist}`);
	}
	printHealth(report.health);

	console.log(chalk.bold("\nregistered sessions") + chalk.dim("  (publishing a room the portal joined)"));
	if (report.sessions.length === 0) {
		console.log(chalk.dim("  (none — start an omp session, or check collab.autoStart)"));
	}
	for (const session of report.sessions) {
		const alive = session.alive ? chalk.green("alive") : chalk.yellow("stale");
		const mode = session.steerable ? "" : chalk.dim(" view-only");
		console.log(`  pid ${String(session.pid).padEnd(7)} ${alive} ${session.cwd}${mode}`);
	}

	// A session that publishes nothing is invisible to the portal and, from the
	// phone, indistinguishable from one that is not running. Nothing outside a
	// session can make it host, so naming it — with the fix — is the whole feature.
	if (report.unregistered.length > 0) {
		console.log(chalk.bold("\nunregistered sessions") + chalk.dim("  (running, but hosting no room)"));
		for (const session of report.unregistered) {
			console.log(`  pid ${String(session.pid).padEnd(7)} ${chalk.yellow("no room")} ${chalk.dim(session.command)}`);
		}
		console.log(
			chalk.dim(
				"  → these started before the relay, or with collab.autoStart off. Restart them, or type /collab in each.",
			),
		);
	}

	console.log(chalk.dim("\nlogs"));
	for (const service of report.services) console.log(chalk.dim(`  ${service.logs.stdout}`));
	const healthy =
		report.health.relay.ok &&
		report.health.portalHealth.ok &&
		report.health.portalLoginGate.ok &&
		report.health.portalLoginPage.ok;
	if (report.installed && report.enabled && !healthy) process.exitCode = 1;
}

/** Foreground portal: the process a LaunchAgent runs, and a debuggable `omp mobile serve`. */
async function runPortalForeground(port: number | undefined, username: string | undefined): Promise<void> {
	const state = await readMobileState();
	const credentials = await resolvePortalCredentials({ username });
	const resolvedPort = port ?? state?.portalPort ?? buildLaunchPlan().portal.port;
	const handle = await startPortal({ port: resolvedPort, ...credentials });
	// Under launchd, SIGTERM is how a stop/restart arrives; without this the guest
	// sockets and the scan interval would be torn down by process death instead of
	// closed, and the log would end mid-sentence.
	const stop = (signal: string) => {
		console.log(`portal stopping (${signal})`);
		void handle.stop().then(() => process.exit(0));
	};
	process.once("SIGTERM", () => stop("SIGTERM"));
	process.once("SIGINT", () => stop("SIGINT"));
}

function runRelayForeground(port: number | undefined): void {
	const handle = startRelay({ port });
	const stop = (signal: string) => {
		console.log(`relay stopping (${signal})`);
		handle.stop();
		process.exit(0);
	};
	process.once("SIGTERM", () => stop("SIGTERM"));
	process.once("SIGINT", () => stop("SIGINT"));
}

async function runLogs(args: MobileCommandArgs): Promise<void> {
	const state = await readMobileState();
	const plan = buildLaunchPlan({
		relayPort: state?.relayPort,
		portalPort: state?.portalPort,
		launchArgv: state?.launchArgv,
	});
	const specs = args.flags.service ? [plan[args.flags.service]] : [plan.relay, plan.portal];
	const lines = args.flags.lines ?? 40;
	const files: { path: string; label: string }[] = [];
	for (const spec of specs) {
		console.log(chalk.bold(`\n${spec.label}`));
		for (const file of [spec.logs.stdout, spec.logs.stderr]) {
			const text = await Bun.file(file)
				.text()
				.catch(() => "");
			const tail = text.trimEnd().split("\n").slice(-lines).join("\n");
			console.log(chalk.dim(`── ${file}`));
			console.log(tail.length > 0 ? tail : chalk.dim("(empty)"));
			files.push({ path: file, label: `${spec.name}${file.endsWith(".err.log") ? " stderr" : ""}` });
		}
	}
	if (args.flags.follow) await followLogs(files);
}

/**
 * Poll the log files for growth and print what was appended, prefixed with the
 * service so an interleaved relay+portal stream stays readable.
 *
 * Polling rather than watching: launchd owns these files and truncates them on
 * rotation, and a size that went *backwards* is exactly that case — re-reading
 * from zero then is what keeps the stream honest instead of printing garbage
 * forever. Runs until interrupted, which is the contract of a follow.
 */
async function followLogs(files: { path: string; label: string }[]): Promise<void> {
	const offsets = new Map<string, number>();
	for (const file of files) offsets.set(file.path, Bun.file(file.path).size);
	console.log(chalk.dim("\n── following (ctrl-c to stop)"));
	const stop = Promise.withResolvers<void>();
	process.once("SIGINT", () => stop.resolve());
	for (;;) {
		for (const file of files) {
			const handle = Bun.file(file.path);
			const size = handle.size;
			const previous = offsets.get(file.path) ?? 0;
			if (size === previous) continue;
			// A shrink means launchd rotated or truncated the file; restart from 0.
			const from = size < previous ? 0 : previous;
			const chunk = await handle.slice(from, size).text();
			offsets.set(file.path, size);
			for (const line of chunk.split("\n")) {
				if (line.length > 0) console.log(`${chalk.dim(`[${file.label}]`)} ${line}`);
			}
		}
		const tick = Bun.sleep(500);
		const done = await Promise.race([stop.promise.then(() => true), tick.then(() => false)]);
		if (done) return;
	}
}

export async function runMobileCommand(args: MobileCommandArgs): Promise<void> {
	const { action, flags } = args;
	const json = flags.json === true;

	// The services themselves are portable; only the launchd management is not.
	if (!isDarwin() && action !== "serve" && action !== "relay" && action !== "host") {
		console.error(chalk.red(MACOS_ONLY_MESSAGE));
		process.exitCode = 1;
		return;
	}

	switch (action) {
		case "relay":
			runRelayForeground(flags.port ?? flags.relayPort);
			return;
		case "serve":
			await runPortalForeground(flags.port, flags.username);
			return;
		case "host": {
			// The session nanny the portal spawns for a phone-started session (see
			// mobile/control.ts). Not a management verb: no --json, no --dry-run.
			if (!flags.cwd) {
				console.error(chalk.red("mobile host requires --cwd <directory>"));
				process.exitCode = 1;
				return;
			}
			process.exitCode = await runSessionHost(flags.cwd);
			return;
		}
		case "install": {
			const result = await installMobile({
				relayPort: flags.relayPort,
				portalPort: flags.port,
				username: flags.username,
				dryRun: flags.dryRun,
				skipSettings: flags.skipSettings,
			});
			if (json) {
				console.log(JSON.stringify(result, null, 2));
				if (result.services.some(service => !service.ok)) process.exitCode = 1;
				return;
			}
			printInstall(result, "install");
			return;
		}
		case "update": {
			const result = await updateMobile({ build: flags.build, dryRun: flags.dryRun });
			if (json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}
			console.log(result.built ? `${OK} rebuilt dist/omp` : chalk.dim("skipped rebuild"));
			if (result.install) printInstall(result.install, "reinstall");
			return;
		}
		case "uninstall": {
			const result = await uninstallMobile({ dryRun: flags.dryRun, purgePassword: flags.purge });
			if (json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}
			console.log(chalk.bold(result.dryRun ? "uninstall — dry run, nothing was changed" : "uninstall"));
			for (const service of result.services) {
				console.log(`  ${tick(service.ok)} ${service.action} ${service.label} ${chalk.dim(service.detail ?? "")}`);
			}
			for (const file of result.files) console.log(`  ${chalk.yellow(file.action)} ${file.path}`);
			console.log(
				result.passwordRemoved
					? `  ${chalk.yellow("removed")} portal password`
					: chalk.dim("  kept the portal password (pass --purge to delete it) and the collab.* settings"),
			);
			return;
		}
		case "start":
		case "stop":
		case "restart": {
			const result = await controlMobile(action, { service: flags.service });
			if (json) {
				console.log(JSON.stringify(result, null, 2));
				if (result.services.some(service => !service.ok)) process.exitCode = 1;
				return;
			}
			console.log(chalk.bold(action));
			for (const service of result.services) {
				console.log(`  ${tick(service.ok)} ${service.action} ${service.label} ${chalk.dim(service.detail ?? "")}`);
			}
			if (result.health) printHealth(result.health);
			if (result.services.some(service => !service.ok)) process.exitCode = 1;
			return;
		}
		case "logs":
			await runLogs(args);
			return;
		case "password": {
			// Rotating invalidates every live portal cookie by design: the signing key
			// is derived from the password, so a rotation logs every phone out.
			const password = generatePortalPassword();
			const result = await writeKeychainPassword(password);
			if (!result.ok) {
				console.error(chalk.red(`Failed to store the new password: ${result.stderr}`));
				process.exitCode = 1;
				return;
			}
			await controlMobile("restart", { service: "portal" });
			if (json) {
				console.log(JSON.stringify({ rotated: true }, null, 2));
				return;
			}
			console.log(`${OK} rotated the portal password and restarted the portal`);
			console.log(
				chalk.dim(
					'Read it with: security find-generic-password -a "$(id -un)" -s omp-mobile -w  (mirror it to your password manager; every existing session cookie is now invalid)',
				),
			);
			return;
		}
		case "status": {
			const report = await mobileStatus();
			if (json) {
				console.log(JSON.stringify(report, null, 2));
				return;
			}
			printStatus(report);
			return;
		}
	}
}

/** Default relay port, re-exported for the command adapter's help text. */
export const MOBILE_DEFAULT_RELAY_PORT = DEFAULT_RELAY_PORT;
