/**
 * `omp mobile …` must route to the registered `mobile` subcommand instead of
 * being rewritten to `launch mobile …` and forwarded to the model as an initial
 * prompt (same failure mode as #1496). The verbs matter as much as the name:
 * `omp mobile install` reaching the LLM would be a prompt, not an install.
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("mobile command is registered as a top-level subcommand", () => {
	test("CLI runner routes mobile verbs to the mobile command, not launch", () => {
		expect(isSubcommand("mobile")).toBe(true);
		expect(resolveCliArgv(["mobile", "install"])).toEqual({ argv: ["mobile", "install"] });
		expect(resolveCliArgv(["mobile", "status", "--json"])).toEqual({ argv: ["mobile", "status", "--json"] });
	});

	test("the service entry points the LaunchAgents run are routable too", () => {
		// These are the argv launchd executes; if they ever fell through to `launch`,
		// the LaunchAgent would start an agent session instead of a service.
		expect(resolveCliArgv(["mobile", "relay", "--port", "7466"])).toEqual({
			argv: ["mobile", "relay", "--port", "7466"],
		});
		expect(resolveCliArgv(["mobile", "serve", "--port", "4097"])).toEqual({
			argv: ["mobile", "serve", "--port", "4097"],
		});
	});
});
