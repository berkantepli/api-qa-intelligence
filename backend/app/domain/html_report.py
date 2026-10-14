"""A self-contained HTML report of a run or of an API's coverage, to send to someone or attach to CI.

One file with its styles inline and no scripts or external resources, so it opens offline and in a
mail attachment. Every value is escaped: a response body that holds markup is shown as text. The
evidence it shows was masked when the run was saved (or by the CLI), so no credential reaches it."""

from datetime import UTC, datetime
from html import escape
from typing import Any

from pydantic import BaseModel, Field

from app.domain.reports import RunReport, failure_message
from app.domain.run_compare import ComparedCheck, RunComparison

MAX_BODY_CHARS = 10_000


class ReportCheck(BaseModel):
    # The endpoint ("GET /books") or flow ("Flow: Book lifecycle") the check belongs to.
    group: str = Field(max_length=2_000)
    title: str = Field(max_length=500)
    category: str | None = Field(default=None, max_length=50)
    result: str = Field(max_length=10)
    request: str = Field(default="", max_length=8_000)
    response_status: int | None = None
    expected_status_codes: list[int] = Field(default_factory=list, max_length=20)
    duration_ms: int | None = None
    message: str = Field(default="", max_length=4_000)
    schema_errors: list[str] = Field(default_factory=list, max_length=200)
    request_headers: dict[str, str] = Field(default_factory=dict, max_length=200)
    request_body: str = Field(default="", max_length=100_000)
    response_headers: dict[str, str] = Field(default_factory=dict, max_length=200)
    response_body: str = Field(default="", max_length=100_000)
    analysis: str | None = Field(default=None, max_length=8_000)


class ReportCoverageEndpoint(BaseModel):
    key: str = Field(max_length=2_000)
    status: str = Field(max_length=20)
    covered: int = 0
    runnable: int = 0
    last_run_at: str | None = Field(default=None, max_length=40)
    risks: list[str] = Field(default_factory=list, max_length=50)


class ReportCoverage(BaseModel):
    tested: int
    endpoints: int
    failing: int
    untested_writes: int = 0
    coverage_percent: int = 0
    quality_score: int | None = None
    quality_grade: str | None = Field(default=None, max_length=2)
    flows_passing: int | None = None
    flows_total: int | None = None
    items: list[ReportCoverageEndpoint] = Field(default_factory=list, max_length=5_000)


class HtmlReportRequest(BaseModel):
    # What the report is about, such as "GET /books" or "Coverage".
    title: str = Field(max_length=500)
    api: str = Field(max_length=500)
    api_version: str = Field(default="", max_length=100)
    target: str = Field(default="", max_length=2_000)
    run_at: str | None = Field(default=None, max_length=40)
    checks: list[ReportCheck] = Field(default_factory=list, max_length=5_000)
    coverage: ReportCoverage | None = None
    comparison: RunComparison | None = None
    # Which moment the comparison is against, such as "the previous run (13 Oct 2026, 14:02)".
    comparison_label: str = Field(default="", max_length=300)
    include_passing_evidence: bool = False


STYLE = """
:root { color-scheme: light dark; --bg: #f6f7fb; --surface: #fff; --text: #242631; --muted: #6b6f80; --line: #e3e5ee;
  --accent: #5548c8; --pass: #18865e; --pass-soft: #eaf7f1; --fail: #c44755; --fail-soft: #fff0f1; --warn: #a15c07; --warn-soft: #fff6e5; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0f14; --surface: #171a21; --text: #f4f7fb; --muted: #a5adbb; --line: #2d3440;
  --accent: #7b9bfa; --pass: #22c55e; --pass-soft: #13251c; --fail: #ef6670; --fail-soft: #2a191d; --warn: #f0a33a; --warn-soft: #2a2114; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 48px; }
header p, .muted { color: var(--muted); }
h1 { margin: 4px 0; font-size: 26px; } h2 { margin: 30px 0 10px; font-size: 18px; } h3 { margin: 0; font-size: 14px; }
.eyebrow { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-top: 18px; }
.card { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.card span { display: block; color: var(--muted); font-size: 12px; } .card strong { font-size: 22px; }
.bar { display: flex; height: 8px; margin-top: 14px; overflow: hidden; border-radius: 99px; background: var(--line); }
.bar i { display: block; } .bar .pass { background: var(--pass); } .bar .fail { background: var(--fail); } .bar .error { background: var(--warn); }
table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 12px; font-weight: 600; } tr:last-child td { border-bottom: 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { margin: 6px 0 0; padding: 10px; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); white-space: pre-wrap; word-break: break-word; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; }
.PASS, .passing { background: var(--pass-soft); color: var(--pass); } .FAIL, .failing { background: var(--fail-soft); color: var(--fail); }
.ERROR, .SKIPPED, .untested { background: var(--warn-soft); color: var(--warn); }
details { margin-top: 10px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
details > summary { cursor: pointer; font-weight: 600; } details h4 { margin: 12px 0 0; color: var(--muted); font-size: 12px; }
.change-group { margin-top: 14px; } .change-group h3 { display: flex; gap: 8px; align-items: center; }
ul { margin: 6px 0 0; padding-left: 20px; } li { margin: 3px 0; }
footer { margin-top: 36px; color: var(--muted); font-size: 12px; }
@media print { body { background: #fff; color: #000; } details { break-inside: avoid; } details:not([open]) > *:not(summary) { display: none; } }
"""


def _e(value: Any) -> str:
    return escape("" if value is None else str(value), quote=True)


def _when(value: str | None) -> str:
    if not value:
        return ""
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return moment.astimezone(UTC).strftime("%d %b %Y, %H:%M UTC")


def _tag(result: str) -> str:
    return f'<span class="tag {_e(result)}">{_e(result)}</span>'


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def _headers(headers: dict[str, str]) -> str:
    return "\n".join(f"{name}: {value}" for name, value in sorted(headers.items()))


def _body(text: str) -> str:
    return text if len(text) <= MAX_BODY_CHARS else f"{text[:MAX_BODY_CHARS]}\n… (cut at {MAX_BODY_CHARS:,} characters)"


def _summary(checks: list[ReportCheck]) -> str:
    counts = {result: sum(check.result == result for check in checks) for result in ("PASS", "FAIL", "ERROR", "SKIPPED")}
    ran = counts["PASS"] + counts["FAIL"] + counts["ERROR"]
    cards = [("Checks", len(checks)), ("Passed", counts["PASS"]), ("Failed", counts["FAIL"]), ("Errors", counts["ERROR"])]
    if counts["SKIPPED"]:
        cards.append(("Skipped", counts["SKIPPED"]))
    bar = "".join(
        f'<i class="{css}" style="width:{100 * counts[result] / ran:.2f}%"></i>'
        for result, css in (("PASS", "pass"), ("FAIL", "fail"), ("ERROR", "error"))
        if ran and counts[result]
    )
    return (
        '<div class="cards">' + "".join(f'<div class="card"><span>{label}</span><strong>{value}</strong></div>' for label, value in cards) + "</div>"
        + (f'<div class="bar" role="img" aria-label="{counts["PASS"]} passed, {counts["FAIL"]} failed, {counts["ERROR"]} errors">{bar}</div>' if ran else "")
    )


def _change_rows(items: list[ComparedCheck], show: str) -> str:
    rows = []
    for item in items:
        old, new = item.before, item.after
        if show == "slower" and old and new:
            detail = f"{old.duration_ms} ms → {new.duration_ms} ms"
        elif show == "result" and old and new:
            detail = f"{old.result} → {new.result}" + (f" · {new.message}" if new.message and new.result != "PASS" else "")
        elif show == "still" and new:
            detail = new.message + (" (a different reason than before)" if item.message_changed else "")
        else:
            record = new or old
            detail = f"{record.result}" if record else ""
        rows.append(f"<li><code>{_e(item.endpoint)}</code> · {_e(item.title)}<br><span class=\"muted\">{_e(detail)}</span></li>")
    return "<ul>" + "".join(rows) + "</ul>"


def _comparison(comparison: RunComparison, label: str) -> str:
    groups = [
        ("Newly failing", "FAIL", comparison.newly_failing, "result"),
        ("Fixed", "PASS", comparison.fixed, "result"),
        ("Still failing", "FAIL", comparison.still_failing, "still"),
        ("Slower", "ERROR", comparison.slower, "slower"),
        ("Only in the earlier results", "SKIPPED", comparison.only_before, "plain"),
        ("Only in the later results", "SKIPPED", comparison.only_after, "plain"),
    ]
    body = "".join(
        f'<div class="change-group"><h3><span class="tag {css}">{len(items)}</span> {title}</h3>{_change_rows(items, show)}</div>'
        for title, css, items, show in groups
        if items
    )
    if not body:
        body = '<p class="muted">Nothing changed: every check has the same result as before.</p>'
    unchanged = f'<p class="muted">{_plural(comparison.unchanged_passing, "check")} passed both times without slowing down.</p>' if comparison.unchanged_passing else ""
    return f"<section><h2>Changes since {_e(label or 'the earlier results')}</h2>{body}{unchanged}</section>"


def _coverage(coverage: ReportCoverage) -> str:
    cards = [
        ("Endpoints tested", f"{coverage.tested} / {coverage.endpoints}"),
        ("Coverage", f"{coverage.coverage_percent}%"),
        ("Failing endpoints", coverage.failing),
        ("Untested write endpoints", coverage.untested_writes),
    ]
    if coverage.flows_total:
        cards.append(("Lifecycle flows passing", f"{coverage.flows_passing} / {coverage.flows_total}"))
    if coverage.quality_score is not None:
        cards.append(("Contract quality", f"{coverage.quality_score} / 100 ({coverage.quality_grade})"))
    order = {"failing": 0, "untested": 1, "passing": 2}
    rows = "".join(
        f"<tr><td><code>{_e(item.key)}</code></td><td><span class=\"tag {_e(item.status)}\">{_e(item.status.title() if item.status != 'untested' else 'Not tested')}</span></td>"
        f"<td>{item.covered} / {item.runnable}</td><td>{_e(_when(item.last_run_at)) or '—'}</td><td>{_e(', '.join(item.risks)) or '—'}</td></tr>"
        for item in sorted(coverage.items, key=lambda item: (order.get(item.status, 3), item.key))
    )
    return (
        "<section><h2>Coverage</h2>"
        + '<div class="cards">' + "".join(f'<div class="card"><span>{_e(label)}</span><strong>{_e(value)}</strong></div>' for label, value in cards) + "</div>"
        + f"<h2>Endpoints</h2><table><thead><tr><th>Endpoint</th><th>Latest status</th><th>Checks run</th><th>Last run</th><th>Risks</th></tr></thead><tbody>{rows}</tbody></table></section>"
    )


def _check_detail(check: ReportCheck) -> str:
    parts = [f"<summary>{_tag(check.result)} <code>{_e(check.group)}</code> · {_e(check.title)}</summary>"]
    if check.message:
        parts.append(f"<p>{_e(check.message)}</p>")
    if check.schema_errors:
        parts.append("<h4>Schema differences</h4><ul>" + "".join(f"<li><code>{_e(error)}</code></li>" for error in check.schema_errors) + "</ul>")
    if check.analysis:
        parts.append(f"<h4>AI analysis (advisory)</h4><p>{_e(check.analysis)}</p>")
    if check.request:
        request = check.request + ("\n" + _headers(check.request_headers) if check.request_headers else "")
        parts.append(f"<h4>Request</h4><pre>{_e(request)}</pre>")
        if check.request_body:
            parts.append(f"<pre>{_e(_body(check.request_body))}</pre>")
    if check.response_status is not None:
        response = f"HTTP {check.response_status}" + ("\n" + _headers(check.response_headers) if check.response_headers else "")
        parts.append(f"<h4>Response</h4><pre>{_e(response)}</pre>")
        if check.response_body:
            parts.append(f"<pre>{_e(_body(check.response_body))}</pre>")
    return f"<details{' open' if check.result in ('FAIL', 'ERROR') else ''}>{''.join(parts)}</details>"


def _checks(checks: list[ReportCheck], include_passing_evidence: bool) -> str:
    order = {"FAIL": 0, "ERROR": 1, "SKIPPED": 2, "PASS": 3}
    ordered = sorted(checks, key=lambda check: order.get(check.result, 4))
    rows = "".join(
        f"<tr><td>{_tag(check.result)}</td><td><code>{_e(check.group)}</code></td><td>{_e(check.title)}</td>"
        f"<td>{_e(check.response_status) or '—'}{' (expected ' + _e(' or '.join(map(str, check.expected_status_codes))) + ')' if check.expected_status_codes and check.result != 'PASS' else ''}</td>"
        f"<td>{_e(check.duration_ms) + ' ms' if check.duration_ms is not None else '—'}</td></tr>"
        for check in ordered
    )
    detailed = [check for check in ordered if check.result in ("FAIL", "ERROR") or (include_passing_evidence and check.result == "PASS")]
    details = "".join(_check_detail(check) for check in detailed)
    note = "" if include_passing_evidence else '<p class="muted">Evidence is included for failed checks and errors only.</p>'
    return (
        f"<section><h2>Checks</h2><table><thead><tr><th>Result</th><th>Endpoint</th><th>Check</th><th>Status</th><th>Time</th></tr></thead><tbody>{rows}</tbody></table></section>"
        + (f"<section><h2>Details</h2>{note}{details}</section>" if details else "")
    )


def render_html_report(request: HtmlReportRequest, tool_version: str, generated_at: datetime | None = None) -> str:
    generated = (generated_at or datetime.now(UTC)).astimezone(UTC).strftime("%d %b %Y, %H:%M UTC")
    facts = " · ".join(_e(part) for part in (
        f"{request.api} {request.api_version}".strip(),
        f"Target: {request.target}" if request.target else "",
        f"Run at {_when(request.run_at)}" if request.run_at else "",
    ) if part)
    sections = [
        _summary(request.checks) if request.checks else "",
        _comparison(request.comparison, request.comparison_label) if request.comparison else "",
        _coverage(request.coverage) if request.coverage else "",
        _checks(request.checks, request.include_passing_evidence) if request.checks else "",
    ]
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        # Nothing in the report may load or run anything, whatever an API returned.
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
        f"<title>{_e(request.api)}: {_e(request.title)}</title><style>{STYLE}</style></head><body><main>"
        f'<header><div class="eyebrow">API QA report</div><h1>{_e(request.title)}</h1><p>{facts}</p></header>'
        + "".join(sections)
        + f'<footer>Generated by API QA Intelligence {_e(tool_version)} on {generated}. Credential-like values were masked before they were saved.</footer>'
        "</main></body></html>\n"
    )


def html_request_from_report(report: RunReport, comparison: RunComparison | None = None, comparison_label: str = "") -> HtmlReportRequest:
    """The HTML report of an `api-qa run`: every check and flow step, skipped ones included."""
    checks: list[ReportCheck] = []
    for endpoint in report.endpoints:
        for check in endpoint.checks:
            result = check.result
            checks.append(ReportCheck(
                group=endpoint.key, title=check.title, category=check.category, result=result.result,
                request=f"{result.method} {result.request_url}", response_status=result.response_status,
                expected_status_codes=result.expected_status_codes, duration_ms=result.duration_ms,
                message="" if result.result == "PASS" else failure_message(result),
                schema_errors=result.schema_check.errors if result.schema_check else [],
                request_headers=result.request_headers, request_body=result.request_body,
                response_headers=result.response_headers, response_body=result.response_body,
            ))
        for title in endpoint.skipped_checks:
            checks.append(ReportCheck(group=endpoint.key, title=title, result="SKIPPED", message=endpoint.skipped_reason or "Skipped"))
    for flow in report.flows:
        for step in flow.result.steps if flow.result else []:
            check = step.check
            checks.append(ReportCheck(
                group=flow.suite_name, title=step.title, result=step.status,
                request=f"{check.method} {check.request_url}" if check else "",
                response_status=check.response_status if check else None,
                expected_status_codes=check.expected_status_codes if check else [],
                duration_ms=check.duration_ms if check else None,
                message=step.reason or (failure_message(check) if check and step.status != "PASS" else ""),
                schema_errors=check.schema_check.errors if check and check.schema_check else [],
                request_headers=check.request_headers if check else {}, request_body=check.request_body if check else "",
                response_headers=check.response_headers if check else {}, response_body=check.response_body if check else "",
            ))
        for title in flow.skipped_steps:
            checks.append(ReportCheck(group=flow.suite_name, title=title, result="SKIPPED", message=flow.skipped_reason or "Skipped"))
    return HtmlReportRequest(
        title="CI run", api=report.api, api_version=report.api_version, target=report.target, run_at=report.generated_at,
        checks=checks, comparison=comparison, comparison_label=comparison_label,
    )
