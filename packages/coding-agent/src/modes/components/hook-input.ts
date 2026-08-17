/**
 * Simple text input component for hooks.
 */
import { Container, Input, Markdown, matchesKey, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	/**
	 * Render typed/pasted characters as bullets while the real value is kept
	 * internally. Used for credential capture (`/credential`, `ask` secret
	 * questions) so a shoulder-surfer or a screen recording never sees the
	 * secret. The value still leaves via `onSubmit` unchanged.
	 */
	mask?: boolean;
}

export class HookInputComponent extends Container {
	#input: Input;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: HookInputOptions,
	) {
		super();

		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		this.addChild(this.#titleComponent);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`),
				() => {
					opts.onTimeout?.();
					this.#onCancelCallback();
				},
			);
		}

		this.#input = new Input();
		this.#input.mask = opts?.mask === true;
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		// Name the masking explicitly: a field that shows bullets (or nothing, for
		// an empty paste) otherwise reads as a broken input.
		const hint = this.#input.mask ? "enter submit  esc cancel  input hidden" : "enter submit  esc cancel";
		this.addChild(new Text(theme.fg("dim", hint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		// Reset countdown on any interaction
		this.#countdown?.reset();
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#onSubmitCallback(this.#input.getValue());
		} else if (matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
		} else {
			this.#input.handleInput(keyData);
		}
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner input, mirroring bracketed-paste semantics. Pasting counts as
	 *  interaction, so the timeout countdown resets like any keystroke. */
	pasteText(text: string): void {
		this.#countdown?.reset();
		this.#input.pasteText(text);
	}

	override dispose(): void {
		this.#countdown?.dispose();
	}
}
