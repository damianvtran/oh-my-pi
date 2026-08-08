import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { startCollabHosting } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-collaboration";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CollabQrCodeComponent } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/collab-qrcode";
import { Spacer } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

function fakeHost(options?: {
	webLink?: string;
	webViewLink?: string;
}): NonNullable<InteractiveModeContext["collabHost"]> {
	return {
		link: "relay.example.com/r/full-control",
		viewLink: "relay.example.com/r/read-only",
		webLink: options?.webLink ?? "https://my.omp.sh/#full-control",
		webViewLink: options?.webViewLink ?? "https://my.omp.sh/#read-only",
		participants: [{ name: "host", role: "host" }],
	} as unknown as NonNullable<InteractiveModeContext["collabHost"]>;
}

function createRuntimeHarness(options?: { collabHost?: NonNullable<InteractiveModeContext["collabHost"]> }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const settingsGet = vi.fn((key: string) => {
		if (key === "collab.relayUrl") return "wss://relay.example.com";
		if (key === "collab.webUrl") return "";
		if (key === "collab.publishLink") return false;
		return "";
	});
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		present,
		settings: { get: settingsGet },
		collabHost: options?.collabHost,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

function mockStartedHostLinks() {
	return vi.spyOn(CollabHost.prototype, "start").mockImplementation(function (this: CollabHost): Promise<void> {
		Object.defineProperties(this, {
			link: { value: "relay.example.com/r/full-control", configurable: true },
			viewLink: { value: "relay.example.com/r/read-only", configurable: true },
			webLink: { value: "https://my.omp.sh/#started-full", configurable: true },
			webViewLink: { value: "https://my.omp.sh/#started-view", configurable: true },
			participants: { value: [{ name: "host", role: "host" as const }], configurable: true },
		});
		return Promise.resolve();
	});
}

describe("/collab slash command QR code rendering", () => {
	it("starts hosting and prints a one-shot full-control QR", async () => {
		mockStartedHostLinks();
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://my.omp.sh/#started-full");
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("starts hosting and prints a one-shot read-only QR", async () => {
		mockStartedHostLinks();
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-view");
		expect(statusText).not.toContain("my.omp.sh/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://my.omp.sh/#started-view");
	});

	it("prints the active full-control browser QR when hosting", async () => {
		const harness = createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#full-control");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("prints a one-shot read-only browser QR when hosting", async () => {
		const webLink = "https://my.omp.sh/#full-control";
		const webViewLink = "https://my.omp.sh/#read-only";
		const harness = createRuntimeHarness({ collabHost: fakeHost({ webLink, webViewLink }) });

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain(webViewLink);
		expect(statusText).not.toContain(webLink);
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe(webViewLink);
		expect(component.render(10).join("\n")).toContain("QR code hidden");
	});
});

/**
 * `collab.autoStart` fires on every interactive launch, so it shares the
 * `/collab` start path but suppresses the QR block and must still hand the room
 * the right capability. These cover the decisions that path owns.
 */
describe("collab auto-start hosting", () => {
	it("prints the join hint without a QR code", async () => {
		mockStartedHostLinks();
		const harness = createRuntimeHarness();

		const started = await startCollabHosting(harness.ctx, { qr: false });

		expect(started).toBe(true);
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
		expect(harness.showStatus.mock.calls[0]?.[0] as string).toContain("my.omp.sh/#started-full");
		expect(harness.present).not.toHaveBeenCalled();
	});

	it("hands out only the read-only link in view mode", async () => {
		mockStartedHostLinks();
		const harness = createRuntimeHarness();

		await startCollabHosting(harness.ctx, { view: true, qr: false });

		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-view");
		expect(statusText).not.toContain("my.omp.sh/#started-full");
	});

	it("claims the host slot before the relay handshake so a racing /collab cannot double-host", async () => {
		// Auto-start runs unawaited while the TUI already accepts input. If the
		// slot were only claimed after `start()` resolved, a `/collab` typed during
		// the handshake would pass its own guard and build a second host that
		// `/collab stop` could never reach.
		const gate = Promise.withResolvers<void>();
		vi.spyOn(CollabHost.prototype, "start").mockImplementation(() => gate.promise);
		const harness = createRuntimeHarness();

		const pending = startCollabHosting(harness.ctx, { qr: false });
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);

		gate.resolve();
		await pending;
	});

	it("releases the host slot when the relay is unreachable", async () => {
		vi.spyOn(CollabHost.prototype, "start").mockRejectedValue(new Error("Failed to connect"));
		const harness = createRuntimeHarness();

		const started = await startCollabHosting(harness.ctx, { qr: false });

		expect(started).toBe(false);
		expect(harness.ctx.collabHost).toBeUndefined();
		expect(harness.showError).toHaveBeenCalledWith("Failed to start collab session: Failed to connect");
	});
});
