"""Run reports for CI: a JSON document and JUnit XML, which CI services display as test results."""

from datetime import UTC, datetime
from xml.etree import ElementTree

from pydantic import BaseModel, Field, computed_field

from app.domain.execution import ScenarioExecutionResult


class CheckOutcome(BaseModel):
    title: str
    category: str
    result: ScenarioExecutionResult


class EndpointOutcome(BaseModel):
    method: str
    path: str
    checks: list[CheckOutcome] = Field(default_factory=list)
    # Set when the endpoint did not run, with the checks that were left out.
    skipped_reason: str | None = None
    skipped_checks: list[str] = Field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.method} {self.path}"


class RunReport(BaseModel):
    api: str
    api_version: str
    target: str
    tool_version: str
    generated_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    endpoints: list[EndpointOutcome] = Field(default_factory=list)

    @computed_field
    @property
    def totals(self) -> dict[str, int]:
        outcomes = [check.result.result for endpoint in self.endpoints for check in endpoint.checks]
        return {
            "checks": len(outcomes),
            "passed": outcomes.count("PASS"),
            "failed": outcomes.count("FAIL"),
            "errors": outcomes.count("ERROR"),
            "skipped_checks": sum(len(endpoint.skipped_checks) for endpoint in self.endpoints),
            "skipped_endpoints": sum(bool(endpoint.skipped_checks) for endpoint in self.endpoints),
        }


def failure_message(result: ScenarioExecutionResult) -> str:
    expected = " or ".join(str(code) for code in result.expected_status_codes)
    if result.response_status is None:
        return result.error or f"Expected HTTP {expected}, but no response was received."
    if result.schema_check and result.schema_check.status == "failed":
        return f"HTTP {result.response_status} as expected, but the body does not match the documented schema: {result.schema_check.detail}"
    return f"Expected HTTP {expected}, received HTTP {result.response_status}."


def junit_xml(report: RunReport) -> str:
    """One test suite per endpoint and one test case per check; skipped endpoints list their checks as skipped."""
    totals = report.totals
    suites = ElementTree.Element(
        "testsuites",
        name=f"API QA: {report.api} {report.api_version}",
        tests=str(totals["checks"] + totals["skipped_checks"]),
        failures=str(totals["failed"]),
        errors=str(totals["errors"]),
        skipped=str(totals["skipped_checks"]),
    )
    for endpoint in report.endpoints:
        if not endpoint.checks and not endpoint.skipped_checks:
            continue
        outcomes = [check.result.result for check in endpoint.checks]
        suite = ElementTree.SubElement(
            suites,
            "testsuite",
            name=endpoint.key,
            tests=str(len(endpoint.checks) + len(endpoint.skipped_checks)),
            failures=str(outcomes.count("FAIL")),
            errors=str(outcomes.count("ERROR")),
            skipped=str(len(endpoint.skipped_checks)),
            time=f"{sum(check.result.duration_ms for check in endpoint.checks) / 1000:.3f}",
            timestamp=report.generated_at,
        )
        for check in endpoint.checks:
            case = ElementTree.SubElement(
                suite, "testcase", classname=endpoint.key, name=check.title, time=f"{check.result.duration_ms / 1000:.3f}"
            )
            if check.result.result == "PASS":
                continue
            element = ElementTree.SubElement(
                case, "failure" if check.result.result == "FAIL" else "error", message=failure_message(check.result)
            )
            lines = [f"Request: {check.result.method} {check.result.request_url}"]
            if check.result.schema_check and check.result.schema_check.errors:
                lines += ["Schema differences:", *(f"  {error}" for error in check.result.schema_check.errors)]
            if check.result.response_body:
                lines += ["Response body:", check.result.response_body[:2_000]]
            element.text = "\n".join(lines)
        for title in endpoint.skipped_checks:
            case = ElementTree.SubElement(suite, "testcase", classname=endpoint.key, name=title, time="0")
            ElementTree.SubElement(case, "skipped", message=endpoint.skipped_reason or "Skipped")
    ElementTree.indent(suites)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ElementTree.tostring(suites, encoding="unicode") + "\n"
