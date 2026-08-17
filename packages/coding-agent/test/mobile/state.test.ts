/**
 * Contract: the install record at `<config-root>/run/mobile/state.json` survives
 * a round trip, is readable only by its owner, and degrades to "not installed"
 * rather than throwing when it is missing or corrupt.
 *
 * It matters because every later command reads it: `status` probes the ports it
 * names, `update` rewrites the plists from them, and the startup healer uses
 * `enabled` as the user's off switch — a stopped stack that came back on the next
 * `omp` launch would be impossible to keep down.
 *
 * Isolation goes through `PI_CONFIG_DIR` rather than `setAgentDir`, matching
 * `test/collab/link-file.test.ts`: the paths resolve from `getConfigRootDir()`,
 * so redirecting only the agent dir would leave this suite writing into — and its
 * cleanup deleting — the developer's real `~/.omp/run/mobile`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mobileRuntimeDir, mobileStateFile } from "@oh-my-pi/pi-coding-agent/mobile/paths";
import {
	clearMobileState,
	readMobileState,
	setMobileEnabled,
	writeMobileState,
} from "@oh-my-pi/pi-coding-agent/mobile/state";
import type { MobileState } from "@oh-my-pi/pi-coding-agent/mobile/types";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
let configRoot: string;

function makeState(overrides: Partial<MobileState> = {}): MobileState {
	return {
		enabled: true,
		relayPort: 7466,
		portalPort: 4097,
		username: "omp",
		launchArgv: ["/opt/omp"],
		installedAt: "2026-07-28T00:00:00.000Z",
		updatedAt: "2026-07-28T00:00:00.000Z",
		...overrides,
	};
}

beforeAll(() => {
	process.env.PI_CONFIG_DIR = `.omp-test-mobile-state-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	configRoot = getConfigRootDir();
	// Fail loudly rather than operating on the developer's real ~/.omp.
	expect(configRoot).not.toBe(path.join(os.homedir(), ".omp"));
});

afterAll(async () => {
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
	await fs.rm(configRoot, { recursive: true, force: true });
});

afterEach(async () => {
	await fs.rm(mobileRuntimeDir(), { recursive: true, force: true });
});

describe("mobile install state", () => {
	it("round-trips the record and restricts it to its owner", async () => {
		await writeMobileState(makeState({ portalPort: 4444 }));

		expect(await readMobileState()).toMatchObject({ portalPort: 4444, relayPort: 7466, enabled: true });
		// The record is not secret, but it names the services and ports an attacker
		// would target, and it lives in the same 0700 `run/` namespace as the collab
		// link records that DO carry write tokens.
		expect((await fs.stat(mobileStateFile())).mode & 0o777).toBe(0o600);
		expect((await fs.stat(mobileRuntimeDir())).mode & 0o777).toBe(0o700);
	});

	it("reports not-installed instead of throwing when there is no record", async () => {
		expect(await readMobileState()).toBeUndefined();
	});

	it("treats a corrupt record as not-installed so a management command still runs", async () => {
		await fs.mkdir(mobileRuntimeDir(), { recursive: true });
		await Bun.write(mobileStateFile(), "{ this is not json");
		expect(await readMobileState()).toBeUndefined();

		// A structurally valid JSON object with the wrong shape is equally unusable:
		// acting on a missing port would probe the wrong service.
		await Bun.write(mobileStateFile(), JSON.stringify({ enabled: true }));
		expect(await readMobileState()).toBeUndefined();
	});

	it("flips the healer's off switch without disturbing the rest of the record", async () => {
		await writeMobileState(makeState({ portalPort: 4444, installedAt: "2020-01-01T00:00:00.000Z" }));

		const stopped = await setMobileEnabled(false);
		expect(stopped?.enabled).toBe(false);
		expect(stopped?.portalPort).toBe(4444);
		// installedAt is the original install; only updatedAt moves.
		expect(stopped?.installedAt).toBe("2020-01-01T00:00:00.000Z");
		expect((await readMobileState())?.enabled).toBe(false);

		expect((await setMobileEnabled(true))?.enabled).toBe(true);
	});

	it("does nothing when asked to toggle a stack that was never installed", async () => {
		expect(await setMobileEnabled(false)).toBeUndefined();
	});

	it("clears the record and tolerates clearing twice", async () => {
		await writeMobileState(makeState());
		await clearMobileState();
		expect(await readMobileState()).toBeUndefined();
		await clearMobileState();
	});

	it("replaces an existing record rather than failing on the staged write", async () => {
		// The staged path is fixed, so a crashed earlier write must not wedge every
		// later install.
		await writeMobileState(makeState({ portalPort: 4097 }));
		await Bun.write(`${mobileStateFile()}.tmp`, "leftover");
		await writeMobileState(makeState({ portalPort: 5000 }));
		expect((await readMobileState())?.portalPort).toBe(5000);
	});
});
