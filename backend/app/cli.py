"""Command-line runner for CI pipelines: ``api-qa run --spec openapi.json --junit report.xml``.

It runs an OpenAPI contract's runnable checks against a target API without the web app and
exits with 0 when every check passes, 1 when a check fails or errors, and 2 on a usage or
contract error. AI features are never used, so results are repeatable.
"""

import argparse
import asyncio
import fnmatch
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
import yaml
from fastapi import HTTPException
from pydantic import ValidationError

from app.domain.execution import ScenarioExecutionRequest, execute_scenario
from app.domain.openapi import ApiOverview, OpenApiDocumentError, summarize_openapi
from app.domain.reports import CheckOutcome, EndpointOutcome, RunReport, junit_xml
from app.domain.request_builder import (
    SAFE_METHODS,
    build_check_request,
    describe_operation,
    request_readiness,
)
from app.version import APP_VERSION

MAX_SPEC_SIZE_BYTES = 2_000_000
EXIT_OK, EXIT_FAILED, EXIT_USAGE = 0, 1, 2


class UsageError(Exception):
    """A problem with the command line or the contract; reported with exit code 2."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="api-qa", description="Run an OpenAPI contract's QA checks against an API.")
    parser.add_argument("--version", action="version", version=f"api-qa {APP_VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run the runnable checks and write reports.")
    run.add_argument("--spec", required=True, help="OpenAPI 3.x document: a file path or an http(s) URL.")
    run.add_argument("--target", help="Target API base URL. Defaults to the contract's first server.")
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
    run.add_argument("--fail-on-skipped", action="store_true", help="Exit 1 when an endpoint is skipped for missing inputs.")
    run.add_argument("--junit", type=Path, metavar="FILE", help="Write a JUnit XML report.")
    run.add_argument("--json", type=Path, metavar="FILE", help="Write a JSON report.")
    return parser


def load_contract(spec: str) -> ApiOverview:
    try:
        if spec.startswith(("http://", "https://")):
            with httpx.Client(timeout=httpx.Timeout(15, connect=5), follow_redirects=True) as client:
                response = client.get(spec)
                response.raise_for_status()
                contents = response.content
        else:
            contents = Path(spec).read_bytes()
    except (OSError, httpx.HTTPError) as error:
        raise UsageError(f"The contract could not be read from {spec}: {error}") from error
    if len(contents) > MAX_SPEC_SIZE_BYTES:
        raise UsageError("The contract must be smaller than 2 MB.")
    try:
        text = contents.decode("utf-8-sig")
        document = json.loads(text) if text.lstrip().startswith("{") else yaml.safe_load(text)
        return summarize_openapi(document)
    except (UnicodeDecodeError, ValueError, yaml.YAMLError) as error:
        message = str(error) if isinstance(error, OpenApiDocumentError) else "The contract is not valid JSON or YAML."
        raise UsageError(message) from error


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
    overview = load_contract(args.spec)
    target = resolve_target(args.target, overview, args.spec)
    headers = parse_headers(args.header)
    try:
        inputs_file = json.loads(args.inputs.read_text(encoding="utf-8")) if args.inputs else {}
    except (OSError, ValueError) as error:
        raise UsageError(f"--inputs could not be read as JSON: {error}") from error

    report = RunReport(api=overview.title, api_version=overview.version, target=target, tool_version=APP_VERSION)
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
            try:
                result = await execute_scenario(
                    ScenarioExecutionRequest.model_validate(payload), allow_private_network=args.allow_private_network
                )
            except (HTTPException, ValidationError) as error:
                detail = error.detail if isinstance(error, HTTPException) else error.errors()[0]["msg"]
                raise UsageError(f"{key}: {detail}") from error
            endpoint.checks.append(CheckOutcome(title=scenario.title, category=scenario.category, result=result))
            print(f"  {result.result:<5} {key} · {scenario.title}", file=sys.stderr)
    return report


def print_summary(report: RunReport) -> None:
    totals = report.totals
    print(
        f"\n{report.api} {report.api_version} → {report.target}\n"
        f"{totals['checks']} checks: {totals['passed']} passed, {totals['failed']} failed, {totals['errors']} errors; "
        f"{totals['skipped_endpoints']} endpoints skipped",
        file=sys.stderr,
    )
    for endpoint in report.endpoints:
        if endpoint.skipped_reason and endpoint.skipped_checks:
            print(f"  SKIP  {endpoint.key}: {endpoint.skipped_reason}", file=sys.stderr)


def redact_secrets(text: str, secrets: list[str]) -> str:
    """Hides --header values wherever they appear, even where the API echoed them back."""
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    return text


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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
        print(f"api-qa: the report could not be written: {error}", file=sys.stderr)
        return EXIT_USAGE
    totals = report.totals
    failed = totals["failed"] + totals["errors"] > 0
    skipped = args.fail_on_skipped and any(endpoint.skipped_checks for endpoint in report.endpoints)
    return EXIT_FAILED if failed or skipped else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
