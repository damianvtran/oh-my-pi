# OMP Julia runner — subprocess wrapper used by the coding-agent host.
# Persistent Julia process that speaks NDJSON over stdout and a custom TSV protocol on stdin.

using Base64

# Force GR (the default Plots.jl backend) into a headless workstation so a plot
# never pops up a native gksqt GUI window — the harness renders the inline PNG
# from `show(io, MIME"image/png", plt)` itself. `get!` keeps an explicit
# user-provided value, mirroring the Python runner's MPLBACKEND=Agg default.
get!(ENV, "GKSwstype", "100")

const ORIGINAL_STDOUT = stdout
const ORIGINAL_STDERR = stderr
const ORIGINAL_STDIN = stdin

# Redirect stdin/stdout/stderr to prevent cell prints from corrupting NDJSON
out_rd, out_wr = redirect_stdout()
err_rd, err_wr = redirect_stderr()
redirect_stdin(devnull)

global current_rid = nothing
const write_lock = ReentrantLock()
const drain_state_lock = ReentrantLock()

mutable struct DrainBarrier
    marker::Vector{UInt8}
    remaining::Int
    done::Channel{Nothing}
end

const active_drain_barrier = Ref{Union{Nothing, DrainBarrier}}(nothing)
const drain_marker_counter = Ref{UInt}(0)

function json_parse(s::String)
    chars = collect(s)
    pos = 1
    len = length(chars)
    
    function skip_whitespace()
        while pos <= len && isspace(chars[pos])
            pos += 1
        end
    end
    
    function parse_value()
        skip_whitespace()
        if pos > len
            error("Unexpected EOF")
        end
        c = chars[pos]
        if c == '"'
            return parse_string()
        elseif c == '{'
            return parse_object()
        elseif c == '['
            return parse_array()
        elseif (c == 't' || c == 'f')
            return parse_boolean()
        elseif c == 'n'
            return parse_null()
        elseif c == '-' || isdigit(c)
            return parse_number()
        else
            error("Unexpected character at $pos: $c")
        end
    end
    
    function parse_string()
        pos += 1 # skip '"'
        res = IOBuffer()
        while pos <= len
            c = chars[pos]
            if c == '"'
                pos += 1 # skip '"'
                return String(take!(res))
            elseif c == '\\'
                pos += 1
                if pos > len; error("Unexpected EOF in string escape"); end
                esc = chars[pos]
                if esc == '"'
                    write(res, '"')
                elseif esc == '\\'
                    write(res, '\\')
                elseif esc == '/'
                    write(res, '/')
                elseif esc == 'b'
                    write(res, '\b')
                elseif esc == 'f'
                    write(res, '\f')
                elseif esc == 'n'
                    write(res, '\n')
                elseif esc == 'r'
                    write(res, '\r')
                elseif esc == 't'
                    write(res, '\t')
                elseif esc == 'u'
                    # parse 4 hex digits
                    hex = ""
                    for i in 1:4
                        pos += 1
                        hex *= chars[pos]
                    end
                    write(res, Char(parse(Int, hex, base=16)))
                else
                    write(res, esc)
                end
            else
                write(res, c)
            end
            pos += 1
        end
        error("Unterminated string")
    end
    
    function parse_object()
        pos += 1 # skip '{'
        obj = Dict{String, Any}()
        skip_whitespace()
        if pos <= len && chars[pos] == '}'
            pos += 1
            return obj
        end
        while true
            skip_whitespace()
            if pos > len || chars[pos] != '"'
                error("Expected string key in object at $pos")
            end
            key = parse_string()
            skip_whitespace()
            if pos > len || chars[pos] != ':'
                error("Expected ':' at $pos")
            end
            pos += 1 # skip ':'
            val = parse_value()
            obj[key] = val
            skip_whitespace()
            if pos > len
                error("Expected ',' or '}' in object at $pos")
            end
            c = chars[pos]
            if c == '}'
                pos += 1
                return obj
            elseif c == ','
                pos += 1
            else
                error("Expected ',' or '}' in object at $pos, got '$c'")
            end
        end
    end
    
    function parse_array()
        pos += 1 # skip '['
        arr = Any[]
        skip_whitespace()
        if pos <= len && chars[pos] == ']'
            pos += 1
            return arr
        end
        while true
            push!(arr, parse_value())
            skip_whitespace()
            if pos > len
                error("Expected ',' or ']' in array")
            end
            c = chars[pos]
            if c == ']'
                pos += 1
                return arr
            elseif c == ','
                pos += 1
            else
                error("Expected ',' or ']' in array at $pos, got '$c'")
            end
        end
    end
    
    function parse_boolean()
        s_slice = String(chars[pos:min(len, pos+4)])
        if startswith(s_slice, "true")
            pos += 4
            return true
        elseif startswith(s_slice, "false")
            pos += 5
            return false
        else
            error("Expected boolean at $pos")
        end
    end
    
    function parse_null()
        s_slice = String(chars[pos:min(len, pos+3)])
        if startswith(s_slice, "null")
            pos += 4
            return nothing
        else
            error("Expected null at $pos")
        end
    end
    
    function parse_number()
        start_pos = pos
        while pos <= len
            c = chars[pos]
            if isdigit(c) || c in ['.', '-', '+', 'e', 'E']
                pos += 1
            else
                break
            end
        end
        num_str = String(chars[start_pos:pos-1])
        val = tryparse(Int, num_str)
        if val !== nothing
            return val
        end
        val_f = tryparse(Float64, num_str)
        if val_f !== nothing
            return val_f
        end
        error("Invalid number format: $num_str")
    end
    
    val = parse_value()
    skip_whitespace()
    if pos <= len
        error("Extra data after JSON value at $pos")
    end
    return val
end

function json_serialize_string(s::AbstractString)
    res = IOBuffer()
    write(res, '"')
    for c in s
        if c == '"'
            write(res, "\\\"")
        elseif c == '\\'
            write(res, "\\\\")
        elseif c == '\n'
            write(res, "\\n")
        elseif c == '\r'
            write(res, "\\r")
        elseif c == '\t'
            write(res, "\\t")
        elseif c == '\f'
            write(res, "\\f")
        elseif c == '\b'
            write(res, "\\b")
        elseif UInt32(c) < 32
            d1 = div(UInt32(c), 16)
            d2 = rem(UInt32(c), 16)
            hex_chars = "0123456789abcdef"
            write(res, "\\u00" * hex_chars[d1 + 1] * hex_chars[d2 + 1])
        else
            write(res, c)
        end
    end
    write(res, '"')
    return String(take!(res))
end

function json_serialize(v)
    if v === nothing
        return "null"
    elseif v isa Bool
        return v ? "true" : "false"
    elseif v isa Number
        return string(v)
    elseif v isa AbstractString
        return json_serialize_string(v)
    elseif v isa Symbol
        return json_serialize_string(string(v))
    elseif v isa AbstractVector
        return "[" * join([json_serialize(x) for x in v], ",") * "]"
    elseif v isa AbstractDict
        parts = String[]
        for (k, val) in v
            push!(parts, json_serialize_string(string(k)) * ":" * json_serialize(val))
        end
        return "{" * join(parts, ",") * "}"
    else
        return json_serialize_string(repr(v))
    end
end

function emit_frame(frame)
    lock(write_lock) do
        println(ORIGINAL_STDOUT, json_serialize(frame))
        flush(ORIGINAL_STDOUT)
    end
end

function find_subsequence(haystack::Vector{UInt8}, needle::Vector{UInt8})
    needle_len = length(needle)
    if needle_len == 0 || length(haystack) < needle_len
        return nothing
    end
    last_start = length(haystack) - needle_len + 1
    for start in 1:last_start
        matched = true
        @inbounds for offset in 1:needle_len
            if haystack[start + offset - 1] != needle[offset]
                matched = false
                break
            end
        end
        if matched
            return start
        end
    end
    return nothing
end

function marker_overlap(haystack::Vector{UInt8}, needle::Vector{UInt8})
    max_overlap = min(length(haystack), length(needle) - 1)
    for overlap in max_overlap:-1:1
        matched = true
        @inbounds for offset in 1:overlap
            if haystack[length(haystack) - overlap + offset] != needle[offset]
                matched = false
                break
            end
        end
        if matched
            return overlap
        end
    end
    return 0
end

function emit_stream_bytes(kind, bytes::Vector{UInt8})
    rid = current_rid
    if rid === nothing || isempty(bytes)
        return
    end
    emit_frame(Dict("type" => kind, "id" => rid, "data" => String(copy(bytes))))
end

function signal_drain_barrier!(marker::Vector{UInt8})
    done_channel = lock(drain_state_lock) do
        barrier = active_drain_barrier[]
        if barrier === nothing || barrier.marker != marker
            return nothing
        end
        barrier.remaining -= 1
        if barrier.remaining == 0
            active_drain_barrier[] = nothing
            return barrier.done
        end
        return nothing
    end
    if done_channel !== nothing
        put!(done_channel, nothing)
    end
    return nothing
end

function process_stream_buffer!(buffer::Vector{UInt8}, kind; flush_all::Bool=false)
    while true
        barrier = lock(drain_state_lock) do
            active_drain_barrier[]
        end
        marker = barrier === nothing ? nothing : barrier.marker
        if marker === nothing
            if !isempty(buffer)
                emit_stream_bytes(kind, buffer)
                empty!(buffer)
            end
            return
        end

        marker_index = find_subsequence(buffer, marker)
        if marker_index !== nothing
            emit_len = marker_index - 1
            if emit_len > 0
                emit_stream_bytes(kind, buffer[1:emit_len])
            end
            deleteat!(buffer, 1:(marker_index + length(marker) - 1))
            signal_drain_barrier!(marker)
            continue
        end

        keep_len = flush_all ? 0 : marker_overlap(buffer, marker)
        emit_len = length(buffer) - keep_len
        if emit_len > 0
            emit_stream_bytes(kind, buffer[1:emit_len])
            deleteat!(buffer, 1:emit_len)
        end
        return
    end
end

function next_drain_marker()
    drain_marker_counter[] += UInt(1)
    return Vector{UInt8}(codeunits("\0__OMP_DRAIN__:" * string(drain_marker_counter[]) * ":" * string(time_ns()) * "\0"))
end

function await_stream_drains()
    flush(stdout)
    flush(stderr)
    barrier = DrainBarrier(next_drain_marker(), 2, Channel{Nothing}(1))
    lock(drain_state_lock) do
        if active_drain_barrier[] !== nothing
            error("Drain barrier already active")
        end
        active_drain_barrier[] = barrier
    end
    try
        Base.write(out_wr, barrier.marker)
        flush(out_wr)
        Base.write(err_wr, barrier.marker)
        flush(err_wr)
        take!(barrier.done)
    finally
        lock(drain_state_lock) do
            if active_drain_barrier[] === barrier
                active_drain_barrier[] = nothing
            end
        end
    end
    return nothing
end

function drain_stream(rd, kind)
    buffer = UInt8[]
    try
        while true
            data = readavailable(rd)
            if !isempty(data)
                append!(buffer, data)
                process_stream_buffer!(buffer, kind)
            elseif eof(rd)
                break
            else
                sleep(0.001)
            end
        end
    catch
        # ignore
    finally
        process_stream_buffer!(buffer, kind, flush_all=true)
    end
end

@async drain_stream(out_rd, "stdout")
@async drain_stream(err_rd, "stderr")

function build_mime_bundle(value)
    bundle = Dict{String, Any}()

    # text/plain — every mime probe below uses `Base.invokelatest` because this
    # function runs from the frozen-world `main()` loop: `show`/`showable`
    # methods that a package adds when it is `using`-ed *inside* a cell (e.g.
    # Plots/Makie/GraphRecipes registering rich `show` for their plot types) are
    # invisible to direct dispatch here and fall back to the default struct show,
    # which can itself throw. Guard text/plain too so a failing repr never aborts
    # the whole bundle before the image mime is reached.
    try
        io_plain = IOBuffer()
        Base.invokelatest(show, io_plain, MIME"text/plain"(), value)
        bundle["text/plain"] = String(take!(io_plain))
    catch
        bundle["text/plain"] = try
            summary(value)
        catch
            string(typeof(value))
        end
    end

    # rich mime types
    for mime_str in ["text/html", "text/markdown", "image/png", "image/jpeg"]
        m = MIME(Symbol(mime_str))
        if Base.invokelatest(showable, m, value)
            try
                io = IOBuffer()
                if mime_str in ["image/png", "image/jpeg"]
                    b64_io = Base64EncodePipe(io)
                    Base.invokelatest(show, b64_io, m, value)
                    close(b64_io)
                else
                    Base.invokelatest(show, io, m, value)
                end
                bundle[mime_str] = String(take!(io))
            catch
                # ignore
            end
        end
    end

    if value isa AbstractDict || value isa AbstractVector
        try
            bundle["application/json"] = value
        catch
            # ignore
        end
    end

    return bundle
end

struct OmpDisplay <: AbstractDisplay end

function Base.display(d::OmpDisplay, value)
    rid = current_rid
    if rid !== nothing
        bundle = build_mime_bundle(value)
        emit_frame(Dict("type" => "display", "id" => rid, "bundle" => bundle))
    end
    return nothing
end

pushdisplay(OmpDisplay())

# ---------------------------------------------------------------------------
# Argv disclosure gating for process-invocation errors
# ---------------------------------------------------------------------------
#
# A cell that spawns a subprocess routinely puts a credential in argv
# (`run(`psql $dsn`)`), and Julia re-renders the whole `Cmd` when that spawn
# fails: `showerror(::ProcessFailedException)` prints the `Process`, and a
# failed spawn raises an `IOError` whose `msg` already has the backtick-rendered
# `Cmd` interpolated into it. The exception escapes to the tool result, so the
# credential lands in the agent transcript and in the session file on disk even
# though the agent asked to see none of it.
#
# The rule, shared verbatim with `src/utils/argv-disclosure.ts` (the normative
# statement), the JS eval worker and `../py/runner.py`: gate on *prior
# disclosure*, never on secret detection. An argument is rendered only when its
# exact characters already appear in code the agent itself wrote in this kernel
# — those characters are already in the transcript, so re-rendering them
# discloses nothing new. Everything else (a value read from ENV, a file, an API
# response, or a session credential the host substituted into the cell) is
# replaced by its length alone. Guessing which arguments "look like" secrets
# fails in both directions; this needs no detector to be correct, and it keeps
# the diagnostics that matter — program, argument count, exit code, signal,
# captured output, backtrace.
#
# argv[0] is the one deliberate exception and is always rendered: an executable
# path is the single most useful part of a spawn failure, it is not a
# credential, and Julia resolves it (`sh` -> `/bin/sh`) so it often fails a
# literal disclosure check the agent's own source should pass.
#
# The Ruby runner needs no equivalent: its stdlib never embeds argv in these
# messages (`Errno::ENOENT: No such file or directory - prog`,
# `#<Process::Status: pid N exit M>`), so there is nothing there to filter.
#
# Keep the `<redacted:<N>c>` rendering identical across all four runtimes.

const DISCLOSURE_MAX_ENTRIES = 64
const DISCLOSURE_MAX_CHARS = 256 * 1024
const disclosure_entries = String[]
const disclosure_chars = Ref(0)

# Record cell source as disclosed to the transcript.
#
# A persistent kernel keeps state across cells, so a literal written in cell 1
# can reach argv in cell 5; checking only the failing cell would redact values
# that are plainly visible in the transcript. Retention is bounded because a
# long session's cell history is not, and evicting an entry only costs fidelity
# (over-redaction), never safety.
function record_disclosure!(source::AbstractString)
    isempty(source) && return nothing
    text = String(source)
    push!(disclosure_entries, text)
    disclosure_chars[] += length(text)
    while length(disclosure_entries) > DISCLOSURE_MAX_ENTRIES ||
          (disclosure_chars[] > DISCLOSURE_MAX_CHARS && length(disclosure_entries) > 1)
        disclosure_chars[] -= length(popfirst!(disclosure_entries))
    end
    return nothing
end

# True when `text`'s exact characters already appear in recorded cell source.
# Substring containment is the right test and not a weakening: a match means
# those characters are literally present in code the agent wrote.
function is_disclosed(text::AbstractString)
    isempty(text) && return true
    for entry in disclosure_entries
        occursin(text, entry) && return true
    end
    return false
end

# Length-only rendering of an argument that was never disclosed. Space-free so
# it reads as one token inside a rendered command line, and length-only so it
# carries no characters of the value — not even a digest, which would be a
# (small) partial oracle on a secret.
redacted_arg(text::AbstractString) = string("<redacted:", length(text), "c>")

# Redacted argv, or `nothing` when every element may be rendered as-is (which
# keeps Julia's own formatting byte for byte in the all-literal case).
function redact_exec(exec::Vector{String})
    out = copy(exec)
    changed = false
    for i in 2:length(out)  # argv[0] is always rendered; see the header above.
        is_disclosed(out[i]) && continue
        out[i] = redacted_arg(out[i])
        changed = true
    end
    return changed ? out : nothing
end

# `setenv(cmd, ...)` entries render inside the very same `Cmd` that argv does,
# and a `PGPASSWORD=...` entry is the classic place to keep a credential *out*
# of argv. Same gate, same rendering.
function redact_cmd_env(env)
    env === nothing && return (nothing, false)
    out = String[]
    changed = false
    for entry in env
        text = String(entry)
        if is_disclosed(text)
            push!(out, text)
        else
            push!(out, redacted_arg(text))
            changed = true
        end
    end
    return (out, changed)
end

# A `Cmd` that renders like `cmd` with undisclosed argv/env replaced, or
# `nothing` when `cmd` already renders safely. Only `show(::Cmd)` output matters
# here — the replacement is never executed — so it carries exactly the fields
# `show` prints: exec, env, dir and cpu affinity.
function redact_cmd(cmd::Base.Cmd)
    exec = redact_exec(cmd.exec)
    env, env_changed = redact_cmd_env(cmd.env)
    (exec === nothing && !env_changed) && return nothing
    base = Base.Cmd(exec === nothing ? copy(cmd.exec) : exec)
    try
        return Base.Cmd(base; env=env, dir=cmd.dir, cpus=cmd.cpus)
    catch
        # Julia versions without cpu affinity on `Cmd`; affinity is cosmetic in
        # a rendering, env and dir are not.
        try
            return Base.Cmd(base; env=env, dir=cmd.dir)
        catch
            return base
        end
    end
end

# Prefix `Base._spawn` builds for every failed spawn:
# `throw(_UVError("could not spawn " * repr(cmd), err))`. Gating on Julia's own
# marker — rather than on anything about argument content — is what keeps
# ordinary `IOError`s (sockets, closed streams, libuv reads) untouched.
const SPAWN_FAILURE_PREFIX = "could not spawn "

# Index of the backtick closing the command opened at `open_idx`. `show(::Cmd)`
# escapes a backtick inside an argument as `\``, so the first backtick that is
# not preceded by a backslash closes the command.
function find_command_close(chars::Vector{Char}, open_idx::Int)
    i = open_idx + 1
    while i <= length(chars)
        chars[i] == '`' && chars[i - 1] != '\\' && return i
        i += 1
    end
    return nothing
end

# Redact every argument of a rendered command line whose characters the ledger
# has not seen. argv[0] is preserved verbatim, and so are the spacing and
# quoting of every preserved argument, so an all-disclosed command line comes
# back unchanged.
#
# Quote awareness is fidelity, not safety: without it `sh -c 'exit 3'` splits
# into `'exit` and `3'`, neither of which matches the agent's `"exit 3"`
# literal, and a perfectly innocent command line comes back half-redacted. An
# unbalanced quote simply runs to end of input — worst case one large piece,
# which fails the disclosure check and over-redacts.
function redact_command_line(line::AbstractString)
    chars = collect(line)
    n = length(chars)
    out = IOBuffer()
    seen_arg = false
    i = 1
    while i <= n
        gap_start = i
        while i <= n && isspace(chars[i])
            i += 1
        end
        i > gap_start && print(out, join(chars[gap_start:i - 1]))
        i > n && break
        raw_start = i
        value = IOBuffer()
        while i <= n && !isspace(chars[i])
            c = chars[i]
            if c == '\'' || c == '"'
                closing = findnext(isequal(c), chars, i + 1)
                stop = closing === nothing ? n : closing - 1
                i + 1 <= stop && print(value, join(chars[i + 1:stop]))
                i = closing === nothing ? n + 1 : closing + 1
                continue
            end
            print(value, c)
            i += 1
        end
        raw = join(chars[raw_start:i - 1])
        text = String(take!(value))
        if !seen_arg
            seen_arg = true  # argv[0]
            print(out, raw)
        else
            print(out, is_disclosed(text) ? raw : redacted_arg(text))
        end
    end
    return String(take!(out))
end

# `show(::Cmd)` wraps a command carrying env or dir in `setenv(`cmd`,[...]; dir=...)`.
# The env block is a Julia vector literal, so gate each string literal that sits
# inside brackets; `dir="..."` sits outside them and is kept, a working
# directory being a path rather than a credential.
function redact_bracketed_literals(text::AbstractString)
    chars = collect(text)
    n = length(chars)
    out = IOBuffer()
    depth = 0
    i = 1
    while i <= n
        c = chars[i]
        if c == '['
            depth += 1
            print(out, c)
            i += 1
        elseif c == ']'
            depth -= 1
            print(out, c)
            i += 1
        elseif c == '"'
            closing = i + 1
            while closing <= n && chars[closing] != '"'
                closing += chars[closing] == '\\' ? 2 : 1
            end
            closing = min(closing, n)
            literal = join(chars[i:closing])
            if depth > 0
                value = unescape_string(join(chars[i + 1:closing - 1]))
                print(out, is_disclosed(value) ? literal : string('"', redacted_arg(value), '"'))
            else
                print(out, literal)
            end
            i = closing + 1
        else
            print(out, c)
            i += 1
        end
    end
    return String(take!(out))
end

# Filter the `repr(cmd)` region of a spawn-failure message: the backtick command
# through `redact_command_line`, any `setenv` env block through the same gate.
function redact_cmd_repr(region::AbstractString)
    chars = collect(region)
    open_idx = findfirst(isequal('`'), chars)
    open_idx === nothing && return region
    close_idx = find_command_close(chars, open_idx)
    close_idx === nothing && return region
    return string(
        join(chars[1:open_idx]),                                  # `setenv(` and the opening backtick
        redact_command_line(join(chars[open_idx + 1:close_idx - 1])),
        redact_bracketed_literals(join(chars[close_idx:end])),    # closing backtick, env, dir
    )
end

# The spawn-failure message with its rendered invocation filtered, or the
# message unchanged when there was nothing to redact.
function redact_spawn_message(msg::AbstractString)
    startswith(msg, SPAWN_FAILURE_PREFIX) || return msg
    start = ncodeunits(SPAWN_FAILURE_PREFIX) + 1
    # `_UVError` appends `": " * strerror * " (NAME)"` after `repr(cmd)`, so the
    # last `": "` ends the invocation. Taking the *last* one errs safely: a
    # `": "` inside an env value only pushes the boundary later, which
    # over-redacts a few words of strerror rather than under-redacting argv.
    separator = findlast(": ", msg)
    stop = separator === nothing ? lastindex(msg) : prevind(msg, first(separator))
    stop < start && return msg
    region = msg[start:stop]
    redacted = redact_cmd_repr(region)
    redacted == region && return msg
    suffix = separator === nothing ? "" : msg[first(separator):end]
    return string(SPAWN_FAILURE_PREFIX, redacted, suffix)
end

function render_error_text(err)
    io = IOBuffer()
    # invokelatest + guard: custom error types from packages loaded inside the
    # cell define `showerror` methods invisible to this frozen-world function.
    try
        Base.invokelatest(showerror, io, err)
    catch
        print(io, string(err))
    end
    return String(take!(io))
end

# `showerror` text for `err` with any process invocation it embeds filtered
# through the disclosure ledger. Everything else about the failure survives
# untouched: exception type, exit code, signal, the captured stdout/stderr the
# agent actually asked for, and every backtrace frame.
function render_error_text_redacted(err)
    if err isa Base.ProcessFailedException
        # Structural fix: `Base.Process` is mutable and `showerror` renders
        # `proc.cmd`, so swapping in a redacted `Cmd` lets Julia do its own
        # formatting and leaves the exit code and signal — which it reads from
        # separate fields — exactly as they were.
        saved = Tuple{Base.Process, Base.Cmd}[]
        try
            for proc in err.procs
                replacement = redact_cmd(proc.cmd)
                replacement === nothing && continue
                push!(saved, (proc, proc.cmd))
                proc.cmd = replacement
            end
            return render_error_text(err)
        finally
            # Mandatory, not tidy: cell code in a `catch` block may still hold
            # this exception, and a cell that deliberately prints
            # `err.procs[1].cmd` is making an explicit disclosure that is none
            # of our business. Only the *uncaught* rendering is filtered.
            for (proc, original) in saved
                proc.cmd = original
            end
        end
    end
    text = render_error_text(err)
    if err isa Base.IOError
        # `IOError` is immutable and Julia interpolated the `Cmd` into `msg`
        # before constructing it, so this shape has to be filtered as text.
        redacted = redact_spawn_message(err.msg)
        redacted == err.msg || return replace(text, err.msg => redacted)
    end
    return text
end

function emit_error(rid, err, bt)
    err_str = try
        render_error_text_redacted(err)
    catch
        # A bug in the disclosure filter must never take the kernel down, and
        # must never fall through to the unfiltered rendering either.
        string("(unrenderable ", typeof(err), ")")
    end
    
    # Seed the traceback with the rendered exception text so the array is a
    # self-contained error display, matching the Python and Ruby runners. The
    # host shows `traceback` verbatim when present and only falls back to
    # `ename: evalue` when it is empty, so a frames-only traceback would hide
    # the real error. Julia's `showerror` output already embeds the exception
    # type for nearly every error and mirrors what the REPL prints after `ERROR: `.
    tb = isempty(err_str) ? String[] : String[err_str]
    for frame in stacktrace(bt)
        file = string(frame.file)
        line = frame.line
        func = string(frame.func)
        push!(tb, "  at $func ($file:$line)")
    end
    
    emit_frame(Dict(
        "type" => "error",
        "id" => rid,
        "ename" => string(typeof(err)),
        "evalue" => err_str,
        "traceback" => tb
    ))
end

function should_display_result(parsed_expr)
    if parsed_expr isa Expr && parsed_expr.head === :block
        args = parsed_expr.args
        if !isempty(args)
            last_arg = args[end]
            if last_arg isa Expr
                if last_arg.head in [Symbol("="), :function, :struct, :using, :import, :const, :global, :local, :macro]
                    return false
                end
            end
        end
    end
    return true
end

function apply_request_runtime(cwd, env_pairs)
    try
        if !isempty(cwd)
            cd(cwd)
        end
    catch
        # ignore
    end
    
    managed_env_keys = [
        "PI_SESSION_FILE",
        "PI_ARTIFACTS_DIR",
        "PI_TOOL_BRIDGE_URL",
        "PI_TOOL_BRIDGE_TOKEN",
        "PI_TOOL_BRIDGE_SESSION",
        "PI_EVAL_LOCAL_ROOTS"
    ]
    for k in managed_env_keys
        delete!(ENV, k)
    end
    
    if !isempty(env_pairs)
        for pair in split(env_pairs, ' ')
            if !isempty(pair)
                try
                    k_b64, v_b64 = split(pair, ':', limit=2)
                    k = String(base64decode(string(k_b64)))
                    v = String(base64decode(string(v_b64)))
                    ENV[k] = v
                catch
                    # ignore
                end
            end
        end
    end
end

# Main loop
function main()
    while !eof(ORIGINAL_STDIN)
        line = readline(ORIGINAL_STDIN)
        if isempty(line)
            continue
        end
        parts = split(line, '\t')
        cmd = string(parts[1])
        if cmd == "exit"
            break
        elseif cmd == "run"
            if length(parts) < 7
                continue
            end
            rid = string(parts[2])
            cwd = String(base64decode(string(parts[3])))
            silent = string(parts[4]) == "1"
            store_history = string(parts[5]) == "1"
            env_pairs = string(parts[6])
            code = String(base64decode(string(parts[7])))

            # Record before running: the agent wrote this source, so it is
            # already in the transcript and any literal in it may legally
            # reappear in a rendered process invocation. Doing it up front also
            # covers the cell that fails — its own literals must still count as
            # disclosed in its own error rendering.
            record_disclosure!(code)
            
            global current_rid = rid
            emit_frame(Dict("type" => "started", "id" => rid))
            
            apply_request_runtime(cwd, env_pairs)
            
            exec_status = "ok"
            try
                parsed = Meta.parse("begin\n" * code * "\nend")
                if parsed isa Expr && parsed.head === :error
                    # Syntax error from parser
                    exec_status = "error"
                    emit_frame(Dict(
                        "type" => "error",
                        "id" => rid,
                        "ename" => "ParseError",
                        "evalue" => string(parsed.args[1]),
                        "traceback" => String[]
                    ))
                else
                    ans = Core.eval(Main, parsed)
                    if ans !== nothing && !silent && should_display_result(parsed)
                        bundle = build_mime_bundle(ans)
                        emit_frame(Dict("type" => "result", "id" => rid, "bundle" => bundle))
                    end
                end
            catch err
                exec_status = "error"
                emit_error(rid, err, catch_backtrace())
            end
            
            await_stream_drains()
            
            emit_frame(Dict(
                "type" => "done",
                "id" => rid,
                "status" => exec_status,
                "executionCount" => 1,
                "cancelled" => false
            ))
            global current_rid = nothing
        end
    end
end

main()
