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
	/**
	 * Every count is optional here even though `PortalSubagents` requires them: this
	 * renderer parses a JSON frame and guards each one, and the guards are part of
	 * what these tests pin.
	 */
	renderSubagents(
		value: {
			running?: number;
			failed?: number;
			parked?: number;
			cost?: number;
			total?: number;
			rows: PortalSubagentRow[];
		} | null,
	): string;
	esc(value: unknown): string;
	elapsedOf(row: { durationMs?: number; startedAt?: number }): string;
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
	// The FIRST close tag, matching the HTML parser: it terminates a `<script>` at
	// `</script` regardless of JS string or comment context. Taking the last one would
	// hand this test a body the browser never runs, which is the same invisibility that
	// let a stray backtick ship.
	const close = source.indexOf("</script>", open);
	if (open < 0 || close < 0) throw new Error("portal-ui.html has no inline script");
	if (source.split("</script>").length !== 2) throw new Error("portal-ui.html has more than one script block");
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
		expect(html).toContain('<span class="guide" aria-hidden="true">├ </span>');
		expect(html).toContain('<span class="guide" aria-hidden="true">└ </span>');
		expect(html).toContain('<span class="guide" aria-hidden="true">│   </span>');
		expect(html).toContain('<span class="guide" aria-hidden="true">    </span>');
		// That four-column indent only lines up with the id if the glyph cell owns a
		// trailing column of its own. The flex row eats the literal space the markup
		// used to carry, so it has to come from CSS — and when it went missing the glyph
		// touched the id and the continuation hung one column to its right.
		const css = String(portalHtml).slice(0, String(portalHtml).indexOf("</style>"));
		expect(css).toMatch(/\.ag-st\s*{[^}]*margin-right:\s*1ch/);
		expect(css).toMatch(/\.ag-st\s*{[^}]*width:\s*1ch/);
		// The primitive is shared with the todos panel, which had the same defects.
		expect(css).toMatch(/\.tree-row\s*{\s*display:\s*flex/);
		expect(css).toMatch(/\.tree-body\s*{[^}]*min-width:\s*0/);
	});

	it("puts the truncation notice on the id column, not two columns left of it", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({ running: 12, total: 12, rows: [row(), row({ id: "Other" })] });
		// The `… N more` row is the last thing in the tree, so no agent row may close it
		// — otherwise the tree ends twice.
		expect(html.match(/guide" aria-hidden="true">└ </g)).toHaveLength(1);
		// And the ellipsis sits in a glyph cell, which is what lands its text on the same
		// column as every id instead of at the guide's own edge.
		expect(html).toContain(
			'<span class="ag-st ag-off" aria-hidden="true">…</span><span class="tree-body ag-more">10 more</span>',
		);
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

	it("draws a single line for an agent with nothing to report", () => {
		const ui = loadPortalUi();
		// Reachable and documented: a spawn whose lifecycle landed before any progress
		// has no label, no tool and no counters. The row is its identity line alone —
		// three `tree-row` divs would mean two of them were empty.
		const bare = { id: "JustStarted", agent: "scout", status: "running", startedAt: Date.now() };
		const html = ui.renderSubagents({ running: 1, total: 1, rows: [bare] });
		expect(html.match(/class="tree-row/g)).toHaveLength(1);
		expect(html).toContain("JustStarted");
		expect(html).not.toContain("ag-what");
		expect(html).not.toContain("ag-task");
	});

	it("drops the generic worker name but keeps a specific agent type", () => {
		const ui = loadPortalUi();
		// `AgentRef.displayName` for the default worker is literally `task`, which names
		// nothing and collides with the assignment label on the next line.
		const generic = ui.renderSubagents({ running: 1, total: 1, rows: [row({ agent: "task" })] });
		expect(generic).not.toContain(">task ");
		expect(ui.renderSubagents({ running: 1, total: 1, rows: [row({ agent: "reviewer" })] })).toContain("reviewer");
	});

	it("keeps the header honest about failures, parked agents and spend", () => {
		const ui = loadPortalUi();
		expect(ui.renderSubagents({ running: 2, failed: 0, total: 5, rows: [row()] })).toContain("2/5 running");
		// "3 done" over three red marks contradicts its own rows.
		const failed = ui.renderSubagents({
			running: 0,
			failed: 2,
			total: 3,
			rows: [row({ status: "completed" }), row({ id: "B", status: "failed" }), row({ id: "C", status: "aborted" })],
		});
		expect(failed).toContain('1 done · <span class="bad">2 failed</span>');
		// A failure has to show WHILE the fan-out runs, because that is when it is
		// actionable and the panel's default state past four rows is collapsed — the
		// header is then the whole panel.
		const live = ui.renderSubagents({ running: 2, failed: 1, total: 4, rows: [row()] });
		expect(live).toContain('2/4 running · <span class="bad">1 failed</span>');
		// Parked is neither done nor failed: it is a disposed but revivable session, and
		// counting it as done claimed work had completed that had not.
		const parked = ui.renderSubagents({ running: 0, failed: 0, parked: 2, total: 3, rows: [row()] });
		expect(parked).toContain("1 done · 2 parked");
		// Counts come from the projection, not the capped rows: deriving them here
		// reported "11 done · 1 failed" for twelve agents whose other four outcomes the
		// phone never received.
		const capped = ui.renderSubagents({
			running: 0,
			failed: 5,
			total: 12,
			rows: [row({ status: "completed" }), row({ id: "B", status: "failed" })],
		});
		expect(capped).toContain("7 done");
		expect(capped).toContain("5 failed");
		expect(capped).toContain("10 more");
		// Spend is aggregated host-side so it survives the collapse.
		expect(ui.renderSubagents({ running: 2, total: 2, cost: 10.66, rows: [row()] })).toContain("$10.66");
		// And a payload missing the counts must not print `undefined`.
		const partial = ui.renderSubagents({ rows: [row()] });
		expect(partial).not.toContain("undefined");
	});

	it("collapses a wide fan-out by default and expands on request", () => {
		const ui = loadPortalUi();
		const wide = { running: 6, total: 6, rows: Array.from({ length: 6 }, (_, i) => row({ id: `A${i}` })) };
		// Collapsed, the header still answers "how many" — which is the point of the
		// panel — without spending ~470px directly above the composer.
		const collapsed = ui.renderSubagents(wide);
		expect(collapsed).toContain('aria-expanded="false"');
		expect(collapsed).not.toContain("tree-row");
		expect(collapsed).toContain("6/6 running");
		// `aria-controls` must not point at a list that is not in the document.
		expect(collapsed).not.toContain("aria-controls");

		ui.setAgentsOpen(true);
		const expanded = ui.renderSubagents(wide);
		expect(expanded).toContain("tree-row");
		expect(expanded).toContain('aria-controls="aglist"');

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

	it("names the status for a screen reader and groups each agent as one list item", () => {
		const ui = loadPortalUi();
		const html = ui.renderSubagents({ running: 1, total: 1, rows: [row({ task: "audit the presets" })] });
		expect(html).toContain('<span class="sr">running </span>');
		// The tree art is decoration; announcing `├ ` before every line was three
		// announcements of noise per agent on the block that changes most often.
		expect(html).toContain('<span class="guide" aria-hidden="true">');
		expect(html).not.toMatch(/<span class="guide">/);
		// One item per agent, not per line: its 1-3 rows belong together, and a flat run
		// of divs gave assistive tech no count and no way to step agent by agent.
		expect(html).toContain('role="list"');
		expect(html.match(/role="listitem"/g)).toHaveLength(1);
	});

	it("keeps a parked agent out of the finished treatment", () => {
		const ui = loadPortalUi();
		// Parked means the session was disposed but the ref is revivable — frequently an
		// agent waiting on its parent. Dimming it like a completed one overstated it.
		const parked = ui.renderSubagents({ running: 0, parked: 1, total: 1, rows: [row({ status: "parked" })] });
		expect(parked).not.toContain("ag-done");
		expect(ui.renderSubagents({ running: 0, total: 1, rows: [row({ status: "completed" })] })).toContain("ag-done");
	});

	it("keeps minutes past the hour, and prints nothing rather than NaN", () => {
		const ui = loadPortalUi();
		expect(ui.elapsedOf({ durationMs: 42_000, startedAt: 0 })).toBe("42s");
		expect(ui.elapsedOf({ durationMs: 8 * 60_000, startedAt: 0 })).toBe("8m");
		// A bare `1h` covered 60 through 119 minutes — exactly the range where the
		// number is the reason to go look at the agent.
		expect(ui.elapsedOf({ durationMs: 119 * 60_000, startedAt: 0 })).toBe("1h59m");
		expect(ui.elapsedOf({ durationMs: 120 * 60_000, startedAt: 0 })).toBe("2h");
		// With neither field, `Date.now() - undefined` is NaN and every comparison below
		// it is false, so the row printed `NaNh`. An empty string drops out of the join.
		expect(ui.elapsedOf({})).toBe("");
	});
});
