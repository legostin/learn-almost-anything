# Traces the target script under sys.settrace and prints ONE JSON document to
# the real stdout. User stdout/stderr are captured into buffers, so user code
# never pollutes the JSON channel. Usage: python3 laa_tracer.py main.py
import sys, json, io, types

MAX_STEPS, MAX_REPR, MAX_VARS = 300, 200, 30


class _TraceLimit(BaseException):
    """Raised inside the tracer to abort execution once MAX_STEPS is hit —
    merely disabling the trace would let an infinite loop run forever."""


def safe_repr(v):
    try:
        r = repr(v)
    except Exception:
        r = "<unrepresentable>"
    return r if len(r) <= MAX_REPR else r[:MAX_REPR] + "…"


def snapshot(frame):
    out, skipped = {}, 0
    for k, v in list(frame.f_locals.items()):
        if k.startswith("__"):
            continue
        if isinstance(
            v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)
        ):
            continue
        if len(out) >= MAX_VARS:
            skipped += 1
            continue
        out[k] = safe_repr(v)
    if skipped:
        out["…"] = "+%d more" % skipped
    return out


def main():
    target = sys.argv[1]
    with open(target, encoding="utf-8") as f:
        src = f.read()
    steps, truncated = [], [False]
    out_buf, err_buf = io.StringIO(), io.StringIO()
    real_stdout = sys.stdout
    error = None
    try:
        code = compile(src, target, "exec")
    except SyntaxError as e:
        json.dump(
            {"steps": [], "stdout": "", "stderr": "", "error": "SyntaxError: %s" % e, "truncated": False},
            real_stdout,
        )
        return

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != target:  # never descend into stdlib/imports
            return None
        if len(steps) >= MAX_STEPS:
            truncated[0] = True
            sys.settrace(None)
            raise _TraceLimit()
        if event in ("line", "call", "return", "exception"):
            steps.append(
                {
                    "line": frame.f_lineno,
                    "event": event,
                    "func": frame.f_code.co_name,
                    "locals": snapshot(frame),
                    "stdout_len": out_buf.tell(),
                }
            )
        return tracer

    g = {"__name__": "__main__", "__file__": target, "__builtins__": __builtins__}
    sys.stdout, sys.stderr = out_buf, err_buf
    sys.settrace(tracer)
    try:
        exec(code, g)
    except _TraceLimit:
        pass  # reported via "truncated", not as a user error
    except BaseException as e:
        error = "%s: %s" % (type(e).__name__, e)
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = real_stdout, sys.__stderr__
    json.dump(
        {
            "steps": steps,
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue(),
            "error": error,
            "truncated": truncated[0],
        },
        real_stdout,
    )


main()
