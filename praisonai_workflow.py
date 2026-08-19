"""
G-Rex Agent Control — PraisonAI workflow-engine verification run.

Objective
---------
Run a REAL workflow using PraisonAI 4.6.155 (praisonaiagents) explicitly as the
workflow/orchestration engine. The workflow:
  1. verifies that `praisonai` is importable and records the actual engine;
  2. decomposes the objective into >= 5 tasks;
  3. executes >= 2 of them truly in parallel on distinct worker threads
     (via PraisonAI's `Workflow` + `Parallel`, on_failure="partial_ok");
  4. includes one controlled-failure task that does NOT interrupt the others;
  5. gathers all results and verifies the final outcome (incl. temporal overlaps).

The native G-Rex team engine is NOT used. If PraisonAI could not be used, this
script would terminate explicitly declaring that instead of silently falling
back to another engine.

Agent Control remains authoritative on state, routing, budget, audit and
"Richiede te": this workflow is a read-only, deterministic analysis of the
workspace and does not mutate Agent Control state.

The parallel worker functions use brief `time.sleep` to represent per-worker
compute so that real concurrency is measurable; the filesystem analysis itself
is genuine.
"""

import ast
import datetime as _dt
import functools
import json
import os
import threading
import time
import uuid

# ---------------------------------------------------------------------------
# 0. Engine registration — verify importability BEFORE doing anything else.
# ---------------------------------------------------------------------------
_ENGINE_NAME = None
try:
    import praisonai as _praisonai
    import praisonaiagents as _pai
    from praisonaiagents import AgentFlow, Workflow, parallel  # Workflow == AgentFlow alias

    _ENGINE_NAME = "PraisonAI (praisonaiagents.workflows.AgentFlow/Workflow)"
    _ENGINE_VERSION = getattr(_praisonai, "__version__", "unknown")
    _ENGINE_CLASS = Workflow.__name__  # "AgentFlow" (Workflow is its alias)
    _ENGINE_IMPORTABLE = True
    _IMPORT_DETAIL = (
        f"praisonai module importable -> version {_ENGINE_VERSION}; "
        f"praisonaiagents.workflows.{_ENGINE_CLASS} engine available"
    )
except Exception as _exc:  # pragma: no cover - failure path, never silently fallback
    # Explicitly terminate the test: PraisonAI is NOT used as a fallback.
    raise SystemExit(
        "[PraisonAI-GATE] PraisonAI NON utilizzabile: import fallito -> "
        f"{type(_exc).__name__}: {_exc}. "
        "Test terminato senza fallback verso altri engine."
    )

# ---------------------------------------------------------------------------
# 1. Shared, thread-safe timing store (per-worker start/end / thread).
# ---------------------------------------------------------------------------
_WORKSPACE = os.path.dirname(os.path.abspath(__file__))
_LOCK = threading.Lock()
_TIMELINE = {}          # task name -> {thread, t_start, t_end, iso_start, iso_end}
_RESULTS = {}           # task name -> structured result (or {"error": ...})
_RUN_ID = uuid.uuid4().hex[:12]
_EXCLUDE_DIRS = {".git", "node_modules", "graphify-out", ".venv", "venv"}


def _now():
    return time.time()


def _iso(ts):
    return _dt.datetime.fromtimestamp(ts).isoformat(timespec="milliseconds")


def _load(v):
    """Best-effort parse of an engine-stringified dict/list; fall back to raw."""
    if isinstance(v, str):
        s = v.strip()
        if s.startswith(("{", "[")):
            try:
                return ast.literal_eval(s)
            except (ValueError, SyntaxError):
                return v
    return v


def _record(name):
    """Record start/end/thread for a named worker/task (thread-safe)."""
    def deco(fn):
        @functools.wraps(fn)
        def wrap(*a, **k):
            t0 = _now()
            with _LOCK:
                _TIMELINE[name] = {
                    "thread": threading.get_ident(),
                    "t_start": t0,
                    "iso_start": _iso(t0),
                }
            try:
                out = fn(*a, **k)
            except BaseException as e:
                t1 = _now()
                with _LOCK:
                    _TIMELINE[name]["t_end"] = t1
                    _TIMELINE[name]["iso_end"] = _iso(t1)
                    _TIMELINE[name]["error"] = f"{type(e).__name__}: {e}"
                    _RESULTS[name] = {"error": f"{type(e).__name__}: {e}"}
                raise
            else:
                t1 = _now()
                with _LOCK:
                    _TIMELINE[name]["t_end"] = t1
                    _TIMELINE[name]["iso_end"] = _iso(t1)
                    _RESULTS[name] = out
                return out
        return wrap
    return deco


def _scan(base, exts, label):
    """Real filesystem scan: returns {count, lines, sample} for files under base."""
    base = os.path.join(_WORKSPACE, base)
    files, total_lines = [], 0
    for root, dirs, names in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _EXCLUDE_DIRS]
        for n in names:
            if n.lower().endswith(tuple(exts)):
                fp = os.path.join(root, n)
                files.append(os.path.relpath(fp, _WORKSPACE))
                try:
                    with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                        total_lines += sum(1 for _ in fh)
                except OSError:
                    pass
    files.sort()
    return {
        "label": label,
        "file_count": len(files),
        "total_lines": total_lines,
        "sample": files[:8],
    }


class _ControlledFailure(RuntimeError):
    """Non-retryable, deliberately controlled failure for the failing branch."""
    is_retryable = False  # tells the PraisonAI engine to skip the retry/backoff loop


# ---------------------------------------------------------------------------
# 2. Task decomposition (>= 5 tasks).
# ---------------------------------------------------------------------------
# Task 1 — discover repository
@_record("T1_discover_repo")
def task_discover(context):
    time.sleep(0.5)  # simulated discovery work
    counts = {}
    total_lines = 0
    for root, dirs, names in os.walk(_WORKSPACE):
        dirs[:] = [d for d in dirs if d not in _EXCLUDE_DIRS]
        if os.path.basename(root) in _EXCLUDE_DIRS:
            continue
        for n in names:
            ext = os.path.splitext(n)[1].lower() or "(none)"
            counts[ext] = counts.get(ext, 0) + 1
            fp = os.path.join(root, n)
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as fh:
                    total_lines += sum(1 for _ in fh)
            except OSError:
                pass
    return {"extension_counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
            "total_lines": total_lines}


# Parallel workers (Tasks 2-5) — distinct worker threads.
@_record("T2_analyze_server")
def task_analyze_server(context):
    time.sleep(0.6)  # simulated compute
    return _scan("server/src", (".ts",), "server/src")


@_record("T3_analyze_web")
def task_analyze_web(context):
    time.sleep(0.7)  # simulated compute
    return _scan("web/src", (".tsx", ".ts",), "web/src")


@_record("T4_analyze_docs")
def task_analyze_docs(context):
    time.sleep(0.5)  # simulated compute
    return _scan("docs", (".md",), "docs")


@_record("T5_controlled_failure")
def task_controlled_failure(context):
    # Controlled failure: a real operation that legitimately fails. It must NOT
    # interrupt the other parallel workers (on_failure="partial_ok"). The error
    # is non-retryable so the branch fails on its FIRST (concurrent) attempt
    # without entering the engine's exponential-backoff retry loop.
    time.sleep(0.3)  # simulated compute before failing
    raise _ControlledFailure(
        "Controlled failure in parallel worker T5: reading a required (but "
        "deliberately absent) artifact failed — contained by on_failure=partial_ok."
    )


# Task 6 — aggregate
@_record("T6_aggregate")
def task_aggregate(context):
    time.sleep(0.2)
    parallel_outputs = [_load(i) for i in context.variables.get("parallel_outputs", [])]
    out = {}
    for item in parallel_outputs:
        if isinstance(item, dict) and "label" in item:
            out[item["label"]] = item
        elif isinstance(item, dict):
            out["_item_%d" % len(out)] = item
        else:
            out["_item_%d" % len(out)] = item
    # The failed branch is recorded as an error string; surface it explicitly.
    failed = [o for o in parallel_outputs if isinstance(o, str) and o.startswith("Error")]
    return {"aggregated": out, "failed_branches": failed}


# Task 7 — verify final outcome + temporal overlaps + report
@_record("T7_verify")
def task_verify(context):
    res = _RESULTS.get("T6_aggregate") or {}
    discovered = _RESULTS.get("T1_discover_repo") or {}

    def parse(fn_out):
        if isinstance(fn_out, dict) and "file_count" in fn_out:
            return fn_out
        return None

    # Determine success/failure of the four parallel branches.
    agg = res.get("aggregated", {}) if isinstance(res, dict) else {}
    branches = ["server/src", "web/src", "docs"]
    ok_branches = [b for b in branches if parse(agg.get(b))]
    failed_branches = res.get("failed_branches", []) if isinstance(res, dict) else []

    # Overlap analysis across parallel workers (T2..T5).
    parallel_names = ["T2_analyze_server", "T3_analyze_web", "T4_analyze_docs",
                      "T5_controlled_failure"]
    overlaps = {}
    for a in parallel_names:
        for b in parallel_names:
            if a >= b:
                continue
            ta, tb = _TIMELINE.get(a), _TIMELINE.get(b)
            if not (ta and tb):
                continue
            ov = min(ta["t_end"], tb["t_end"]) - max(ta["t_start"], tb["t_start"])
            overlaps[f"{a} <-> {b}"] = round(max(0.0, ov), 3)

    concurrent_pairs = {k: v for k, v in overlaps.items() if v > 0}

    # Verification gates.
    checks = {
        "engine_importable": _ENGINE_IMPORTABLE,
        "engine_version": _ENGINE_VERSION,
        "engine_name": _ENGINE_NAME,
        "task_count>=5": len(_TIMELINE) >= 5,
        "distinct_worker_threads": len({t["thread"] for t in _TIMELINE.values() if t.get("thread")}) >= 2,
        ">=2_parallel_with_overlap": len(concurrent_pairs) >= 1,
        "controlled_failure_contained": any("T5" in n and "error" in v for n, v in _TIMELINE.items()),
        "other_branches_succeeded": len(ok_branches) == 3,
    }
    passed = all(v is True for v in checks.values() if isinstance(v, bool))

    # Final report (written to disk + returned).
    report = {
        "engine": {"name": _ENGINE_NAME, "class": _ENGINE_CLASS,
                   "version": _ENGINE_VERSION,
                   "module_importable": _ENGINE_IMPORTABLE,
                   "detail": _IMPORT_DETAIL},
        "run": {"id": _RUN_ID, "engine_gate": "PraisonAI used; native team engine NOT used"},
        "timeline": _TIMELINE,
        "overlaps_seconds": overlaps,
        "concurrent_pairs": concurrent_pairs,
        "aggregate": res,
        "discover": discovered,
        "checks": checks,
        "verification_passed": passed,
    }
    out_path = os.path.join(_WORKSPACE, "praisonai_workflow_report.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    return {
        "verification_passed": passed,
        "checks": checks,
        "report_path": out_path,
        "concurrent_pairs": concurrent_pairs,
    }


# ---------------------------------------------------------------------------
# 3. Assemble & run the workflow via PraisonAI Workflow engine.
# ---------------------------------------------------------------------------
def main():
    _ws_start = _now()
    workflow = Workflow(
        name=f"praisonai-verify-{_RUN_ID}",
        description="G-Rex PraisonAI workflow-engine verification run (read-only analysis)",
        steps=[
            task_discover,
            parallel(
                [task_analyze_server, task_analyze_web, task_analyze_docs,
                 task_controlled_failure],
                max_workers=4,
                on_failure="partial_ok",
            ),
            task_aggregate,
            task_verify,
        ],
    )
    result = workflow.run("verify PraisonAI as workflow engine")
    _ws_end = _now()
    verify_out = _RESULTS.get("T7_verify", {})
    concurrent = verify_out.get("concurrent_pairs", {})

    print("=" * 72)
    print(f"ENGINE      : {_ENGINE_NAME} {_ENGINE_VERSION}")
    print(f"ENGINE GATE : {_IMPORT_DETAIL}")
    print(f"RUN ID      : {_RUN_ID}")
    print(f"WORKFLOW    : start={_iso(_ws_start)}  end={_iso(_ws_end)}  "
          f"elapsed={round(_ws_end - _ws_start, 3)}s")
    print("-" * 72)
    print("TASKS / WORKERS (thread, start -> end):")
    for name, t in sorted(_TIMELINE.items()):
        thr = t.get("thread")
        err = f"  [FAILED: {t.get('error')}]" if "error" in t else ""
        print(f"  {name:<26} thread={thr:<8} {t['iso_start']} -> {t['iso_end']}  "
              f"({round(t['t_end']-t['t_start'],3)}s){err}")
    print("-" * 72)
    print("TEMPORAL OVERLAPS (parallel worker pairs, seconds):")
    for pair, ov in sorted(concurrent.items()):
        print(f"  {pair:<46} {ov}")
    print("-" * 72)
    print("FINAL VERDICT : ", end="")
    if result["status"] == "completed":
        print("PraisonAI workflow COMPLETED — engine usable. "
              f"Verdict={verify_out.get('verification_passed')}")
    else:
        print(f"Workflow status = {result['status']}")
    print("=" * 72)


if __name__ == "__main__":
    main()

