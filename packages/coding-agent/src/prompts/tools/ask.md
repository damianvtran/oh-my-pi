Asks user when you need clarification or input during task execution.

<conditions>
- Multiple approaches exist with significantly different tradeoffs user should weigh
</conditions>

<instruction>
- Use `recommended: <index>` to mark default (0-indexed); " (Recommended)" added automatically
- Use `questions` for multiple related questions instead of asking one at a time
- Set `multi: true` on question to allow multiple selections
- Use short option labels; put explanatory tradeoffs in `description` instead of merging them into the label
- Need a credential (API key, token, password)? Set `secret: true` with `options: []`. The user pastes it masked; you get back a placeholder, never the value. Use `id` as the credential name (e.g. `GITHUB_TOKEN`).
</instruction>

<caution>
- Provide 2-5 concise, distinct options
</caution>

<critical>
- **Default to action.** Resolve ambiguity yourself using repo conventions, existing patterns, and reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Only ask when options have materially different tradeoffs the user must decide.
- **If multiple choices are acceptable**, pick the most conservative/standard option and proceed; state the choice.
- **Do NOT include "Other" option** — UI automatically adds "Other (type your own)" to every question.
</critical>
