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

interface PortalTranscriptItem {
	kind: string;
	text?: string;
	name?: string;
	id?: string;
	args?: Record<string, unknown>;
	output?: string;
	isError?: boolean;
	stats?: { added: number; removed: number };
	from?: string;
}

interface PortalTodoPhase {
	name: string;
	tasks: { content: string; status: string }[];
}

interface PortalContextUsage {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
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
	keyboardInsetOf(layoutHeight: number, viewport: { height: number; offsetTop: number; scale: number } | null): number;
	renderTranscript(items: PortalTranscriptItem[]): string;
	renderTodos(phases: PortalTodoPhase[] | null): string;
	toolIdentity(item: PortalTranscriptItem): string;
	contextText(usage: PortalContextUsage | null): string;
	contextClass(usage: PortalContextUsage | null): string;
	durationText(ms: number): string;
	setExpandedTools(ids: string[]): void;
}

function portalScript(): string {
	const source = String(portalHtml);
	const open = source.indexOf("<script>");
	// The FIRST close tag, matching the HTML parser: it terminates a `<script>` at
	// `</script` regardless of JS string or comment context. Taking the last one would
	// hand this test a body the browser never runs, which is the same invisibility that
	// let a stray backtick ship.
	const close = source.indexOf("</script>", open);
	if (open < 0 || close < 0) throw new Error("portal-ui.html has no inline script");
	if (source.split("</script>").length !== 2) throw new Error("portal-ui.html has more than one script block");
	return source.slice(open + "<script>".length, close);
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
	const script = portalScript();

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
			keyboardInsetOf,
			renderTranscript,
			renderTodos,
			toolIdentity,
			contextText,
			contextClass,
			durationText,
			setAgentsOpen: value => { agentsOpen = value; },
			setExpandedTools: ids => { expandedTools = new Set(ids); },
		}; }`,
	) as (env: typeof stubs) => PortalUi;
	return load(stubs);
}

interface PortalElementStub {
	hidden: boolean;
	value: string;
	dataset: Record<string, string>;
	style: Record<string, string>;
	classList: {
		add(...names: string[]): void;
		remove(...names: string[]): void;
		toggle(name: string, on?: boolean): void;
	};
	textContent: string;
	innerHTML: string;
	placeholder: string;
	className: string;
	title: string;
	disabled: boolean;
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
	onclick?: () => void;
	/**
	 * Delegated listeners the script installs, keyed by event type, so a test can
	 * fire one. The transcript's tool cards are toggled through exactly one such
	 * listener on `#log`.
	 */
	listeners: Map<string, ((event: unknown) => void)[]>;
	addEventListener(type: string, handler: (event: unknown) => void): void;
	dispatch(type: string, event: unknown): void;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): PortalElementStub | null;
	querySelectorAll(selector: string): PortalElementStub[];
}

interface PortalHistoryStub {
	state: unknown;
	backCalls: number;
	pushCalls: number;
	replaceCalls: number;
	back(): void;
	pushState(state: unknown, title: string, next: string): void;
	replaceState(state: unknown, title: string, next: string): void;
}

interface PortalNavigationHarness {
	open(pid: number): void;
	pressBack(): void;
	current(): number | null;
	location: { origin: string; pathname: string; search: string; hash: string; href: string };
	history: PortalHistoryStub;
	list: PortalElementStub;
}

function loadPortalNavigation(options: { hash?: string; state?: unknown } = {}): PortalNavigationHarness {
	const script = portalScript();
	/*
	 * `querySelector` answers with a stub rather than `null`, cached per selector so
	 * two lookups of the same child are the same object. The composer's chrome lives
	 * on wrapper elements the script reaches for by class (`.input-row`, `.field`),
	 * and a `null` there is not a faithful stand-in for the real DOM — it is a
	 * missing element, which the script is right to fail on.
	 */
	const makeElement = (): PortalElementStub => {
		const attributes = new Map<string, string>();
		const children = new Map<string, PortalElementStub>();
		const classes = new Set<string>();
		const element: PortalElementStub = {
			hidden: false,
			value: "",
			dataset: {},
			style: {},
			classList: {
				add: (...names) => {
					for (const name of names) classes.add(name);
				},
				remove: (...names) => {
					for (const name of names) classes.delete(name);
				},
				toggle: (name, on) => {
					if (on ?? !classes.has(name)) classes.add(name);
					else classes.delete(name);
				},
			},
			textContent: "",
			innerHTML: "",
			placeholder: "",
			className: "",
			title: "",
			disabled: false,
			scrollTop: 0,
			clientHeight: 0,
			scrollHeight: 0,
			listeners: new Map(),
			addEventListener: (type, handler) => {
				const existing = element.listeners.get(type);
				if (existing) existing.push(handler);
				else element.listeners.set(type, [handler]);
			},
			dispatch: (type, event) => {
				for (const handler of element.listeners.get(type) ?? []) handler(event);
			},
			setAttribute: (name, value) => attributes.set(name, value),
			removeAttribute: name => attributes.delete(name),
			getAttribute: name => attributes.get(name) ?? null,
			querySelector: selector => {
				let child = children.get(selector);
				if (!child) {
					child = makeElement();
					children.set(selector, child);
				}
				return child;
			},
			querySelectorAll: () => [],
		};
		return element;
	};
	const elements = new Map<string, PortalElementStub>();
	const getElement = (id: string): PortalElementStub => {
		let element = elements.get(id);
		if (!element) {
			element = makeElement();
			elements.set(id, element);
		}
		return element;
	};

	const origin = "http://127.0.0.1:4098";
	const location = {
		origin,
		pathname: "/",
		search: "",
		hash: options.hash ?? "",
		href: `${origin}/${options.hash ?? ""}`,
	};
	const applyUrl = (next: string): void => {
		const resolved = new URL(next, location.href);
		location.pathname = resolved.pathname;
		location.search = resolved.search;
		location.hash = resolved.hash;
		location.href = resolved.href;
	};
	const history: PortalHistoryStub = {
		state: options.state ?? null,
		backCalls: 0,
		pushCalls: 0,
		replaceCalls: 0,
		back() {
			this.backCalls++;
		},
		pushState(state, _title, next) {
			this.state = state;
			this.pushCalls++;
			applyUrl(next);
		},
		replaceState(state, _title, next) {
			this.state = state;
			this.replaceCalls++;
			applyUrl(next);
		},
	};
	const sink: unknown = new Proxy(function noop() {} as unknown as Record<string, unknown>, {
		get: (_target, key) => (key === Symbol.toPrimitive || key === "toString" ? () => "" : sink),
		set: () => true,
		apply: () => sink,
		construct: () => sink as object,
		has: () => true,
	});
	const document = {
		documentElement: { dataset: {} },
		getElementById: getElement,
		querySelector: (selector: string) => (selector === "main" ? getElement("main") : null),
		querySelectorAll: () => [] as PortalElementStub[],
		createElement: () => makeElement(),
	};
	const stubs = {
		document,
		location,
		history,
		addEventListener: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		localStorage: { getItem: () => null, setItem: () => {} },
		EventSource: sink,
		fetch: () => Promise.withResolvers<Response>().promise,
		matchMedia: () => sink,
		// `open()` calls `syncComposer`, which reads the field's row height and five-row
		// cap off the stylesheet on its first call: without this the harness throws
		// before it reaches the navigation behaviour under test. The values are the ones
		// `#msg` resolves to in a browser, but nothing here asserts on them — this stub
		// exists to let the script run, not to cover the composer's sizing, which is
		// exercised against a real engine instead.
		getComputedStyle: () => ({ lineHeight: "21px", maxHeight: "105px" }),
	};
	const load = new Function(
		"stubs",
		`with (stubs) { ${script}
		return {
			open,
			pressBack: () => document.getElementById("back").onclick(),
			current: () => current,
		}; }`,
	) as (env: typeof stubs) => Pick<PortalNavigationHarness, "open" | "pressBack" | "current">;
	return { ...load(stubs), location, history, list: getElement("list") };
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

/**
 * Every font size that lands on a text-entry control, as the browser would resolve
 * it from this file's one stylesheet.
 *
 * There is no cascade model here and there does not need to be, but there does need
 * to be enough of one that the plausible ways of reintroducing a sub-16px field are
 * caught rather than stepped over. Three shapes matter and all three were misses in
 * the first version of this scan:
 *
 *  - the `font:` SHORTHAND, which also sets `font-size`. The stylesheet already has
 *    an adjacent `font: inherit` / `font-size:` pair on these very selectors, so
 *    merging them into one shorthand is the single most likely future edit.
 *  - a SECOND `--input-size` declaration, e.g. inside a `@media` block, which would
 *    lower the token everywhere while the rule that reads it still looks correct.
 *  - a COMPOUND selector such as `#msg.err`, which a "field name followed by a
 *    delimiter" test rejects.
 */
function fieldFontSizes(): { selector: string; px: number }[] {
	const source = String(portalHtml);
	// Comments are stripped first, and not for tidiness: this file's rules carry long
	// prose comments, and an unstripped one becomes part of the following rule's
	// selector text — so a comment that merely mentions an input would pull an
	// unrelated rule's font-size into the result.
	const style = source
		.slice(source.indexOf("<style>") + "<style>".length, source.indexOf("</style>"))
		.replace(/\/\*[\s\S]*?\*\//g, "");
	const tokens = [...style.matchAll(/--input-size:\s*([^;}]+)/g)].map(match => match[1].trim());
	if (tokens.length === 0) throw new Error("portal-ui.html no longer declares --input-size");
	// More than one and the effective value depends on a cascade this scan does not
	// model, so the guard would be reporting on the wrong declaration.
	if (tokens.length > 1) throw new Error(`--input-size is declared ${tokens.length} times; this guard assumes one`);
	const inputSize = Number.parseFloat(tokens[0]);
	const fields = /(^|[\s,>])(input|textarea|select|#msg|#newdir|#newsuggest)\b/;
	const sizes: { selector: string; px: number }[] = [];
	/* Lengths are converted rather than parsed raw, or `font: 1rem …` — a valid 16px
	   declaration — reads as 1 and fails the floor with the message of a real
	   regression. `rem` is the 16px root; `em` is the *parent's* size, which for every
	   one of these selectors is the 12px body, so `1em` on a field really is a 12px
	   field and has to fail; `pt` is 4/3 of a px.

	   Anything this cannot read resolves to 0 rather than being skipped — a keyword
	   like `smaller`, an unknown unit, a `calc()` around the token. The guard's whole
	   job is to refuse a size it cannot vouch for, and dropping those rows silently is
	   how `font-size: calc(var(--input-size) - 4px)` would report a compliant 16. */
	const PX_PER_UNIT: Record<string, number> = { px: 1, rem: 16, em: 12, pt: 4 / 3 };
	const sizeOf = (value: string): number => {
		const declared = value.trim();
		if (declared === "var(--input-size)") return inputSize;
		if (declared.includes("var(--input-size)")) return 0;
		const length = /((?:\d*\.)?\d+)([a-z%]*)/.exec(declared);
		if (!length) return 0;
		return Number.parseFloat(length[1]) * (PX_PER_UNIT[length[2]] ?? 0);
	};
	for (const [, selector, body] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!fields.test(selector)) continue;
		for (const [, value] of body.matchAll(/(?:^|;)\s*font-size:\s*([^;]+)/g)) {
			sizes.push({ selector: selector.trim(), px: sizeOf(value) });
		}
		// `font:` carries a size in every valid form except `inherit`/`initial`/`unset`,
		// and it resets `font-size` whether or not the author meant to.
		for (const [, value] of body.matchAll(/(?:^|;)\s*font:\s*([^;]+)/g)) {
			const shorthand = value.trim();
			if (/^(inherit|initial|unset|revert)$/.test(shorthand)) continue;
			// The size is the first token carrying a LENGTH unit: a shorthand leads with
			// style, variant and weight, and `font: 400 13px/1.5 …` would otherwise be read
			// as a 400px field.
			const size = /(?:^|[\s/])((?:\d*\.)?\d+(?:px|rem|em|pt))/.exec(shorthand);
			// A shorthand whose size cannot be read is reported as 0 rather than skipped:
			// an unreadable size on a field is exactly the state this must not wave through.
			sizes.push({ selector: selector.trim(), px: size ? sizeOf(size[1]) : 0 });
		}
	}
	return sizes;
}

describe("portal UI composer", () => {
	/*
	 * The defect this pins is not cosmetic and is invisible to every other check:
	 * WebKit zooms the page when a control whose computed font-size is under 16px
	 * takes focus, and on iOS it never zooms back out — the layout viewport stays
	 * wider than the screen for the rest of the visit. The portal's body type is
	 * 12px and the fields used to inherit it, so tapping the composer displaced the
	 * whole app. `user-scalable=no` is not a fix (WebKit ignores it by design), so
	 * the floor is the fix and a rule that reintroduces 12px on a field is the
	 * regression.
	 */
	it("keeps every text-entry control at or above WebKit's 16px focus-zoom floor", () => {
		const sizes = fieldFontSizes();
		expect(sizes.length).toBeGreaterThan(0);
		expect(sizes.filter(size => size.px < 16)).toEqual([]);
	});

	it("gives the steer field a growable textarea rather than a one-line input", () => {
		const source = String(portalHtml);
		expect(source).toContain('<textarea id="msg"');
		expect(source).not.toMatch(/<input id="msg"/);
	});
});

describe("portal UI keyboard inset", () => {
	it("measures the covered height when only the visual viewport shrank", () => {
		const ui = loadPortalUi();
		// iOS: the layout viewport (and therefore `dvh`) stays at 844 while the
		// keyboard takes 336 of it. That difference is what the shell resizes by.
		expect(ui.keyboardInsetOf(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336);
	});

	it("counts a document WebKit already scrolled as covered, not as extra room", () => {
		const ui = loadPortalUi();
		// WebKit chases the caret by scrolling the visual viewport down inside the
		// layout viewport. Ignoring `offsetTop` would under-measure by exactly that
		// scroll and leave the composer behind the keyboard.
		expect(ui.keyboardInsetOf(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216);
	});

	it("reports nothing when the layout viewport resized itself", () => {
		const ui = loadPortalUi();
		// Chrome on Android with `interactive-widget=resizes-content`: both viewports
		// moved together, `100dvh` is already correct, and overriding it would fight
		// the browser.
		expect(ui.keyboardInsetOf(508, { height: 508, offsetTop: 0, scale: 1 })).toBe(0);
	});

	it("reports nothing for a pinch-zoom, which shrinks the visual viewport too", () => {
		const ui = loadPortalUi();
		// Binding the shell to a zoomed viewport would re-lay-out the app under the
		// pan the user is performing.
		expect(ui.keyboardInsetOf(844, { height: 300, offsetTop: 40, scale: 2.4 })).toBe(0);
	});

	it("ignores the few pixels a collapsing browser toolbar moves", () => {
		const ui = loadPortalUi();
		expect(ui.keyboardInsetOf(844, { height: 800, offsetTop: 0, scale: 1 })).toBe(0);
	});

	it("reports nothing when the browser has no visual viewport at all", () => {
		const ui = loadPortalUi();
		expect(ui.keyboardInsetOf(844, null)).toBe(0);
	});
});

describe("portal UI session history", () => {
	it("pushes a marked entry for a card-opened session and unwinds to the list", () => {
		const harness = loadPortalNavigation();
		harness.open(42);
		expect(harness.location.hash).toBe("#42");
		expect(harness.history.pushCalls).toBe(1);
		expect(harness.history.state).toEqual({ __ompSessionFromList: true });

		harness.pressBack();
		expect(harness.history.backCalls).toBe(1);
		expect(harness.history.replaceCalls).toBe(0);
	});

	it("keeps unwinding a marked detail entry restored by Forward or reload", () => {
		const harness = loadPortalNavigation({
			hash: "#42",
			state: { __ompSessionFromList: true },
		});
		harness.open(42);
		expect(harness.history.pushCalls).toBe(0);

		harness.pressBack();
		expect(harness.history.backCalls).toBe(1);
		expect(harness.history.replaceCalls).toBe(0);
	});

	it("strips a cold-opened deep-link hash in place instead of returning to login", () => {
		const harness = loadPortalNavigation({ hash: "#42" });
		harness.open(42);
		harness.pressBack();

		expect(harness.history.backCalls).toBe(0);
		expect(harness.history.replaceCalls).toBe(1);
		expect(harness.location.hash).toBe("");
		expect(harness.current()).toBeNull();
		expect(harness.list.hidden).toBe(false);
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

/**
 * The transcript's TUI parity. These renderers are what makes a card on the phone
 * read like the row the terminal drew for the same call, and every one of the
 * assertions below stands for a shape that was wrong at some point during the port:
 * an edit card with no path, a card that wrapped to three rows, a transcript blanked
 * because its tail was all reasoning.
 */
describe("portal UI transcript cards", () => {
	const tool = (over: Partial<PortalTranscriptItem> = {}): PortalTranscriptItem => ({
		kind: "tool",
		id: "call-1",
		name: "bash",
		args: { command: "ls -la" },
		...over,
	});

	it("renders a settled card as its identity row plus the expand hint", () => {
		const ui = loadPortalUi();
		const html = ui.renderTranscript([tool({ output: "a\nb\nc" })]);
		expect(html).toContain("❯");
		expect(html).toContain("Bash");
		expect(html).toContain("ls -la");
		// The whole card is the hit zone, so it is the button.
		expect(html).toContain('data-toggle="call-1"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("⟦click to expand⟧");
		// Collapsed means the identity ALONE: `OUTPUT_SETTLED` drops even the one
		// preview row the terminal keeps.
		expect(html).not.toContain("tool-body");
	});

	it("shows the output and offers a collapse once expanded", () => {
		const ui = loadPortalUi();
		ui.setExpandedTools(["call-1"]);
		const html = ui.renderTranscript([tool({ output: "first\nsecond" })]);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("first\nsecond");
		// The terminal drops the hint when open because its hover fill still marks the
		// card as live; a touch screen has no hover, so the label has to say so.
		expect(html).toContain("⟦collapse⟧");
		expect(html).not.toContain("⟦click to expand⟧");
	});

	it("leaves a card with no output inert rather than silently untappable", () => {
		const ui = loadPortalUi();
		const html = ui.renderTranscript([tool({ output: "" })]);
		expect(html).not.toContain("data-toggle");
		expect(html).not.toContain("⟦click to expand⟧");
		// Still a card, still identified.
		expect(html).toContain("Bash");
	});

	it("names the expanded remainder instead of pushing an unbounded body at the phone", () => {
		const ui = loadPortalUi();
		ui.setExpandedTools(["call-1"]);
		const rows = Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n");
		const html = ui.renderTranscript([tool({ output: rows })]);
		expect(html).toContain("line 199");
		expect(html).not.toContain("line 200");
		expect(html).toContain("… 60 more lines");
	});

	it("does not render reasoning at all", () => {
		const ui = loadPortalUi();
		// The item still crosses the wire and is still projected; this surface simply
		// draws nothing for it, which is what `hideThinkingBlock` does in the TUI.
		expect(ui.renderTranscript([{ kind: "thinking", text: "weighing the options" }])).toBe("");
		// And a tail made only of reasoning renders to nothing, which is what lets the
		// caller fall back to the empty-log guide.
		expect(
			ui.renderTranscript([
				{ kind: "thinking", text: "one" },
				{ kind: "thinking", text: "two" },
			]),
		).toBe("");
	});

	it("draws a user prompt as a filled bubble with no chevron", () => {
		const ui = loadPortalUi();
		const html = ui.renderTranscript([{ kind: "user", text: "ship it" }]);
		expect(html).toContain("user-line");
		expect(html).toContain("ship it");
		// The `❯ ` this used to print was a portal invention: the terminal separates a
		// prompt from the prose around it with `userMessageBg` alone.
		expect(html).not.toContain("❯");
	});

	it("counts a write's own content as the change badge", () => {
		const ui = loadPortalUi();
		const html = ui.toolIdentity(tool({ name: "write", args: { path: "/tmp/x/a.ts", content: "one\ntwo\nthree" } }));
		expect(html).toContain("Write");
		expect(html).toContain("+3");
		expect(html).not.toContain("-0");
		// The language icon the TUI puts in front of the path.
		expect(html).toContain("🟦");
	});

	it("recovers an edit's path from the hashline patch it was given", () => {
		const ui = loadPortalUi();
		// The hashline edit mode's arguments are `{ i, input }` — there is no `path`
		// field at all, and without parsing the section header every edit card in a
		// transcript read `✎ Edit` and nothing else.
		const html = ui.toolIdentity(
			tool({
				name: "edit",
				args: { input: "[/Users/someone/proj/src/main.rs#C051]\nCUT 83.=83\n" },
				stats: { added: 4, removed: 11 },
			}),
		);
		expect(html).toContain("~/proj/src/main.rs");
		expect(html).toContain("+4");
		expect(html).toContain("-11");
		expect(html).toContain("🦀");
	});

	it("names every file a multi-file patch touches by count", () => {
		const ui = loadPortalUi();
		const html = ui.toolIdentity(
			tool({
				name: "edit",
				args: { input: "[a/one.ts#AAAA]\nCUT 1.=1\n[b/two.ts#BBBB]\nCUT 2.=2\n" },
			}),
		);
		expect(html).toContain("a/one.ts +1 more");
	});

	it("takes an edit's path straight from the patch and replace modes", () => {
		const ui = loadPortalUi();
		// `patch` and `replace` modes carry `path` outright; which mode a host runs is a
		// setting, so both shapes have to work.
		expect(ui.toolIdentity(tool({ name: "edit", args: { path: "/tmp/p/x.py", edits: [] } }))).toContain(
			"/tmp/p/x.py",
		);
	});

	it("appends a read's line range and omits the colon the terminal omits", () => {
		const ui = loadPortalUi();
		const ranged = ui.toolIdentity(tool({ name: "read", args: { path: "/tmp/p/f.txt", offset: 1295, limit: 8 } }));
		expect(ranged).toContain(":1295-1302");
		// `read-tool-group.ts` builds `● Read <path>` — a space, not `Read:`.
		expect(ranged).not.toContain("Read</span>:");
		// A spec that already carries its own selector is left alone.
		expect(ui.toolIdentity(tool({ name: "read", args: { path: "/tmp/p/f.txt:10-20" } }))).toContain(":10-20");
	});

	it("summarises a task batch by the names it spawned", () => {
		const ui = loadPortalUi();
		const batch = ui.toolIdentity(
			tool({ name: "task", args: { context: "…", tasks: [{ name: "ScoutOne" }, { name: "ScoutTwo" }] } }),
		);
		expect(batch).toContain("ScoutOne · ScoutTwo");
		// A single spawn is titled by its agent type, the way `formatAgentHeaderLabel` does.
		expect(ui.toolIdentity(tool({ name: "task", args: { agent: "scout" } }))).toContain("scout");
	});

	it("marks an errored call with the error glyph", () => {
		const ui = loadPortalUi();
		const html = ui.renderTranscript([tool({ isError: true, output: "boom" })]);
		expect(html).toContain("✘");
		expect(html).toContain("tool err");
	});
});

describe("portal UI todos panel", () => {
	const phases = [
		{ name: "Scout", tasks: [{ content: "read the repo", status: "completed" }] },
		{
			name: "Implement",
			tasks: [
				{ content: "write it", status: "in_progress" },
				{ content: "waiting on review", status: "blocked" },
			],
		},
		{ name: "Land", tasks: [{ content: "merge", status: "pending" }] },
	];

	it("labels phases with roman numerals and marks the active one", () => {
		const ui = loadPortalUi();
		const html = ui.renderTodos(phases);
		expect(html).toContain("I. Scout");
		expect(html).toContain("II. Implement");
		expect(html).toContain("III. Land");
		// `#getActivePhase`: the first phase with work left. Scout is done, so Implement
		// carries the accent and Scout does not.
		expect(html).toContain('class="tree-body phase now">II. Implement');
		expect(html).toContain('class="tree-body phase">I. Scout');
	});

	it("states which phase is active, not how many tasks are done", () => {
		const ui = loadPortalUi();
		// The TUI header answers "which stage" (`activeIdx + 1`/total); the per-phase
		// rows answer "how much of it".
		expect(ui.renderTodos(phases)).toContain('Todos<span class="count"> · 2/3</span>');
		// A single-phase plan has no stage progression to state.
		expect(ui.renderTodos([phases[0]!])).toContain('<div class="todos-h">Todos</div>');
	});

	it("carries the checkbox glyphs and the status palette", () => {
		const ui = loadPortalUi();
		const html = ui.renderTodos(phases);
		expect(html).toContain("☑ read the repo");
		expect(html).toContain("☐ write it");
		expect(html).toContain("task done");
		expect(html).toContain("task now");
		// `formatTodoLine` appends the word, it does not only recolour the row.
		expect(html).toContain("☐ waiting on review (blocked)");
	});

	it("draws the two-character tree guides the terminal draws", () => {
		const ui = loadPortalUi();
		const html = ui.renderTodos(phases);
		expect(html).toContain("├─");
		expect(html).toContain("└─");
		// `getTreeContinuePrefix`: `│  ` under a branch, three spaces under the last.
		expect(html).toContain("│  ├─");
	});

	it("renders nothing for an empty or taskless plan", () => {
		const ui = loadPortalUi();
		expect(ui.renderTodos(null)).toBe("");
		expect(ui.renderTodos([])).toBe("");
		expect(ui.renderTodos([{ name: "Empty", tasks: [] }])).toBe("");
	});
});

describe("portal UI status-line formatters", () => {
	it("formats context usage the way the status line does", () => {
		const ui = loadPortalUi();
		expect(ui.contextText({ percent: 22.1, contextWindow: 984_000, tokens: 217_000 })).toBe("22.1%/984K");
		// An unknown window degrades to `<tokens>/?` rather than claiming `0.0%/0`.
		expect(ui.contextText({ percent: null, contextWindow: null, tokens: 1500 })).toBe("1.5K/?");
		expect(ui.contextText(null)).toBe("");
	});

	it("colours context by whichever bound is reached first", () => {
		const ui = loadPortalUi();
		// On a 984K window the TOKEN bounds dominate: 150K is 15.2%, so 22.1% is
		// already `warning` even though it is far below the 50% flat threshold.
		expect(ui.contextClass({ percent: 22.1, contextWindow: 984_000 })).toBe("warn");
		expect(ui.contextClass({ percent: 10, contextWindow: 984_000 })).toBe("");
		expect(ui.contextClass({ percent: 30, contextWindow: 984_000 })).toBe("high");
		expect(ui.contextClass({ percent: 60, contextWindow: 984_000 })).toBe("crit");
		// With no window the flat percentages are all there is.
		expect(ui.contextClass({ percent: 60, contextWindow: null })).toBe("warn");
	});

	it("formats durations without a space, dropping a zero unit", () => {
		const ui = loadPortalUi();
		expect(ui.durationText(44 * 60_000 + 58_000)).toBe("44m58s");
		expect(ui.durationText(8 * 60_000)).toBe("8m");
		expect(ui.durationText(2 * 3_600_000 + 30 * 60_000)).toBe("2h30m");
		expect(ui.durationText(3 * 86_400_000 + 2 * 3_600_000)).toBe("3d2h");
		expect(ui.durationText(0)).toBe("");
	});
});
