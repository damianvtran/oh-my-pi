# Secret Obfuscation

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, configured secrets and built-in credential-shaped token patterns are replaced before provider-visible text leaves the process. Reversible placeholders are restored in model-authored tool arguments before execution and when local session context is rebuilt for display or resume.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
  enabled: true
```

## How it works

1. On session startup, secrets are collected from:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values at least 8 characters long
   - **`secrets.yml` files** (see below)
   - A built-in reversible regex for common GitHub-, GitLab-, and OpenAI-style credential tokens that appear only in session content or tool results

2. Provider-visible text has matching values replaced with deterministic placeholders such as `$$3P8W5JH1TK2Q$$`, `$$3P8W5JH1TK2Q:L$$`, or `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`.

3. Live model-authored tool arguments are deep-walked and placeholders are restored before the tool executes. Session context restores placeholders for local display/resume and re-obfuscates it before provider replay. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                                                      | Reversible |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate` (default) | Replaced with a deterministic `$$HASH(:hint)$$` or `$$FRIENDLY_HASH(:hint)$$` placeholder     | Yes        |
| `replace`             | Replaced with the configured `replacement`, or a deterministic same-length value when omitted | No         |

Obfuscate-mode plain values and regex matches shorter than 8 characters are ignored to avoid redacting ordinary short words. Replace mode can handle short values; a replace-mode regex with no custom replacement is rejected only when every possible 1–2 character match would be impossible to redact to a distinct stable value.

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                       | Purpose                     |
| ------- | -------------------------- | --------------------------- |
| Global  | `~/.omp/agent/secrets.yml` | Secrets across all projects |
| Project | `<cwd>/.omp/secrets.yml`   | Project-specific secrets    |

Project entries override global entries with matching `content`.

### Schema

Each entry in the array has these fields:

| Field          | Type                         | Required | Description                                                   |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type`         | `"plain"` or `"regex"`       | Yes      | Match strategy                                                |
| `content`      | string                       | Yes      | The secret value (plain) or regex pattern (regex)             |
| `mode`         | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                                        |
| `replacement`  | string                       | No       | Custom replacement (replace mode only)                        |
| `flags`        | string                       | No       | Regex flags (regex type only)                                 |
| `friendlyName` | string                       | No       | Sanitized model-visible label for obfuscate-mode placeholders |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### Friendly names

`friendlyName` adds semantic context to reversible obfuscation placeholders without exposing the secret value:

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

This produces placeholders shaped like `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`. The friendly name is sanitized to uppercase letters and digits, capped at 32 characters, and omitted if it sanitizes to an empty value. Invalid optional `friendlyName` metadata does not disable the secret entry; the secret still obfuscates with an unlabeled placeholder. A label is also dropped for a particular placeholder if it would expose a configured literal secret or match a configured secret regex.

The 12-character hash base is an HMAC of the exact secret under a private per-install key (stored at `~/.omp/agent/secret-placeholder.key`, or `$XDG_STATE_HOME/omp/secret-placeholder.key` on XDG-enabled installs, never sent to a model). This prevents a transcript reader from dictionary-hashing a placeholder back to its secret. Secrets that differ only by case receive independent bases, so seeing one placeholder does not let a provider synthesize another by changing the case hint. If the key cannot be persisted on the lazy built-in-token path, the session warns and uses a process-ephemeral key; obfuscation remains reversible within that process but placeholders are not stable across restarts. A case-hint suffix labels the casing of the redacted value:

| Hint | Meaning                                        |
| ---- | ---------------------------------------------- |
| `:U` | all cased ASCII letters are uppercase          |
| `:L` | all cased ASCII letters are lowercase          |
| `:C` | first cased ASCII letter uppercase, rest lower |
| `:M` | mixed ASCII casing                             |

`friendlyName` on regex entries labels the configured regex entry, not the matched value. Keep regex labels broad enough to be true for every match.

#### Regex secrets

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Invalid entries and files

- A missing `secrets.yml` is treated as no entries.
- A parse failure or non-array document is ignored with a warning.
- Invalid entries are skipped individually with a warning. `type` must be `plain` or `regex`; `content` must be a non-empty string; `mode`, `replacement`, `flags`, and regex syntax are validated as shown above.
- Invalid optional `friendlyName` metadata is dropped without dropping an otherwise valid entry.

## Interaction with automatic detection

Environment variables are collected first, file-defined entries follow, and the built-in credential regex runs last so configured entries see matching content before the generic detector. Duplicate environment values are collapsed within the environment scan. Environment and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Session credentials (`/credential`)

`secrets.yml` covers values you already have on disk. A **session credential**
covers the other case: a secret only you can produce right now — a short-lived
token, a one-off deploy key, a password for a system the agent has no standing
access to — that you want the agent to *use* without ever *reading*.

```
/credential GITHUB_TOKEN     # prompts for the value with masked input, then stores it
/credential                  # list what is stored, with each placeholder
/credential --forget GITHUB_TOKEN
/credential --forget-all
```

The prompt replaces the composer, renders every character as a bullet, and
returns the value straight to the vault, so the secret never enters the editor
buffer, its history, or a transcript entry. Keys are normalized to env-var
shape, so `github token`, `github-token`, and `GITHUB_TOKEN` all name the same
credential.

This is **not a separate mechanism**. The value is registered with the session's
`SecretObfuscator` exactly like a `secrets.yml` plain entry, so it inherits the
whole round trip described in [How it works](#how-it-works): the model sees only
a keyed `$$KEY_<hash>:<case>$$` placeholder, and `deobfuscateToolArguments`
substitutes the real bytes into a tool call's arguments immediately before the
tool runs. Two consequences worth stating plainly:

- It works with `secrets.enabled` off. That setting governs *automatic*
  redaction of configured and credential-shaped values; a credential you hand
  over explicitly is always redacted.
- Storing the first credential activates obfuscation for the session, so the
  `$$…$$` placeholder format is also explained to the model from that point on.

### Using one

The system prompt gains a `<session-credentials>` block listing each key and its
placeholder — and nothing else; sessions that never use the feature pay zero
tokens for it. The model passes the placeholder where the secret belongs,
usually a `bash` env value:

```json
{ "command": "gh api /user", "env": { "GITHUB_TOKEN": "$$GITHUBTOKEN_9SIWMKA7ATG3:M$$" } }
```

`env` is preferred over inlining into the command string so the value never
reaches a shell history or a rendered command line.

### Asking for one

The `ask` tool can request a credential itself: a question with `secret: true`
(and `options: []`) shows the same masked prompt instead of an option list,
stores the answer under the question's `id`, and returns the placeholder as the
answer. The tool result and its `details` — both persisted verbatim to the
session JSONL — carry only the placeholder. A declined or unstorable answer
comes back as `<not provided>` with a reason, rather than aborting the turn.

### Limits worth knowing

- **Minimum length 8** (`MIN_OBFUSCATE_SECRET_LEN`). Below that, substitution
  would collide with ordinary prose. Shorter values are refused outright rather
  than stored unredacted.
- **Memory only.** Nothing is written to disk and nothing survives the session.
  For anything longer-lived, have the agent put it in a real secrets manager or
  vault — which it can do *using* the placeholder.
- **`--forget` revokes the reference, not the redaction.** The obfuscator keeps
  hiding those bytes for the rest of the session; un-hiding a value the operator
  marked secret would be a downgrade, not a cleanup.
- **Do not pass a placeholder to a subagent.** A `task` subagent builds its own
  obfuscator and cannot resolve the handle, and because tool arguments are
  deobfuscated before the tool runs, the raw value would be copied into that
  subagent's context and transcript. The prompt block tells the model this; it is
  guidance, not an enforced boundary.
## Subprocess argv in error rendering

Obfuscation only helps for values the harness has been told about. A credential
a cell reads from the environment, a file, or an API response is unknown to the
`SecretObfuscator` -- and so is a registered credential once
`deobfuscateToolArguments` has substituted the real bytes into a tool call. When
such a value is passed to a subprocess in argv, every runtime we host echoes it
back on failure:

| Runtime | Rendering that embeds argv |
| --- | --- |
| JS (Node) | `Command failed: <joined argv>` in `Error.message` for `exec` / `execFile` / `execFileSync`, on timeout as well as non-zero exit |
| Python | `subprocess.TimeoutExpired.__str__` and `CalledProcessError.__str__` interpolate `self.cmd` (and the same argv sits in `args`, so `repr(exc)` leaks too) |
| Julia | `showerror` prints the whole `Cmd` for `ProcessFailedException`, and interpolates it into the `IOError` message for a failed spawn |
| Ruby | None -- its stdlib never embeds argv in these messages, so the Ruby runner needs no guard |

That exception escapes to the tool result, which puts the credential in the
transcript and in the session file even though the agent asked for none of it. A
timing-out child is the worst case: there is no output, so the argv is the entire
content of the error.

The guard is **prior-disclosure gating**, not secret detection. At each error
serialization boundary an argument is rendered only when its exact bytes already
appear in code the agent itself wrote in that kernel -- those bytes are already
in the transcript, so re-rendering them discloses nothing new. Anything else is
replaced by its length alone: `<redacted:71c>`. Consequences worth knowing:

- **argv[0] is always rendered.** An executable path is the most useful part of
  a spawn failure, is not a credential, and is resolved by the runtime (`"sh"` ->
  `/bin/sh`) so it often fails a literal disclosure check.
- **Nothing else about the failure changes** -- exception type, exit code,
  signal, timeout and captured stdout/stderr are untouched. Program output is
  what the agent asked for; only the invocation is filtered.
- **An all-disclosed command line comes back byte-identical**, so the guard is
  invisible for ordinary failures like `['git', 'status']`.
- **A value assembled at runtime reads as undisclosed** even when its literal
  halves are in the source, because the assembled bytes are not. This
  over-redacts a computed date or a joined path; that is the safe direction.
- **Deliberate disclosure still works.** A cell that catches the error and
  prints `err.cmd` (or `e.cmd`) is making an explicit choice and still sees the
  real argv. Only the *uncaught* rendering is filtered. The live exception object
  is never mutated.

One limitation is deliberate. The disclosure ledger records cell source **as
executed**, which is one step past what the transcript holds: a registered
secret the agent referenced as `$$KEY_<hmac>$$` inside cell code has already been
substituted by `deobfuscateToolArguments` by the time the kernel sees it, so it
counts as disclosed and a failing subprocess can echo it. That is the
pre-existing behaviour that tool results echo deobfuscated arguments at all --
`bash` does the same, rendering its `command` verbatim -- and the obfuscator
still re-masks those values at the provider boundary, so the model never reads
them; the exposure is to the on-disk session. Values the harness was never told
about, which is the case this guard exists for, are fully covered.

The policy lives in `packages/coding-agent/src/utils/argv-disclosure.ts`, which
is normative; the Python and Julia runners run out of process and reimplement it
in their own languages, so the `<redacted:<N>c>` rendering must stay in sync
across all three.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/session-credentials.ts` -- `SessionCredentials` vault behind `/credential` and `ask`'s secret mode
- `packages/coding-agent/src/slash-commands/helpers/credential.ts` -- `/credential` argument parsing and operator-facing copy
- `packages/coding-agent/src/prompts/system/session-credentials.md` -- the `<session-credentials>` prompt block
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` setting definition
- `packages/coding-agent/src/utils/argv-disclosure.ts` -- prior-disclosure gating for subprocess argv in error rendering (mirrored by `src/eval/py/runner.py` and `src/eval/jl/runner.jl`)

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
