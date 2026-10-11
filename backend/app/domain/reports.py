"""Run reports for CI: a JSON document and JUnit XML, which CI services display as test results."""

from datetime import UTC, datetime
from xml.etree import ElementTree

from pydantic import BaseModel, Field, computed_field

from app.domain.execution import ScenarioExecutionResult
from app.domain.flows import FlowExecutionResult


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


class FlowOutcome(BaseModel):
    id: str
    title: str
    result: FlowExecutionResult | None = None
    # Set when the flow did not run, with the steps that were left out.
    skipped_reason: str | None = None
    skipped_steps: list[str] = Field(default_factory=list)

    @property
    def suite_name(self) -> str:
        return f"Flow: {self.title}"


class RunReport(BaseModel):
    api: str
    api_version: str
    target: str
    tool_version: str
    generated_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    endpoints: list[EndpointOutcome] = Field(default_factory=list)
    # Multi-step lifecycle flows, run with --flows.
    flows: list[FlowOutcome] = Field(default_factory=list)

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
            "flows": len(self.flows),
            "flows_passed": sum(bool(flow.result) and flow.result.result == "PASS" for flow in self.flows),
            "flows_failed": sum(bool(flow.result) and flow.result.result != "PASS" for flow in self.flows),
            "flows_skipped": sum(flow.result is None for flow in self.flows),
        }


def failure_message(result: ScenarioExecutionResult) -> str:
    expected = " or ".join(str(code) for code in result.expected_status_codes)
    if result.response_status is None:
        return result.error or f"Expected HTTP {expected}, but no response was received."
    if result.too_slow and result.response_status in result.expected_status_codes:
        return f"HTTP {result.response_status} as expected, but it took {result.duration_ms} ms (limit {result.max_duration_ms} ms)."
    if result.schema_check and result.schema_check.status == "failed":
        return f"HTTP {result.response_status} as expected, but the body does not match the documented schema: {result.schema_check.detail}"
    return f"Expected HTTP {expected}, received HTTP {result.response_status}."


def junit_xml(report: RunReport) -> str:
    """One test suite per endpoint and one test case per check; skipped endpoints list their checks as skipped."""
    totals = report.totals
    steps = [step.status for flow in report.flows if flow.result for step in flow.result.steps]
    skipped_steps = steps.count("SKIPPED") + sum(len(flow.skipped_steps) for flow in report.flows)
    suites = ElementTree.Element(
        "testsuites",
        name=f"API QA: {report.api} {report.api_version}",
        tests=str(totals["checks"] + totals["skipped_checks"] + len(steps) + sum(len(flow.skipped_steps) for flow in report.flows)),
        failures=str(totals["failed"] + steps.count("FAIL")),
        errors=str(totals["errors"] + steps.count("ERROR")),
        skipped=str(totals["skipped_checks"] + skipped_steps),
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
    for flow in report.flows:
        _flow_suite(suites, flow, report.generated_at)
    ElementTree.indent(suites)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ElementTree.tostring(suites, encoding="unicode") + "\n"


def _flow_suite(suites: ElementTree.Element, flow: FlowOutcome, timestamp: str) -> None:
    """One test suite per flow and one test case per step, in order."""
    steps = flow.result.steps if flow.result else []
    statuses = [step.status for step in steps]
    suite = ElementTree.SubElement(
        suites,
        "testsuite",
        name=flow.suite_name,
        tests=str(len(steps) + len(flow.skipped_steps)),
        failures=str(statuses.count("FAIL")),
        errors=str(statuses.count("ERROR")),
        skipped=str(statuses.count("SKIPPED") + len(flow.skipped_steps)),
        time=f"{sum(step.check.duration_ms for step in steps if step.check) / 1000:.3f}",
        timestamp=timestamp,
    )
    for number, step in enumerate(steps, start=1):
        check = step.check
        case = ElementTree.SubElement(
            suite, "testcase", classname=flow.suite_name, name=f"{number}. {step.title}",
            time=f"{(check.duration_ms if check else 0) / 1000:.3f}",
        )
        if step.status == "PASS":
            continue
        if step.status == "SKIPPED":
            ElementTree.SubElement(case, "skipped", message=step.reason or "Skipped")
            continue
        message = step.reason or (failure_message(check) if check else "The step did not run.")
        element = ElementTree.SubElement(case, "failure" if step.status == "FAIL" else "error", message=message)
        if check:
            lines = [f"Request: {check.method} {check.request_url}"]
            if check.schema_check and check.schema_check.errors:
                lines += ["Schema differences:", *(f"  {error}" for error in check.schema_check.errors)]
            if check.response_body:
                lines += ["Response body:", check.response_body[:2_000]]
            element.text = "\n".join(lines)
    for number, title in enumerate(flow.skipped_steps, start=1):
        case = ElementTree.SubElement(suite, "testcase", classname=flow.suite_name, name=f"{number}. {title}", time="0")
        ElementTree.SubElement(case, "skipped", message=flow.skipped_reason or "Skipped")
