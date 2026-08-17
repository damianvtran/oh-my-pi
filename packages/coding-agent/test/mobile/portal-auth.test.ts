/**
 * Contract: the login surface is safe under the two phone-specific failure
 * modes that prompted this suite.
 *
 *  1. The back/forward cache. Every response that renders the credential form
 *     carries `Cache-Control: no-store`, but WebKit/Chromium may still restore
 *     the page without touching the server. A persisted `pageshow` therefore
 *     replaces it with a GET: `/login` is re-requested, and the still-valid session cookie
 *     makes the authorized 303 send the phone forward instead of leaving a
 *     stale form that reads exactly like being logged out.
 *  2. The Cloudflare Access POST trap. Access can only run its login flow on
 *     a GET; an intercepted POST strands the user on a 400 after the identity
 *     provider round trip. The form therefore probes `/healthz` (a GET) before
 *     submitting, and replaces the page with a GET when the probe cannot get
 *     through. The tests execute the shipped event handlers
 *     against controlled page, form and fetch seams; `bun run check` never sees
 *     inside the HTML template.
 *
 * Everything is real HTTP against a real portal on a loopback port; only the
 * credentials are test fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { type PortalHandle, startPortal } from "@oh-my-pi/pi-coding-agent/mobile/portal";
import { __resetDirsFromEnvForTests, getConfigRootDir } from "@oh-my-pi/pi-utils";

const USERNAME = "omp";
const PASSWORD = "portal-auth-test-password";
const NEVER_POLL_MS = 600_000;

const originalConfigDir = process.env.PI_CONFIG_DIR;
let portal: PortalHandle;

function url(p: string): string {
	return `http://127.0.0.1:${portal.port}${p}`;
}

function loginBody(username: string, password: string): string {
	return new URLSearchParams({ username, password }).toString();
}

const FORM_POST = {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	redirect: "manual" as const,
};

interface ProbeResponse {
	ok: boolean;
	redirected: boolean;
	url: string;
}

interface LoginScriptHarness {
	submit(): void;
	pageshow(persisted: boolean): void;
	settle(): Promise<void>;
	counts(): { validity: number; submitted: number; refreshes: number };
	replacements(): string[];
	readonly probing: string | undefined;
}

interface LoginFormStub {
	dataset: Record<string, string>;
	reportValidity(): boolean;
	submit(): void;
	addEventListener(type: string, handler: (event: LoginSubmitEvent) => void): void;
}

interface LoginSubmitEvent {
	preventDefault(): void;
	currentTarget: LoginFormStub;
}

/**
 * Execute the script returned by the real portal with the smallest DOM it uses.
 * Assertions below drive the actual shipped handlers rather than searching the
 * response text for implementation fragments.
 */
async function loadLoginScript(
	options: { probe?: () => Promise<ProbeResponse>; validity?: (attempt: number) => boolean } = {},
): Promise<LoginScriptHarness> {
	const res = await fetch(url("/login"));
	const body = await res.text();
	const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	if (!script) throw new Error("login page has no inline script");

	const origin = new URL(url("/login")).origin;
	let submitHandler: ((event: LoginSubmitEvent) => void) | undefined;
	let pageshowHandler: ((event: { persisted: boolean }) => void) | undefined;
	let validity = 0;
	let submitted = 0;
	let refreshes = 0;
	const replacements: string[] = [];
	const form: LoginFormStub = {
		dataset: {} as Record<string, string>,
		reportValidity: () => {
			validity++;
			return options.validity?.(validity) ?? true;
		},
		submit: () => {
			submitted++;
		},
		addEventListener: (type: string, handler: (event: LoginSubmitEvent) => void) => {
			if (type === "submit") submitHandler = handler;
		},
	};
	const location = {
		origin,
		pathname: "/login",
		search: "?next=%2F%2342",
		replace: (next: string) => {
			refreshes++;
			replacements.push(next);
		},
	};
	const probe =
		options.probe ??
		(() => Promise.resolve({ ok: true, redirected: false, url: `${origin}/healthz` } satisfies ProbeResponse));
	const addEventListener = (type: string, handler: (event: { persisted: boolean }) => void) => {
		if (type === "pageshow") pageshowHandler = handler;
	};
	new Function("document", "location", "fetch", "addEventListener", script)(
		{ querySelector: () => form },
		location,
		probe,
		addEventListener,
	);

	return {
		submit: () => {
			if (!submitHandler) throw new Error("login script did not install a submit handler");
			submitHandler({ preventDefault: () => {}, currentTarget: form });
		},
		pageshow: persisted => {
			if (!pageshowHandler) throw new Error("login script did not install a pageshow handler");
			pageshowHandler({ persisted });
		},
		settle: async () => {
			// The handler uses a fetch promise plus its `.then`/`.catch` reaction.
			await Promise.resolve();
			await Promise.resolve();
		},
		counts: () => ({ validity, submitted, refreshes }),
		replacements: () => [...replacements],
		get probing() {
			return form.dataset.probing;
		},
	};
}

beforeAll(async () => {
	process.env.PI_CONFIG_DIR = `.omp-test-portal-auth-${process.pid}-${Date.now().toString(36)}`;
	__resetDirsFromEnvForTests();
	// Fail loudly rather than operating on the developer's real ~/.omp.
	expect(getConfigRootDir()).not.toBe(path.join(os.homedir(), ".omp"));
	portal = await startPortal({
		port: 0,
		username: USERNAME,
		password: PASSWORD,
		scanIntervalMs: NEVER_POLL_MS,
		reapSessionJobs: false,
	});
});

afterAll(async () => {
	await portal.stop();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	__resetDirsFromEnvForTests();
});

describe("portal login page", () => {
	it("marks every credential-form response no-store", async () => {
		const res = await fetch(url("/login"));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("no-store");
	});

	/*
	 * WebKit zooms the page when a control whose computed font-size is under 16px
	 * takes focus, and on iOS it never zooms back out — so a 13px credential field
	 * hands the phone a session list that has to be panned sideways before it can be
	 * used. The page's prose stays at 13px; only the fields carry the floor.
	 */
	it("keeps the credential fields at WebKit's 16px focus-zoom floor", async () => {
		const body = await fetch(url("/login")).then(res => res.text());
		const rule = /(^|\})\s*input\{([^}]*)\}/m.exec(body);
		expect(rule).not.toBeNull();
		expect(rule?.[2]).toContain("font-size:16px");
	});

	it("replaces only a back/forward-cache restoration with a GET navigation", async () => {
		const harness = await loadLoginScript();
		harness.pageshow(false);
		expect(harness.counts().refreshes).toBe(0);
		harness.pageshow(true);
		expect(harness.counts().refreshes).toBe(1);
		expect(harness.replacements()).toEqual(["/login?next=%2F%2342"]);
	});

	it("submits only after a direct portal health probe and revalidates at send time", async () => {
		const harness = await loadLoginScript();
		harness.submit();
		await harness.settle();
		expect(harness.counts()).toEqual({ validity: 2, submitted: 1, refreshes: 0 });
	});

	it("replaces instead of posting when Access redirects or the probe fails", async () => {
		const redirected = await loadLoginScript({
			probe: () =>
				Promise.resolve({
					ok: true,
					redirected: true,
					url: "https://example.cloudflareaccess.com/login",
				}),
		});
		redirected.submit();
		await redirected.settle();
		expect(redirected.counts()).toEqual({ validity: 1, submitted: 0, refreshes: 1 });

		const failed = await loadLoginScript({ probe: () => Promise.reject(new Error("network unavailable")) });
		failed.submit();
		await failed.settle();
		expect(failed.counts()).toEqual({ validity: 1, submitted: 0, refreshes: 1 });
	});

	it("does not post credentials cleared while the probe is pending", async () => {
		const pending = Promise.withResolvers<ProbeResponse>();
		const harness = await loadLoginScript({
			probe: () => pending.promise,
			validity: attempt => attempt === 1,
		});
		harness.submit();
		expect(harness.counts().validity).toBe(1);
		pending.resolve({
			ok: true,
			redirected: false,
			url: `${new URL(url("/login")).origin}/healthz`,
		});
		await harness.settle();
		expect(harness.counts()).toEqual({ validity: 2, submitted: 0, refreshes: 0 });
		expect(harness.probing).toBeUndefined();
	});

	it("rejects bad credentials with 401 and a no-store form", async () => {
		const res = await fetch(url("/login"), { ...FORM_POST, body: loginBody(USERNAME, "wrong") });
		expect(res.status).toBe(401);
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(await res.text()).toContain("incorrect username or password");
	});

	/*
	 * The retry form keeps the username so only the password has to be retyped on a
	 * phone keyboard — and that means the form now renders a value the *client*
	 * supplied, into attribute position, on an unauthenticated route. The escaping is
	 * the reason that is safe, so it is asserted rather than assumed.
	 */
	it("keeps the submitted username on the retry form without letting it inject markup", async () => {
		const hostile = `a"><script>alert(1)</script>`;
		const res = await fetch(url("/login"), { ...FORM_POST, body: loginBody(hostile, "wrong") });
		const body = await res.text();
		expect(res.status).toBe(401);
		expect(body).toContain(`value="a&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
		expect(body).not.toContain("<script>alert(1)</script>");
		// The password is never echoed, whatever happens to the username.
		expect(body).not.toContain("wrong");
	});

	it("accepts good credentials with a 303 and a signed cookie", async () => {
		const res = await fetch(url("/login?next=%2F"), { ...FORM_POST, body: loginBody(USERNAME, PASSWORD) });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/");
		expect(res.headers.get("set-cookie") ?? "").toStartWith("omp_session=");
	});

	it("redirects an already-authenticated visitor away from the form", async () => {
		const login = await fetch(url("/login"), { ...FORM_POST, body: loginBody(USERNAME, PASSWORD) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const res = await fetch(url("/login"), { headers: { cookie }, redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/");
	});

	it("sends an unauthenticated browser navigation to the login page", async () => {
		const res = await fetch(url("/"), { headers: { accept: "text/html" }, redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/login?next=%2F");
	});

	it("answers an unauthenticated API call with a bare 401", async () => {
		const res = await fetch(url("/api/sessions"));
		expect(res.status).toBe(401);
	});

	it("serves the app with the cookie", async () => {
		const login = await fetch(url("/login"), { ...FORM_POST, body: loginBody(USERNAME, PASSWORD) });
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const res = await fetch(url("/"), { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});
});
