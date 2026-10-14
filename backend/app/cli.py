"""Command-line tools for CI pipelines: ``api-qa run --spec openapi.json --junit report.xml`` (or
``--workspace export.json`` for the checks and flows saved in the app), and
``api-qa diff old.yaml new.yaml`` (see compare_contracts), and ``api-qa lint openapi.yaml`` (lint_contract).

It runs an OpenAPI contract's runnable checks against a target API without the web app and
exits with 0 when every check passes, 1 when a check fails or errors, and 2 on a usage or
contract error. AI features are never used, so results are repeatable.
"""

import argparse
import asyncio
import fnmatch
import json
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin

import httpx
import yaml
from fastapi import HTTPException
from pydantic import ValidationError

from app.domain.contract_diff import SEVERITY_ORDER, diff_contracts, diff_markdown
from app.domain.documents import UNEXPECTED_SHAPE, DocumentTooComplexError, parse_document
from app.domain.evidence import hide_secret_values
from app.domain.execution import ScenarioExecutionRequest, execute_scenario
from app.domain.flows import UNFILLED_PATH_PARAMETER, ApiFlow, FlowExecutionRequest, execute_flow
from app.domain.network import request_error_reason
from app.domain.openapi import ApiOverview, OpenApiDocumentError, summarize_openapi
from app.domain.reports import CheckOutcome, EndpointOutcome, FlowOutcome, RunReport, junit_xml
from app.domain.request_builder import (
    SAFE_METHODS,
    build_check_request,
    describe_operation,
    request_readiness,
    secret_parameter_names,
)
from app.domain.workspace_file import WorkspaceFileError, load_workspace_api
from app.version import APP_VERSION

MAX_SPEC_SIZE_BYTES = 2_000_000
# A workspace export also carries Run history, so it may be much larger than one contract.
MAX_WORKSPACE_SIZE_BYTES = 50_000_000
CONTRACT_FETCH_SECONDS = 15
EXIT_OK, EXIT_FAILED, EXIT_USAGE = 0, 1, 2


class UsageError(Exception):
    """A problem with the command line or the contract; reported with exit code 2."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="api-qa", description="Run an OpenAPI contract's QA checks against an API.")
    parser.add_argument("--version", action="version", version=f"api-qa {APP_VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run the runnable checks and write reports.")
    source = run.add_mutually_exclusive_group(required=True)
    source.add_argument("--spec", help="OpenAPI 3.x document: a file path or an http(s) URL.")
    source.add_argument("--workspace", type=Path, metavar="FILE",
                        help="Workspace exported from the app's Settings page: runs the checks and flows saved there, "
                             "including edited AI checks and flows you built.")
    run.add_argument("--api", metavar="NAME_OR_ID", help="With --workspace: the saved API to run, when it holds more than one.")
    run.add_argument("--target", help="Target API base URL. Defaults to the target saved in the workspace, then the contract's first server.")
    run.add_argument("--param", action="append", default=[], metavar="NAME=VALUE",
                     help="Value for every parameter with this name; use location:name=value to be specific. Repeatable.")
    run.add_argument("--header", action="append", default=[], metavar="'NAME: VALUE'",
                     help="Header sent with every check, for example a credential. Values are redacted in reports.")
    run.add_argument("--inputs", type=Path, help="JSON file of request inputs, keyed by \"METHOD /path\" or \"*\".")
    run.add_argument("--endpoint", action="append", default=[], metavar="PATTERN",
                     help="Only endpoints matching this pattern, for example 'GET /pet/*'. Repeatable.")
    run.add_argument("--smoke", action="store_true", help="Run only the valid-request check of each endpoint.")
    run.add_argument("--include-writes", action="store_true",
                     help="Also run POST, PUT, PATCH, and DELETE checks. They may create or delete real data.")
    run.add_argument("--allow-private-network", action="store_true",
                     help="Allow private-network targets such as Docker service names or 10.x addresses.")
    run.add_argument("--max-duration-ms", type=duration_ms, metavar="MS",
                     help="Fail a check whose response takes longer than this many milliseconds.")
    run.add_argument("--flows", action="store_true",
                     help="Also run the contract's lifecycle flows (create, read, update, delete). Needs --include-writes.")
    run.add_argument("--fail-on-skipped", action="store_true", help="Exit 1 when an endpoint is skipped for missing inputs.")
    run.add_argument("--junit", type=Path, metavar="FILE", help="Write a JUnit XML report.")
    run.add_argument("--json", type=Path, metavar="FILE", help="Write a JSON report.")

    diff = commands.add_parser("diff", help="Compare two versions of a contract and classify every change.")
    diff.add_argument("base", help="The earlier contract: a file path or an http(s) URL.")
    diff.add_argument("head", help="The new contract: a file path or an http(s) URL.")
    diff.add_argument("--markdown", metavar="FILE", help="Write a Markdown report, for example for a pull request comment; - writes it to standard output.")
    diff.add_argument("--json", type=Path, metavar="FILE", help="Write a JSON report.")
    diff.add_argument("--fail-on", choices=["breaking", "warning", "never"], default="breaking",
                      help="Exit 1 when a change is at least this severe (default: breaking).")

    lint = commands.add_parser("lint", help="Score how testable a contract is and list the fixes worth most.")
    lint.add_argument("spec", help="OpenAPI 3.x or Swagger 2.0 document: a file path or an http(s) URL.")
    lint.add_argument("--min-score", type=score_value, default=0, metavar="SCORE",
                      help="Exit 1 when the score is below this (0-100; default 0 never fails).")
    lint.add_argument("--markdown", metavar="FILE", help="Write a Markdown report; - writes it to standard output.")
    lint.add_argument("--json", type=Path, metavar="FILE", help="Write a JSON report.")
    return parser


def score_value(value: str) -> int:
    if not value.isdigit() or int(value) > 100:
        raise argparse.ArgumentTypeError(f"{value!r} must be a whole number from 0 to 100.")
    return int(value)


def duration_ms(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        number = 0
    if not 1 <= number <= 120_000:
        raise argparse.ArgumentTypeError(f"{value!r} must be a whole number of milliseconds from 1 to 120000.")
    return number


def load_contract(spec: str) -> ApiOverview:
    try:
        if spec.startswith(("http://", "https://")):
            contents = fetch_contract(spec)
        else:
            contents = Path(spec).read_bytes()
    except OSError as error:
        raise UsageError(f"The contract could not be read from {spec}: {error.strerror or error}.") from error
    except httpx.HTTPStatusError as error:
        raise UsageError(f"The contract could not be read from {spec}: HTTP {error.response.status_code}.") from error
    except httpx.HTTPError as error:
        raise UsageError(f"The contract could not be read: {request_error_reason(error, spec, CONTRACT_FETCH_SECONDS)}") from error
    if len(contents) > MAX_SPEC_SIZE_BYTES:
        raise UsageError("The contract must be smaller than 2 MB.")
    try:
        text = contents.decode("utf-8-sig")
        document = parse_document(text, as_json=text.lstrip().startswith("{"))
    except DocumentTooComplexError as error:
        raise UsageError(str(error)) from error
    except (UnicodeDecodeError, ValueError, yaml.YAMLError) as error:
        raise UsageError("The contract is not valid JSON or YAML.") from error
    try:
        return summarize_openapi(document)
    except OpenApiDocumentError as error:
        raise UsageError(str(error)) from error
    except (AttributeError, TypeError, KeyError, IndexError, ValueError, RecursionError) as error:
        raise UsageError(UNEXPECTED_SHAPE) from error


def load_workspace(path: Path, choice: str | None):
    try:
        if path.stat().st_size > MAX_WORKSPACE_SIZE_BYTES:
            raise UsageError("The workspace file must be smaller than 50 MB.")
        text = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise UsageError(f"The workspace could not be read from {path}: {error.strerror or error}.") from error
    except UnicodeDecodeError as error:
        raise UsageError("The workspace file is not valid JSON.") from error
    try:
        return load_workspace_api(text, choice)
    except WorkspaceFileError as error:
        raise UsageError(str(error)) from error


def fetch_contract(url: str) -> bytes:
    """Downloads a contract with an overall deadline, so a server that trickles bytes cannot hang a CI job."""
    deadline = time.monotonic() + CONTRACT_FETCH_SECONDS
    contents = bytearray()
    with httpx.Client(timeout=httpx.Timeout(CONTRACT_FETCH_SECONDS, connect=5), follow_redirects=True) as client:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                contents.extend(chunk)
                if len(contents) > MAX_SPEC_SIZE_BYTES:
                    break
                if time.monotonic() > deadline:
                    raise httpx.ReadTimeout(f"No complete response within {CONTRACT_FETCH_SECONDS} seconds.")
    return bytes(contents)


def validate_target(target: str | None) -> None:
    if target is None:
        return
    parsed = httpx.URL(target) if "://" in target else None
    if parsed is None or parsed.scheme not in {"http", "https"} or not parsed.host:
        raise UsageError(f"--target {target!r} must be an http:// or https:// URL, for example https://api.example.com/v1.")


def usable_target(target: str | None) -> str | None:
    """The target saved in the app, unless it is not a plain http(s) URL; then the contract's server applies."""
    try:
        validate_target(target)
    except UsageError:
        return None
    return target


def resolve_target(target: str | None, overview: ApiOverview, spec: str) -> str:
    if target:
        return target.rstrip("/")
    if not overview.servers:
        raise UsageError("The contract declares no server; pass --target.")
    server = overview.servers[0]
    if server.startswith(("http://", "https://")):
        return server.rstrip("/")
    if spec.startswith(("http://", "https://")):
        # A relative server such as /api/v3 is relative to where the contract was fetched.
        return urljoin(spec, server).rstrip("/")
    raise UsageError(f"The contract's server {server!r} is relative; pass --target.")


def parse_headers(values: list[str]) -> dict[str, str]:
    headers = {}
    for value in values:
        name, separator, content = value.partition(":")
        if not separator or not name.strip():
            raise UsageError(f"--header {value!r} must look like 'Name: value'.")
        headers[name.strip()] = content.strip()
    return headers


def inputs_for(operation_key: str, operation, params: list[str], inputs_file: dict[str, Any]) -> dict[str, str]:
    inputs: dict[str, str] = {}
    for section in ("*", operation_key):
        values = inputs_file.get(section, {})
        if not isinstance(values, dict):
            raise UsageError(f"Inputs for {section!r} must be a JSON object.")
        inputs.update({str(key): value if isinstance(value, str) else json.dumps(value) for key, value in values.items()})
    for param in params:
        key, separator, value = param.partition("=")
        if not separator:
            raise UsageError(f"--param {param!r} must look like name=value.")
        location, _, name = key.rpartition(":")
        for parameter in describe_operation(operation).parameters:
            if parameter.name == name and (not location or parameter.location == location):
                inputs[f"parameter:{parameter.location}:{parameter.name}"] = value
    return inputs


async def run_checks(args: argparse.Namespace) -> RunReport:
    # Arguments are checked before the contract is downloaded.
    validate_target(args.target)
    headers = parse_headers(args.header)
    if args.api and not args.workspace:
        raise UsageError("--api chooses a saved API from --workspace; it cannot be used with --spec.")
    if args.workspace:
        saved = load_workspace(args.workspace, args.api)
        overview, flows, unreadable_flows = saved.overview, saved.flows, saved.unreadable_flows
        target = resolve_target(args.target or usable_target(saved.target), overview, "")
    else:
        overview = load_contract(args.spec)
        flows, unreadable_flows = overview.flows, []
        target = resolve_target(args.target, overview, args.spec)
    try:
        inputs_file = json.loads(args.inputs.read_text(encoding="utf-8")) if args.inputs else {}
    except (OSError, ValueError) as error:
        raise UsageError(f"--inputs could not be read as JSON: {error}") from error

    report = RunReport(api=overview.title, api_version=overview.version, target=target, tool_version=APP_VERSION)
    keys = [f"{operation.method} {operation.path}" for operation in overview.operations]
    unmatched = [pattern for pattern in args.endpoint if not any(fnmatch.fnmatchcase(key, pattern) for key in keys)]
    if unmatched:
        raise UsageError(
            f"No endpoint matches {', '.join(repr(pattern) for pattern in unmatched)}. "
            "Patterns look like 'GET /pets' or 'GET /pets/*' and are case-sensitive."
        )
    for operation in overview.operations:
        key = f"{operation.method} {operation.path}"
        if args.endpoint and not any(fnmatch.fnmatchcase(key, pattern) for pattern in args.endpoint):
            continue
        checks = [scenario for scenario in operation.scenarios if scenario.request_example is not None]
        if args.smoke:
            checks = [scenario for scenario in checks if scenario.category == "happy_path"][:1]
        endpoint = EndpointOutcome(method=operation.method, path=operation.path)
        report.endpoints.append(endpoint)
        if not checks:
            endpoint.skipped_reason = "No runnable check in the contract."
            continue
        if operation.method not in SAFE_METHODS and not args.include_writes:
            endpoint.skipped_reason = "Changes data; pass --include-writes to run it."
            endpoint.skipped_checks = [scenario.title for scenario in checks]
            continue
        described = describe_operation(operation)
        inputs = inputs_for(key, operation, args.param, inputs_file)
        readiness = request_readiness(described, inputs)
        if not readiness.ready:
            endpoint.skipped_reason = f"Missing {', '.join(readiness.missing)}."
            endpoint.skipped_checks = [scenario.title for scenario in checks]
            continue
        for scenario in checks:
            payload = build_check_request(described, inputs, scenario, target, headers)
            payload["max_duration_ms"] = args.max_duration_ms
            try:
                result = await execute_scenario(
                    ScenarioExecutionRequest.model_validate(payload), allow_private_network=args.allow_private_network
                )
            except (HTTPException, ValidationError) as error:
                detail = error.detail if isinstance(error, HTTPException) else error.errors()[0]["msg"]
                raise UsageError(f"{key}: {detail}") from error
            endpoint.checks.append(CheckOutcome(title=scenario.title, category=scenario.category, result=result))
            print(f"  {result.result:<5} {key} · {scenario.title}", file=sys.stderr)
    if args.flows:
        for flow in flows:
            report.flows.append(await run_flow(flow, args, target, headers, inputs_file, credential_names(overview)))
        for title in unreadable_flows:
            report.flows.append(FlowOutcome(id=title, title=title, skipped_reason="Could not be read from the workspace file; open and save it in the app again."))
    return report


def flow_path_values(flow: ApiFlow, params: list[str], inputs_file: dict[str, Any]) -> dict[str, str]:
    """Values for path parameters a flow cannot derive, from --param (name= or path:name=) or --inputs."""
    values: dict[str, str] = {}
    for section in ("*", flow.steps[0].method + " " + flow.steps[0].path):
        section_inputs = inputs_file.get(section, {})
        if isinstance(section_inputs, dict):
            for name in flow.missing_inputs:
                value = section_inputs.get(f"parameter:path:{name}")
                if value is not None:
                    values[name] = value if isinstance(value, str) else json.dumps(value)
    for param in params:
        key, separator, value = param.partition("=")
        location, _, name = key.rpartition(":")
        if separator and name in flow.missing_inputs and location in {"", "path"}:
            values[name] = value
    return values


def credential_names(overview: ApiOverview) -> list[str]:
    """Query and header parameters the contract marks as credentials, masked in the evidence."""
    return secret_parameter_names(parameter for operation in overview.operations for parameter in operation.parameters)


async def run_flow(
    flow: ApiFlow, args: argparse.Namespace, target: str, headers: dict[str, str], inputs_file: dict[str, Any], secret_names: list[str]
) -> FlowOutcome:
    titles = [step.title for step in flow.steps]
    if not args.include_writes:
        return FlowOutcome(id=flow.id, title=flow.title, skipped_reason="Creates and deletes data; pass --include-writes to run it.", skipped_steps=titles)
    values = flow_path_values(flow, args.param, inputs_file)
    missing = [name for name in flow.missing_inputs if not values.get(name, "").strip()]
    if missing:
        return FlowOutcome(id=flow.id, title=flow.title, skipped_reason=f"Missing {', '.join(missing)} (path); pass --param.", skipped_steps=titles)
    steps = [
        step.model_copy(update={"path": UNFILLED_PATH_PARAMETER.sub(lambda match: quote(values[match.group(1)].strip(), safe=""), step.path)})
        for step in flow.steps
    ]
    try:
        payload = FlowExecutionRequest(
            base_url=target, headers=headers, max_duration_ms=args.max_duration_ms, secret_names=secret_names, steps=steps
        )
        result = await execute_flow(payload, allow_private_network=args.allow_private_network)
    except (HTTPException, ValidationError) as error:
        detail = error.detail if isinstance(error, HTTPException) else error.errors()[0]["msg"]
        raise UsageError(f"Flow {flow.title!r}: {detail}") from error
    for step in result.steps:
        print(f"  {step.status:<5} Flow: {flow.title} · {step.title}", file=sys.stderr)
    return FlowOutcome(id=flow.id, title=flow.title, result=result)


def report_write_problem(error: OSError) -> str:
    where = f" to {error.filename}" if error.filename else ""
    return f"the report could not be written{where}: {(error.strerror or str(error)).lower()}. Check that the folder exists and can be written to."


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def print_summary(report: RunReport) -> None:
    totals = report.totals
    print(
        f"\n{report.api} {report.api_version} → {report.target}\n"
        f"{plural(totals['checks'], 'check')}: {totals['passed']} passed, {totals['failed']} failed, "
        f"{plural(totals['errors'], 'error')}; {plural(totals['skipped_endpoints'], 'endpoint')} skipped",
        file=sys.stderr,
    )
    for endpoint in report.endpoints:
        if endpoint.skipped_reason and endpoint.skipped_checks:
            print(f"  SKIP  {endpoint.key}: {endpoint.skipped_reason}", file=sys.stderr)
    if report.flows:
        print(
            f"{plural(totals['flows'], 'flow')}: {totals['flows_passed']} passed, {totals['flows_failed']} failed, "
            f"{totals['flows_skipped']} skipped",
            file=sys.stderr,
        )
        for flow in report.flows:
            if flow.skipped_reason:
                print(f"  SKIP  Flow: {flow.title}: {flow.skipped_reason}", file=sys.stderr)


def redact_secrets(text: str, secrets: list[str]) -> str:
    """Hides --header values wherever they appear, even where the API echoed them back."""
    return hide_secret_values(text, secrets)


def compare_contracts(args: argparse.Namespace) -> int:
    try:
        base, head = load_contract(args.base), load_contract(args.head)
    except UsageError as error:
        print(f"api-qa: {error}", file=sys.stderr)
        return EXIT_USAGE
    diff = diff_contracts(base, head)
    totals = diff.totals
    print(
        f"{diff.base_title} {diff.base_version} → {diff.head_title} {diff.head_version}: "
        f"{totals['breaking']} breaking, {totals['warning']} warning, {totals['safe']} safe "
        f"across {plural(totals['endpoints'], 'endpoint')}",
        file=sys.stderr,
    )
    for endpoint in diff.endpoints:
        for change in endpoint.changes:
            if change.severity != "safe":
                print(f"  {change.severity.upper():<8} {endpoint.key} · {change.location}: {change.message}", file=sys.stderr)
    try:
        if args.markdown == "-":
            sys.stdout.write(diff_markdown(diff))
        elif args.markdown:
            Path(args.markdown).write_text(diff_markdown(diff), encoding="utf-8")
        if args.json:
            args.json.write_text(diff.model_dump_json(indent=2), encoding="utf-8")
    except OSError as error:
        print(f"api-qa: {report_write_problem(error)}", file=sys.stderr)
        return EXIT_USAGE
    if args.fail_on == "never" or diff.severity is None:
        return EXIT_OK
    return EXIT_FAILED if SEVERITY_ORDER[diff.severity] <= SEVERITY_ORDER[args.fail_on] else EXIT_OK


def lint_contract(args: argparse.Namespace) -> int:
    try:
        overview = load_contract(args.spec)
    except UsageError as error:
        print(f"api-qa: {error}", file=sys.stderr)
        return EXIT_USAGE
    report = overview.quality
    print(f"{overview.title} {overview.version}: contract quality {report.score} / 100 ({report.grade})", file=sys.stderr)
    for fix in report.top_fixes:
        where = f" ({plural(fix.endpoints, 'endpoint')})" if fix.endpoints else ""
        print(f"  +{fix.points:<3} {fix.advice}{where}", file=sys.stderr)
    try:
        if args.markdown == "-":
            sys.stdout.write(report.markdown)
        elif args.markdown:
            Path(args.markdown).write_text(report.markdown, encoding="utf-8")
        if args.json:
            args.json.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    except OSError as error:
        print(f"api-qa: {report_write_problem(error)}", file=sys.stderr)
        return EXIT_USAGE
    if report.score < args.min_score:
        print(f"api-qa: the score {report.score} is below --min-score {args.min_score}.", file=sys.stderr)
        return EXIT_FAILED
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "diff":
        return compare_contracts(args)
    if args.command == "lint":
        return lint_contract(args)
    try:
        report = asyncio.run(run_checks(args))
    except UsageError as error:
        print(f"api-qa: {error}", file=sys.stderr)
        return EXIT_USAGE
    print_summary(report)
    try:
        secrets = [value for value in parse_headers(args.header).values() if len(value) >= 4]
        if args.junit:
            args.junit.write_text(redact_secrets(junit_xml(report), secrets), encoding="utf-8")
        if args.json:
            args.json.write_text(redact_secrets(report.model_dump_json(indent=2), secrets), encoding="utf-8")
    except OSError as error:
        print(f"api-qa: {report_write_problem(error)}", file=sys.stderr)
        return EXIT_USAGE
    totals = report.totals
    failed = totals["failed"] + totals["errors"] + totals["flows_failed"] > 0
    skipped = args.fail_on_skipped and (
        any(endpoint.skipped_checks for endpoint in report.endpoints) or totals["flows_skipped"] > 0
    )
    return EXIT_FAILED if failed or skipped else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
