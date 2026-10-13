"""How testable a contract is: a 0–100 score from fixed rules, with the fixes worth most.

Each rule is checked on every endpoint it applies to and scores 0–1 there (some rules give
partial credit, such as the share of inputs with a description). A rule's score is its average,
and the contract's score is the weighted average of the rules that apply. No AI is involved, so the
same contract always gets the same score.
"""

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from app.domain.openapi import ApiOperation

GRADES = (("A", 90), ("B", 75), ("C", 60), ("D", 40), ("F", 0))
LIMIT_KEYS = ("format", "pattern", "enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength")
ITEM_METHODS = {"GET", "PUT", "PATCH", "DELETE"}

Category = Literal["testability", "documentation"]


class QualityRule(BaseModel):
    id: str
    label: str
    category: Category
    weight: int
    description: str
    # Endpoints the rule applies to (1 for the API-level rule) and how well they do, 0–100.
    applicable: int
    score: int | None = None


class QualityFinding(BaseModel):
    rule: str
    # None for a finding about the whole API.
    method: str | None = None
    path: str | None = None
    message: str


class QualityFix(BaseModel):
    rule: str
    label: str
    # Points the contract's score would gain if every finding of the rule were fixed.
    points: int
    endpoints: int
    advice: str


class QualityReport(BaseModel):
    score: int
    grade: str
    rules: list[QualityRule]
    top_fixes: list[QualityFix] = Field(default_factory=list)
    findings: list[QualityFinding] = Field(default_factory=list)
    # The report as Markdown. A stored field rather than a computed one, so an overview that
    # contains a report has the same schema when it is sent back (for example to suggest flows).
    markdown: str = ""


@dataclass(frozen=True)
class Check:
    id: str
    label: str
    category: Category
    weight: int
    description: str
    advice: str
    # Returns None when the rule does not apply, else (score 0–1, what is missing).
    evaluate: Callable[["ApiOperation", "Context"], tuple[float, str] | None]


@dataclass(frozen=True)
class Context:
    duplicate_ids: frozenset[str]


def _inputs(operation: "ApiOperation") -> list[tuple[str, object]]:
    """Parameters other than credentials, and body fields other than files, as (label, item)."""
    params = [(f"{p.name} ({p.location})", p) for p in operation.parameters if not p.credential]
    fields = [(f"{f.name} (body)", f) for f in operation.request_body_fields if not f.is_file]
    return params + fields


def _codes(operation: "ApiOperation") -> list[str]:
    return list(dict.fromkeys([*operation.response_codes, *operation.response_schemas]))


def _documents(codes: Sequence[str], first_digit: str) -> bool:
    return any(code[:1] == first_digit for code in codes)


def _success_schema(operation, _):
    if operation.method in {"HEAD", "OPTIONS"}:
        return None
    codes = _codes(operation)
    success = [code for code in codes if code.startswith("2") or code.upper() == "2XX"]
    if not success:
        return 0.0, "No success response is documented."
    if any(code in operation.response_schemas for code in success) or all(code == "204" for code in success):
        return 1.0, ""
    return 0.0, f"Response {success[0]} has no JSON schema, so its body cannot be checked."


def _error_responses(operation, _):
    if _documents(_codes(operation), "4"):
        return 1.0, ""
    return 0.0, "No 4xx response is documented, so negative checks guess 400 or 422."


def _input_examples(operation, _):
    required = [(label, item) for label, item in _inputs(operation) if getattr(item, "required", False)]
    if not required:
        return None
    missing = [label for label, item in required if getattr(item, "example", None) is None]
    if not missing:
        return 1.0, ""
    return (len(required) - len(missing)) / len(required), f"No example, default, or enum for {', '.join(missing)}."


def _input_limits(operation, _):
    inputs = [
        (label, item) for label, item in _inputs(operation)
        if getattr(item, "field_type", "string") in {"string", "integer", "number"}
    ]
    if not inputs:
        return None
    missing = [label for label, item in inputs if not any(key in (getattr(item, "value_schema", None) or {}) for key in LIMIT_KEYS)]
    if not missing:
        return 1.0, ""
    return (len(inputs) - len(missing)) / len(inputs), f"No limits (format, pattern, enum, length, or range) for {', '.join(missing)}."


def _valid_request(operation, _):
    if any(scenario.category == "happy_path" and scenario.request_example is not None for scenario in operation.scenarios):
        return 1.0, ""
    return 0.0, "A valid request cannot be built from the contract: describe the request body as JSON or a form with a schema."


def _auth_errors(operation, _):
    if not any(parameter.credential for parameter in operation.parameters):
        return None
    if any(code.upper() in {"401", "403", "4XX"} for code in _codes(operation)):
        return 1.0, ""
    return 0.0, "Secured, but neither 401 nor 403 is documented."


def _not_found(operation, _):
    if operation.method not in ITEM_METHODS or "{" not in operation.path:
        return None
    if any(code in {"404", "4XX"} for code in (code.upper() for code in _codes(operation))):
        return 1.0, ""
    return 0.0, "Takes a record id in the path, but 404 is not documented."


def _operation_id(operation, context):
    if not operation.operation_id:
        return 0.0, "No operationId."
    if operation.operation_id in context.duplicate_ids:
        return 0.0, f"operationId {operation.operation_id!r} is used by another endpoint too."
    return 1.0, ""


def _summary(operation, _):
    return (1.0, "") if operation.summary else (0.0, "No summary.")


def _input_descriptions(operation, _):
    inputs = _inputs(operation)
    if not inputs:
        return None
    missing = [label for label, item in inputs if not getattr(item, "description", None)]
    if not missing:
        return 1.0, ""
    return (len(inputs) - len(missing)) / len(inputs), f"No description for {', '.join(missing)}."


CHECKS = (
    Check("success-schema", "Success responses have a schema", "testability", 3,
          "A JSON schema for the success response lets every check also verify the response body.",
          "Document a JSON schema for each success response", _success_schema),
    Check("input-examples", "Required inputs have examples", "testability", 3,
          "With an example, default, or enum for every required input, checks run without typing values first.",
          "Add examples for required inputs", _input_examples),
    Check("valid-request", "A valid request can be built", "testability", 2,
          "Without a request schema the app cannot build a valid request, so the endpoint has no runnable checks.",
          "Describe request bodies as JSON or form schemas", _valid_request),
    Check("error-responses", "Error responses are documented", "testability", 2,
          "Documented 4xx responses tell negative checks which status to expect.",
          "Document 4xx error responses", _error_responses),
    Check("input-limits", "Inputs have limits", "testability", 1,
          "Formats, patterns, enums, lengths, and ranges make boundary and invalid-value checks possible.",
          "Document limits for inputs (format, enum, length, range)", _input_limits),
    Check("auth-errors", "Secured endpoints document 401 or 403", "testability", 1,
          "The Call without authentication check expects the documented 401 or 403.",
          "Document 401 or 403 for secured endpoints", _auth_errors),
    Check("not-found", "Record endpoints document 404", "testability", 1,
          "An endpoint that takes a record id should say what happens when the record does not exist.",
          "Document 404 for endpoints that take a record id", _not_found),
    Check("operation-id", "Endpoints have a unique operationId", "documentation", 1,
          "operationIds name endpoints in reports and let OpenAPI links point at them.",
          "Give every endpoint a unique operationId", _operation_id),
    Check("summary", "Endpoints have a summary", "documentation", 1,
          "A summary says what an endpoint is for, in reports and in the overview.",
          "Add a summary to each endpoint", _summary),
    Check("input-descriptions", "Inputs are described", "documentation", 1,
          "Descriptions help people fill in request details and help AI suggest sensible values.",
          "Describe parameters and body fields", _input_descriptions),
)
SERVER_RULE = ("server", "A server is declared", "testability", 2,
               "A declared server gives checks a default target URL.", "Declare a server URL")


def assess_quality(operations: Sequence["ApiOperation"], servers: Sequence[str]) -> QualityReport:
    if not operations:
        return _no_endpoints(servers)
    ids = [operation.operation_id for operation in operations if operation.operation_id]
    context = Context(duplicate_ids=frozenset(item for item in ids if ids.count(item) > 1))
    rules: list[QualityRule] = []
    findings: list[QualityFinding] = []
    lost: dict[str, tuple[float, int]] = {}
    weighted = total_weight = 0.0

    for check in CHECKS:
        scores = []
        failing = 0
        for operation in operations:
            outcome = check.evaluate(operation, context)
            if outcome is None:
                continue
            value, message = outcome
            scores.append(value)
            if value < 1:
                failing += 1
                findings.append(QualityFinding(rule=check.id, method=operation.method, path=operation.path, message=message))
        average = sum(scores) / len(scores) if scores else None
        rules.append(QualityRule(
            id=check.id, label=check.label, category=check.category, weight=check.weight, description=check.description,
            applicable=len(scores), score=None if average is None else round(average * 100),
        ))
        if average is not None:
            weighted += check.weight * average
            total_weight += check.weight
            lost[check.id] = (check.weight * (1 - average), failing)

    rule_id, label, category, weight, description, advice = SERVER_RULE
    has_server = any(server.strip() for server in servers)
    rules.append(QualityRule(id=rule_id, label=label, category=category, weight=weight, description=description, applicable=1, score=100 if has_server else 0))
    weighted += weight * has_server
    total_weight += weight
    if not has_server:
        findings.append(QualityFinding(rule=rule_id, message="The contract declares no server, so every run needs a target URL typed in."))
        lost[rule_id] = (float(weight), 0)

    score = round(weighted / total_weight * 100) if total_weight else 0
    advice_by_id = {check.id: check.advice for check in CHECKS} | {rule_id: advice}
    label_by_id = {rule.id: rule.label for rule in rules}
    fixes = [
        QualityFix(rule=rid, label=label_by_id[rid], points=round(points / total_weight * 100), endpoints=count, advice=advice_by_id[rid])
        for rid, (points, count) in lost.items()
        if round(points / total_weight * 100) > 0
    ]
    fixes.sort(key=lambda fix: (-fix.points, fix.rule))
    report = QualityReport(score=score, grade=grade(score), rules=rules, top_fixes=fixes[:5], findings=findings)
    report.markdown = quality_markdown(report)
    return report


def _no_endpoints(servers: Sequence[str]) -> QualityReport:
    """Nothing can be tested without endpoints; scoring only the server rule would point at the wrong fix."""
    rule_id, label, category, weight, description, _ = SERVER_RULE
    has_server = any(server.strip() for server in servers)
    rules = [
        QualityRule(id=check.id, label=check.label, category=check.category, weight=check.weight, description=check.description, applicable=0)
        for check in CHECKS
    ] + [QualityRule(id=rule_id, label=label, category=category, weight=weight, description=description, applicable=1, score=100 if has_server else 0)]
    report = QualityReport(
        score=0,
        grade="F",
        rules=rules,
        top_fixes=[QualityFix(rule="endpoints", label="The contract documents endpoints", points=100, endpoints=0,
                              advice="Document the API's endpoints under paths")],
        findings=[QualityFinding(rule="endpoints", message="The contract documents no endpoints (its paths object is empty), so there is nothing to test.")],
    )
    report.markdown = quality_markdown(report)
    return report


def grade(score: int) -> str:
    return next(letter for letter, minimum in GRADES if score >= minimum)


def quality_markdown(report: QualityReport) -> str:
    lines = [f"## Contract quality: {report.score} / 100 ({report.grade})", ""]
    if report.top_fixes:
        lines += ["### Fixes worth most", ""]
        lines += [
            f"- **+{fix.points}** {fix.advice}" + (f" ({fix.endpoints} {'endpoint' if fix.endpoints == 1 else 'endpoints'})" if fix.endpoints else "")
            for fix in report.top_fixes
        ]
        lines.append("")
    lines += ["### Rules", "", "| Rule | Weight | Score |", "|---|---|---|"]
    lines += [
        f"| {rule.label} | {rule.weight} | {'n/a' if rule.score is None else f'{rule.score}%'} |"
        for rule in report.rules
    ]
    if report.findings:
        lines += ["", "### Findings", ""]
        lines += [
            f"- {'`' + finding.method + ' ' + finding.path + '`: ' if finding.method else ''}{_escape(finding.message)}"
            for finding in report.findings
        ]
    return "\n".join(lines) + "\n"


def _escape(text: str) -> str:
    return re.sub(r"([*_`])", r"\\\1", text)
