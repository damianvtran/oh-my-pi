/**
 * Outside-in health probes for the mobile stack.
 *
 * These are the same checks a human would run with `curl`, encoded once so
 * `install`, `status`, `restart` and the startup healer all agree on what
 * "healthy" means. The portal's three probes are deliberately more than a
 * liveness check: the login gate is a security boundary, and a portal that
 * hands the app to an anonymous navigation is broken even though `/healthz`
 * answers.
 */

import type { MobileHealth, MobileProbe } from "./types";

/** Loopback probes either answer immediately or the service is not there. */
const PROBE_TIMEOUT_MS = 2_000;

async function probe(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string } | null> {
	try {
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			// A 303 to /login is the expected answer for the gate probe, so the
			// redirect must be observed rather than followed.
			redirect: "manual",
		});
		return { status: response.status, body: (await response.text()).slice(0, 200) };
	} catch {
		return null;
	}
}

/** `GET /healthz` on the relay, whose body carries the live room count. */
export async function probeRelay(port: number): Promise<MobileProbe> {
	const result = await probe(`http://127.0.0.1:${port}/healthz`);
	if (!result) return { ok: false, detail: "no answer" };
	if (result.status !== 200) return { ok: false, detail: `HTTP ${result.status}` };
	return { ok: true, detail: result.body.trim() };
}

/**
 * The portal's three-part contract:
 * - `/healthz` answers 200 without a credential (health checks need it and it
 *   reveals nothing);
 * - a browser navigation to `/` without a cookie is redirected (303) to the
 *   login form — a 200 here means the app is being served to anonymous callers;
 * - `/login` renders, otherwise the redirect above is a dead end.
 */
export async function probePortal(
	port: number,
): Promise<Pick<MobileHealth, "portalHealth" | "portalLoginGate" | "portalLoginPage">> {
	const base = `http://127.0.0.1:${port}`;
	const [health, gate, login] = await Promise.all([
		probe(`${base}/healthz`),
		probe(`${base}/`, { accept: "text/html" }),
		probe(`${base}/login`),
	]);
	return {
		portalHealth: health
			? { ok: health.status === 200, detail: `HTTP ${health.status}` }
			: { ok: false, detail: "no answer" },
		portalLoginGate: gate
			? { ok: gate.status === 303, detail: `HTTP ${gate.status}${gate.status === 200 ? " (not gated!)" : ""}` }
			: { ok: false, detail: "no answer" },
		portalLoginPage: login
			? { ok: login.status === 200, detail: `HTTP ${login.status}` }
			: { ok: false, detail: "no answer" },
	};
}

export async function probeMobileHealth(relayPort: number, portalPort: number): Promise<MobileHealth> {
	const [relay, portal] = await Promise.all([probeRelay(relayPort), probePortal(portalPort)]);
	return { relay, ...portal };
}

/**
 * Poll a health endpoint until it answers or the budget runs out.
 *
 * Used after `bootstrap`/`kickstart`, where launchd returns as soon as it has
 * accepted the job rather than when the service is listening. The interval is
 * short because both services bind in well under a second when they are going to
 * bind at all; the budget is what covers a cold binary start.
 */
export async function waitForHealthy(url: string, timeoutMs = 8_000, intervalMs = 150): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = await probe(url);
		if (result?.status === 200) return true;
		if (Date.now() + intervalMs >= deadline) return false;
		await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
	}
}
