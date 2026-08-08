/**
 * Manage the mobile remote-access stack (relay + phone portal).
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type MobileAction, type MobileCommandArgs, runMobileCommand } from "../cli/mobile-cli";
import type { MobileServiceName } from "../mobile/types";

const ACTIONS: MobileAction[] = [
	"install",
	"status",
	"start",
	"stop",
	"restart",
	"update",
	"logs",
	"password",
	"uninstall",
	"serve",
	"relay",
	"host",
];

const SERVICES: MobileServiceName[] = ["relay", "portal"];

export default class Mobile extends Command {
	static description = "Reach every running omp session from a phone (collab relay + local portal)";

	static args = {
		action: Args.string({
			description:
				"install: set up and start both services · status: services, endpoints and live sessions · start/stop/restart: service control · update: rebuild this binary, reinstall, restart · logs: tail service logs · password: rotate the portal password · uninstall: remove both services · serve/relay: run one service in the foreground (what the LaunchAgents run) · host: run a spawned session's PTY nanny (what the portal spawns)",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		port: Flags.integer({ description: "Portal port (default 4097; with serve/relay, the port to listen on)" }),
		"relay-port": Flags.integer({ description: "Relay port (default 7466; also sets collab.relayUrl)" }),
		username: Flags.string({ description: 'Portal login username (default "omp")' }),
		service: Flags.string({ description: "Limit to one service", options: SERVICES }),
		"skip-settings": Flags.boolean({ description: "Do not touch collab.autoStart/publishLink/relayUrl on install" }),
		"no-build": Flags.boolean({ description: "update: reinstall and restart without rebuilding the binary" }),
		purge: Flags.boolean({ description: "uninstall: also delete the portal password from the Keychain" }),
		lines: Flags.integer({ description: "logs: lines to show per file (default 40)" }),
		cwd: Flags.string({ description: "host: working directory for the spawned session" }),
		follow: Flags.boolean({ char: "f", description: "logs: keep streaming new output until interrupted" }),
		"dry-run": Flags.boolean({ char: "n", description: "Show what would change without changing it" }),
		json: Flags.boolean({ char: "j", description: "Output JSON" }),
	};

	static examples = [
		"omp mobile install                 # one-shot: services, credential, settings, health check",
		"omp mobile status                  # is it reachable, and which sessions are live?",
		"omp mobile restart --service portal",
		"omp mobile update                  # rebuild this binary, reinstall the jobs, restart",
		"omp mobile logs --service portal --lines 100",
		"omp mobile install --dry-run       # print the plan, change nothing",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Mobile);
		const cmd: MobileCommandArgs = {
			action: (args.action ?? "status") as MobileAction,
			flags: {
				json: flags.json,
				dryRun: flags["dry-run"],
				port: flags.port,
				relayPort: flags["relay-port"],
				username: flags.username,
				service: flags.service as MobileServiceName | undefined,
				lines: flags.lines,
				follow: flags.follow,
				// `--no-build` negates the impl's `build`, which defaults to true; the
				// CLI framework has no negatable-boolean flag support.
				build: flags["no-build"] ? false : undefined,
				purge: flags.purge,
				skipSettings: flags["skip-settings"],
				cwd: flags.cwd,
			},
		};
		await runMobileCommand(cmd);
	}
}
