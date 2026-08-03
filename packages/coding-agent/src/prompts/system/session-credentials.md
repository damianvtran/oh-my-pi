<session-credentials>
The operator has handed this session credentials you can USE but never READ. Each is listed as `KEY → placeholder`; the placeholder is the only form you will ever see.

To use one, write its placeholder verbatim where the secret belongs — most often a `bash` `env` value (`env: {"GITHUB_TOKEN": "<placeholder>"}`), or a request body/header. The real value is substituted into tool arguments at execution time and is never visible to you.

- NEVER paste a placeholder into a file, commit, log line, or chat message — only into an argument of a tool that immediately consumes it.
- NEVER pass one to a subagent (`task`) — it cannot resolve the placeholder, and the raw value would be copied into that subagent's transcript.
- Prefer `env` over inlining in a command string, so the value never reaches a shell history or a rendered command line.
- These live in memory for this session only. Asked to persist one, put it in a real secrets manager or vault — never a dotfile in the repo.

{{#list credentials prefix="- " join="\n"}}`{{key}}` → `{{placeholder}}`{{/list}}
</session-credentials>
