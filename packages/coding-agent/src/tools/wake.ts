/**
 * The `wake` tool — the agent's own alarm clock.
 *
 * One tool covers three ops so the model never has to remember three names:
 * omit `op` to create a schedule, `op: "list"` to see what is armed, and
 * `op: "cancel"` to retire one. Every validation rule lives in
 * `src/wake/schedule.ts` (`buildWakeSchedule` returns a ready-to-show sentence),
 * so this file only routes ops, mutates the session's schedule list, and
 * formats the reply.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import wakeDescription from "../prompts/tools/wake.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import { buildWakeSchedule, describeWakeSchedule, type WakeSchedule } from "../wake/schedule";
import { createCachedComponent, formatErrorMessage, replaceTabs } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

/** Which branch of the tool ran. `create` is the `op`-omitted default. */
export type WakeToolOp = "create" | "list" | "cancel";

export interface WakeToolDetails {
	op: WakeToolOp;
	/** Live schedule list as of this call, so the renderer never re-parses the result text. */
	schedules: WakeSchedule[];
	/** The id this call created (`create`) or retired (`cancel`); absent on `list`. */
	targetId?: string;
	/**
	 * Clock the result text was computed against. The renderer MUST reuse it:
	 * a transcript is repainted long after the call, and recomputing "in 4h"
	 * against render time would drift the number away from what the model read.
	 */
	nowMs: number;
}

// =============================================================================
// Schema
// =============================================================================

/**
 * Every field is optional: `op` selects the branch and each branch needs a
 * different subset. Cross-field requirements are enforced in `execute`, which
 * can name the missing or stray argument in a sentence the model can act on.
 */
const wakeSchema = type({
	"op?": type('"list" | "cancel"').describe("`list` shows armed wakes, `cancel` retires one; omit to schedule"),
	"message?": type("string").describe("prompt text delivered when the wake fires"),
	"at?": type("string").describe("when to fire: `+90m`, `HH:MM`, or an ISO-8601 timestamp"),
	"every?": type("string").describe("recurrence interval: `15m`, `4h`, `1d`, `1w` (minimum 1m)"),
	"until?": type("string").describe("hard stop for a recurring wake, same forms as `at`"),
	"limit?": type("number").describe("retire after this many deliveries (needs `every`)"),
	"id?": type("string").describe("wake handle to cancel, e.g. `w1`"),
}).describe("schedule, list, or cancel a self-prompt delivered later in this same session");

type WakeParams = typeof wakeSchema.infer;

/** Fields that only mean something when creating a schedule. */
const CREATE_FIELDS = ["message", "at", "every", "until", "limit"] as const;

/** How much of a schedule's prompt text a listing echoes back. */
const WAKE_MESSAGE_PREVIEW_CHARS = 80;

const WAKE_GLYPH = "⏰";

// =============================================================================
// Formatting
// =============================================================================

/** Single-line, length-capped echo of a schedule's prompt text. */
function previewMessage(message: string): string {
	const flat = message.replace(/\s+/g, " ").trim();
	return flat.length > WAKE_MESSAGE_PREVIEW_CHARS ? `${flat.slice(0, WAKE_MESSAGE_PREVIEW_CHARS - 1)}…` : flat;
}

/** "1 wake" / "3 wakes" — the count reads in almost every reply. */
function wakeCount(count: number): string {
	return `${count} wake${count === 1 ? "" : "s"}`;
}

/**
 * A rejection carries the pre-call schedule list so the transcript keeps
 * showing the state that actually exists, not the one the call asked for.
 */
function fail(
	message: string,
	op: WakeToolOp,
	schedules: WakeSchedule[],
	nowMs: number,
	targetId?: string,
): AgentToolResult<WakeToolDetails> {
	const details: WakeToolDetails = { op, schedules, nowMs };
	if (targetId !== undefined) details.targetId = targetId;
	return { content: [{ type: "text", text: message }], details, isError: true };
}

// =============================================================================
// Tool Class
// =============================================================================

export class WakeTool implements AgentTool<typeof wakeSchema, WakeToolDetails> {
	readonly name = "wake";
	readonly approval = "read" as const;
	readonly label = "Wake";
	readonly summary = "Schedule a self-prompt to arrive later in this session, once or on a cadence";
	readonly description: string;
	readonly parameters = wakeSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	/** Reads then rewrites the whole schedule list; two concurrent calls would lose one. */
	readonly concurrency = "exclusive";
	// Top-level like todo/hub: a schedule request arrives in plain language and
	// must be answerable in one call — the xd:// hop makes models guess
	// `tool.wake()` in the eval runtime instead (observed end to end), which
	// resolves against the top-level set and fails outright.
	readonly loadMode = "essential";

	readonly examples: readonly ToolExample<WakeParams>[] = [
		{
			caption: "One-shot at the next local midnight",
			call: { at: "00:00", message: "Post the end-of-day summary of what landed today." },
		},
		{
			caption: "Hourly for a week",
			call: { every: "1h", until: "+7d", message: "Check MR !412's pipeline; report only if it changed state." },
		},
		{
			caption: "Daily at 09:00",
			call: { at: "09:00", every: "1d", message: "Re-run the flake triage and update the tally." },
		},
		{
			caption: "Eight checks, then stop on its own",
			call: { every: "15m", limit: 8, message: "Poll the rollout; cancel early if it goes green." },
		},
		{
			caption: "Show what is armed",
			call: { op: "list" },
		},
		{
			caption: "Retire a wake once its goal is met",
			call: { op: "cancel", id: "w1" },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(wakeDescription);
	}

	/**
	 * Top-level sessions only. A subagent's session is disposed the moment it
	 * yields, so any wake it armed would be dropped before it could fire —
	 * offering the tool there would promise a delivery that never happens.
	 */
	static createIf(session: ToolSession): WakeTool | null {
		if (!session.getWakeSchedules || !session.setWakeSchedules) return null;
		if ((session.taskDepth ?? 0) !== 0) return null;
		return new WakeTool(session);
	}

	async execute(
		_toolCallId: string,
		params: WakeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WakeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WakeToolDetails>> {
		const nowMs = Date.now();
		const existing = this.session.getWakeSchedules?.() ?? [];
		const op: WakeToolOp = params.op ?? "create";
		const strayCreateFields = CREATE_FIELDS.filter(field => params[field] !== undefined);

		// Arguments belonging to another op are a malformed call, not noise to
		// drop: silently ignoring `message` on a `list` leaves the model
		// believing it scheduled work that never existed.
		if (op === "list") {
			const stray = [...strayCreateFields, ...(params.id === undefined ? [] : ["id"])];
			if (stray.length > 0) {
				const names = stray.map(field => `\`${field}\``).join(", ");
				return fail(
					`\`op: "list"\` takes no other arguments, but got ${names}. Nothing was scheduled or cancelled — list first, then make the other call separately.`,
					op,
					existing,
					nowMs,
				);
			}
			return this.#list(existing, nowMs);
		}

		if (op === "cancel") {
			if (strayCreateFields.length > 0) {
				const names = strayCreateFields.map(field => `\`${field}\``).join(", ");
				return fail(
					`\`op: "cancel"\` takes only \`id\`, but got ${names}. Nothing was cancelled or scheduled — cancel first, then schedule in a separate call.`,
					op,
					existing,
					nowMs,
				);
			}
			return this.#cancel(params.id?.trim(), existing, nowMs);
		}

		if (params.id !== undefined) {
			return fail(
				'`id` only applies to `op: "cancel"`; a new wake is assigned its own id. Drop `id` to schedule, or pass `op: "cancel"` to retire that one.',
				op,
				existing,
				nowMs,
			);
		}
		return this.#create(params, existing, nowMs);
	}

	#create(params: WakeParams, existing: WakeSchedule[], nowMs: number): AgentToolResult<WakeToolDetails> {
		const built = buildWakeSchedule(
			{
				message: params.message ?? "",
				at: params.at,
				every: params.every,
				until: params.until,
				limit: params.limit,
			},
			existing,
			nowMs,
		);
		if ("error" in built) return fail(built.error, "create", existing, nowMs);

		const schedule = built.schedule;
		const schedules = [...existing, schedule];
		this.session.setWakeSchedules?.(schedules);

		const lines = [
			`Wake ${schedule.id} scheduled — ${describeWakeSchedule(schedule, nowMs)}`,
			`Cancel with \`wake({op:"cancel",id:"${schedule.id}"})\` as soon as its goal is met.`,
		];
		if (schedules.length > 1) {
			lines.push(`${wakeCount(schedules.length)} now armed; \`wake({op:"list"})\` shows all.`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "create", schedules, targetId: schedule.id, nowMs },
		};
	}

	#list(existing: WakeSchedule[], nowMs: number): AgentToolResult<WakeToolDetails> {
		const rows = existing.map(
			schedule => `${schedule.id} — ${describeWakeSchedule(schedule, nowMs)} — ${previewMessage(schedule.message)}`,
		);
		const text =
			rows.length === 0 ? "No wakes scheduled." : [`${wakeCount(rows.length)} scheduled:`, ...rows].join("\n");
		return { content: [{ type: "text", text }], details: { op: "list", schedules: existing, nowMs } };
	}

	#cancel(id: string | undefined, existing: WakeSchedule[], nowMs: number): AgentToolResult<WakeToolDetails> {
		if (!id) {
			return fail(
				'`op: "cancel"` needs `id` — the handle the wake was created with, e.g. `w1`. Call `wake({op:"list"})` to see live ids.',
				"cancel",
				existing,
				nowMs,
			);
		}
		const target = existing.find(schedule => schedule.id === id);
		if (!target) {
			const known =
				existing.length === 0
					? "No wakes are scheduled."
					: `Live ids: ${existing.map(schedule => schedule.id).join(", ")}.`;
			return fail(`No wake with id "${id}". ${known}`, "cancel", existing, nowMs, id);
		}

		const schedules = existing.filter(schedule => schedule.id !== id);
		this.session.setWakeSchedules?.(schedules);
		const remaining = schedules.length === 0 ? "No wakes remain." : `${wakeCount(schedules.length)} still scheduled.`;
		return {
			content: [
				{ type: "text", text: `Wake ${id} cancelled (was ${describeWakeSchedule(target, nowMs)}). ${remaining}` },
			],
			details: { op: "cancel", schedules, targetId: id, nowMs },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

/**
 * The full call shape, all `unknown`: a partially-parsed streaming call can put
 * any JSON value in any field, and the header must still render. Only `op`,
 * `message`, and `id` are read — the timing fields appear so a complete call
 * type-checks against this shape.
 */
interface WakeRenderArgs {
	op?: unknown;
	message?: unknown;
	at?: unknown;
	every?: unknown;
	until?: unknown;
	limit?: unknown;
	id?: unknown;
}

interface WakeRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: WakeToolDetails;
	isError?: boolean;
}

/** Non-empty string or nothing — partial streaming args carry half-typed values. */
function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Model-authored text reaches the terminal here, so strip escapes and tabs. */
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

export const wakeToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: WakeRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const op = readString(args?.op);
		const meta = op === "cancel" ? [`cancel ${readString(args?.id) ?? "…"}`] : op === "list" ? ["list"] : undefined;
		const message = readString(args?.message);
		const description = op === undefined && message ? forDisplay(previewMessage(message)) : undefined;
		return new Text(renderStatusLine({ icon: "pending", title: "Wake", description, meta }, theme), 0, 0);
	},
	renderResult(result: WakeRenderResult, options: RenderResultOptions, theme: Theme): Component {
		const text = (result.content?.find(part => part.type === "text")?.text ?? "").trim();
		if (result.isError) {
			return new Text(formatErrorMessage(text || "Wake failed", theme), 0, 0);
		}
		const details = result.details;
		// Details absent means a partial/streaming result: no state to draw yet.
		if (!details) return new Text(renderStatusLine({ icon: "running", title: "Wake" }, theme), 0, 0);

		const { op, schedules, targetId, nowMs } = details;
		const created = op === "create" ? schedules.find(schedule => schedule.id === targetId) : undefined;
		const rows = op === "list" ? schedules : created ? [created] : [];
		const label = targetId ?? "wake";
		const meta =
			op === "cancel"
				? [`${label} cancelled`, schedules.length === 0 ? "none left" : `${wakeCount(schedules.length)} left`]
				: op === "list"
					? [schedules.length === 0 ? "none scheduled" : `${wakeCount(schedules.length)} scheduled`]
					: [`${label} scheduled`];
		const header = renderStatusLine({ iconOverride: theme.fg("accent", WAKE_GLYPH), title: "Wake", meta }, theme);
		if (rows.length === 0) return new Text(header, 0, 0);

		// `nowMs` from the result keeps relative times stable across repaints.
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const lines = [header];
				for (const schedule of rows) {
					const id = theme.fg("toolOutput", forDisplay(schedule.id));
					const detail = theme.fg("muted", describeWakeSchedule(schedule, nowMs));
					lines.push(`  ${theme.fg("accent", WAKE_GLYPH)} ${id}${theme.fg("dim", theme.sep.dot)}${detail}`);
					if (expanded) {
						lines.push(`    ${theme.fg("dim", forDisplay(previewMessage(schedule.message)))}`);
					}
				}
				return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
			},
		);
	},
};
