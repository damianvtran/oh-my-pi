/**
 * Contract: `portal-ui.html`'s inline script is the phone app, and it is invisible
 * to every other check in the repo.
 *
 * `bun run check` runs biome and tsgo over `.ts`; neither parses a `<script>` block
 * inside an HTML file, and the file is inlined into the binary as opaque text
 * (`import portalHtml from "./portal-ui.html" with { type: "text" }`). A single
 * stray backtick inside a template literal therefore produced a file that built,
 * type-checked, linted and shipped — and a page whose entire script failed to
 * parse, leaving a header and nothing else. Only loading it caught that.
 *
 * So this suite does two things no other check does:
 *  - parses the script, which is the whole class of defect above; and
 *  - runs the pure render functions, which are the app's least-covered layer and
 *    the one where an unescaped interpolation would be an XSS hole.
 *
 * The script is loaded whole rather than by copying the functions out, so the
 * assertions below are about the code that actually ships. `with (stubs)` supplies
 * a DOM shaped like a black hole: the top level queries elements, assigns
 * handlers and starts an interval, none of which needs to do anything for a
 * string-returning function to be exercised.
 */
import { describe, expect, it } from "bun:test";
import portalHtml from "../../src/mobile/portal-ui.html" with { type: "text" };

interface PortalSubagentRow {
	id: string;
	agent: string;
	status: string;
	task?: string;
	intent?: string;
	tools?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	startedAt: number;
}

interface PortalUi {
	renderSubagents(value: { running: number; total: number; rows: PortalSubagentRow[] } | null): string;
	esc(value: unknown): string;
	elapsedOf(row: { durationMs?: number; startedAt: number }): string;
	setAgentsOpen(open: boolean | null): void;
}

/**
 * Evaluate the shipped script and hand back the pieces under test.
 *
 * Every unresolved global lands on one recursive no-op proxy, so the top level's
 * DOM work, event wiring and `setInterval` all succeed without a DOM. A fresh
 * environment per call keeps the module-level `agentsOpen` from leaking between
 * tests.
 */
function loadPortalUi(): PortalUi {
	const source = String(portalHtml);
	const open = source.indexOf("<script>");
	const close = source.lastIndexOf("</script>");
	if (open < 0 || close < 0) throw new Error("portal-ui.html has no inline script");
	const script = source.slice(open + "<script>".length, close);

	const sink: unknown = new Proxy(function noop() {} as unknown as Record<string, unknown>, {
		get: (_target, key) => (key === Symbol.toPrimitive || key === "toString" ? () => "" : sink),
		set: () => true,
		apply: () => sink,
		construct: () => sink as object,
		has: () => true,
	});
	const stubs = {
		document: sink,
		location: { search: "", hash: "", href: "http://127.0.0.1:4098/" },
		addEventListener: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		localStorage: { getItem: () => null, setItem: () => {} },
		EventSource: sink,
		fetch: () => Promise.withResolvers<Response>().promise,
		matchMedia: () => sink,
	};

	const load = new Function(
		"stubs",
		`with (stubs) { ${script}
		return {
			renderSubagents,
			esc,
			elapsedOf,
			setAgentsOpen: value => { agentsOpen = value; },
		}; }`,
	) as (env: typeof stubs) => PortalUi;
	return load(stubs);
}

function row(over: Partial<PortalSubagentRow> = {}): PortalSubagentRow {
	return {
		id: "WireScout",
		agent: "scout",
		status: "running",
		intent: "grep pattern=AgentSnapshot",
		tools: 4,
		tokens: 12_300,
		cost: 0.42,
		durationMs: 8_000,
		startedAt: 1_700_000_000_000,
		...over,
	};
}

describe("portal UI script", () => {
	it("parses and exposes its render functions", () => {
		const ui = loadPortalUi();
		expect(typeof ui.renderSubagents).toBe("function");
	});
});

describe("portal UI subagents panel", () => {
	it("renders nothing at all when the session has no subagents", () => {
		const ui = loadPortalUi();
		// The panel must be absent rather than an empty header: a session that never
		// spawned anything should not pay a row of vertical space to say so.
		expect(ui.renderSubagents({ running: 0, total: 0, rows: [] })).toBe("");
		expect(ui.renderSubagents(null)).toBe("");
	});

	it("escapes every model-produced string it interpolates", () => {
		const ui = loadPortalUi();
		// Ids, labels and tool arguments are all agent-produced or file-derived, and
		// this renderer writes them straight into innerHTML.
		const html = ui.renderSubagents({
			running: 1,
			total: 1,
			rows: [
				row({
					id: '<img src=x onerror="alert(1)">',
					agent: "</span><script>alert(2)</script>",
					task: "\"'&<b>",
					intent: "<svg onload=alert(3)>",
				}),
			],
		});
		// The invariant is that no interpolated value can open a tag or close an
		// attribute — `onerror=` surviving as inert text is fine, an `<img` is not.
		// `>` is deliberately not escaped: it cannot start either.
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("</span><script");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;");
		expect(html).toContain("&lt;/span>&lt;script>alert(2)&lt;/script>");
		expect(html).toContain("&quot;&#39;&amp;&lt;b>");
		expect(html).toContain("&lt;svg onload=alert(3)>");
	});

	it("draws the tree with a trunk until the last row, and indents continuations to the id", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({
			running: 2,
			total: 2,
			rows: [row({ id: "First" }), row({ id: "Second" })],
		});
		// Guides are literal padded box-drawing characters (the CSS keeps them with
		// `white-space: pre`): a branch for every row but the last, and a four-column
		// continuation indent — two for the branch, two for the pinned glyph cell.
		expect(html).toContain('<span class="guide">├ </span>');
		expect(html).toContain('<span class="guide">└ </span>');
		expect(html).toContain('<span class="guide">│   </span>');
		expect(html).toContain('<span class="guide">    </span>');
	});

	it("keeps the trunk on the last row when the cap hid some", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({ running: 12, total: 12, rows: [row(), row({ id: "Other" })] });
		// The `… N more` row is now the last thing in the tree, so no agent row may
		// close it — otherwise the tree ends twice.
		expect(html).toContain("… 10 more");
		expect(html.match(/guide">└ </g)).toHaveLength(1);
	});

	it("shows the live tool while running and the run's volume once finished", () => {
		const ui = loadPortalUi();
		const running = ui.renderSubagents({ running: 1, total: 1, rows: [row()] });
		expect(running).toContain("• grep pattern=AgentSnapshot");
		// A finished agent's last tool is history and would read as though it were
		// still working; what the run cost is the useful thing in that slot.
		const done = ui.renderSubagents({ running: 0, total: 1, rows: [row({ status: "completed" })] });
		expect(done).not.toContain("grep pattern=AgentSnapshot");
		expect(done).toContain("12.3k tok · 4 tools");
		expect(done).toContain("ag-done");
		// A one-tool run is not "1 tools".
		const one = ui.renderSubagents({ running: 0, total: 1, rows: [row({ status: "completed", tools: 1 })] });
		expect(one).toContain("1 tool<");
	});

	it("drops the generic worker name but keeps a specific agent type", () => {
		const ui = loadPortalUi();
		// `AgentRef.displayName` for the default worker is literally `task`, which names
		// nothing and collides with the assignment label on the next line.
		const generic = ui.renderSubagents({ running: 1, total: 1, rows: [row({ agent: "task" })] });
		expect(generic).not.toContain(">task ");
		expect(ui.renderSubagents({ running: 1, total: 1, rows: [row({ agent: "reviewer" })] })).toContain("reviewer");
	});

	it("states both counts in the header, and never calls a failure done", () => {
		const ui = loadPortalUi();
		expect(ui.renderSubagents({ running: 2, total: 5, rows: [row()] })).toContain("2/5 running");
		// "3 done" over three red marks contradicts its own rows.
		const failed = ui.renderSubagents({
			running: 0,
			total: 3,
			rows: [row({ status: "completed" }), row({ id: "B", status: "failed" }), row({ id: "C", status: "aborted" })],
		});
		expect(failed).toContain("1 done · 2 failed");
		// And a payload missing `total` must not print `undefined`.
		const partial = ui.renderSubagents({ rows: [row()] } as unknown as Parameters<PortalUi["renderSubagents"]>[0]);
		expect(partial).not.toContain("undefined");
	});

	it("collapses a wide fan-out by default and expands on request", () => {
		const ui = loadPortalUi();
		const wide = { running: 6, total: 6, rows: Array.from({ length: 6 }, (_, i) => row({ id: `A${i}` })) };
		// Collapsed, the header still answers "how many" — which is the point of the
		// panel — without spending ~470px directly above the composer.
		const collapsed = ui.renderSubagents(wide);
		expect(collapsed).toContain('aria-expanded="false"');
		expect(collapsed).not.toContain("ag-row");
		expect(collapsed).toContain("6/6 running");

		ui.setAgentsOpen(true);
		expect(ui.renderSubagents(wide)).toContain("ag-row");

		// A narrow one is open without being asked.
		ui.setAgentsOpen(null);
		expect(ui.renderSubagents({ running: 2, total: 2, rows: [row(), row({ id: "B" })] })).toContain(
			'aria-expanded="true"',
		);
	});

	it("marks an unknown status as unknown instead of guessing idle", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({ running: 0, total: 1, rows: [row({ status: "surprise" })] });
		expect(html).toContain(">?<");
		// A prototype key must not resolve through Object.prototype either.
		expect(ui.renderSubagents({ running: 0, total: 1, rows: [row({ status: "constructor" })] })).toContain(">?<");
	});

	it("names the status for a screen reader, since the glyph is decorative", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({ running: 1, total: 1, rows: [row()] });
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('<span class="sr">running </span>');
	});

	it("keeps minutes past the hour so a stuck agent is visible", () => {
		const ui = loadPortalUi();
		expect(ui.elapsedOf({ durationMs: 42_000, startedAt: 0 })).toBe("42s");
		expect(ui.elapsedOf({ durationMs: 8 * 60_000, startedAt: 0 })).toBe("8m");
		// A bare `1h` covered 60 through 119 minutes — exactly the range where the
		// number is the reason to go look at the agent.
		expect(ui.elapsedOf({ durationMs: 119 * 60_000, startedAt: 0 })).toBe("1h59m");
		expect(ui.elapsedOf({ durationMs: 120 * 60_000, startedAt: 0 })).toBe("2h");
	});
});
