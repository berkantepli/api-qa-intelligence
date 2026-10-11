"""Reads test results from other tools (a Newman JSON report or JUnit XML) into one list of cases.

Each case keeps what the report says about the request, so the web app can match it to an endpoint:
Newman records the method, URL, and response status of every request; JUnit has no request fields,
so a case is matched only when its suite, class, or test name contains a request line such as
"GET /pets/{id}". Failure messages are redacted like other evidence.
"""

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit
from xml.etree import ElementTree

from pydantic import BaseModel

from app.domain.documents import DocumentTooComplexError, check_document_size
from app.domain.evidence import redact_text

MAX_MESSAGE_CHARS = 1_000
REQUEST_LINE = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/[^\s\"'<>|,;]*)", re.IGNORECASE)
# Unresolved Postman variables such as {{baseUrl}} are not part of the API path.
POSTMAN_VARIABLE = re.compile(r"^\{\{[^{}]*\}\}$")


class ResultsFileError(ValueError):
    pass


class ImportedCase(BaseModel):
    title: str
    suite: str = ""
    method: str | None = None
    path: str | None = None
    response_status: int | None = None
    result: Literal["PASS", "FAIL", "ERROR", "SKIPPED"]
    message: str | None = None
    duration_ms: int = 0


class ImportedResults(BaseModel):
    tool: Literal["newman", "junit"]
    name: str
    generated_at: str | None = None
    # Identifies the file, so importing the same report twice adds nothing.
    fingerprint: str
    cases: list[ImportedCase]


def parse_results_file(contents: bytes) -> ImportedResults:
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ResultsFileError("The file must be UTF-8 text: a Newman JSON report or JUnit XML.") from error
    fingerprint = hashlib.sha256(contents).hexdigest()[:16]
    if text.lstrip().startswith("<"):
        return _parse_junit(text, fingerprint)
    try:
        document = json.loads(text)
        check_document_size(document)
    except (json.JSONDecodeError, RecursionError, DocumentTooComplexError) as error:
        raise ResultsFileError("The file is neither JSON nor XML. Choose a Newman JSON report or a JUnit XML file.") from error
    if isinstance(document, dict) and isinstance(document.get("run"), dict) and isinstance(document["run"].get("executions"), list):
        return _parse_newman(document, fingerprint)
    raise ResultsFileError("This JSON file is not a Newman report. Run Newman with --reporters json and choose that file.")


def _message(text: Any) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    return redact_text(text.strip())[:MAX_MESSAGE_CHARS]


def _newman_path(url: Any) -> str | None:
    if isinstance(url, dict):
        segments = url.get("path")
        if isinstance(segments, list):
            parts = [str(segment) for segment in segments if not POSTMAN_VARIABLE.match(str(segment))]
            return "/" + "/".join(part.strip("/") for part in parts if part.strip("/"))
        url = url.get("raw")
    if not isinstance(url, str):
        return None
    # A raw URL may start with a variable instead of a scheme and host: {{baseUrl}}/pets/1.
    raw = re.sub(r"^\{\{[^{}]*\}\}", "", url.strip())
    path = urlsplit(raw if "://" in raw else f"http://host{raw if raw.startswith('/') else '/' + raw}").path
    return path or "/"


def _parse_newman(document: dict[str, Any], fingerprint: str) -> ImportedResults:
    run = document["run"]
    collection = document.get("collection") if isinstance(document.get("collection"), dict) else {}
    name = (collection.get("info") or {}).get("name") if isinstance(collection.get("info"), dict) else None
    started = (run.get("timings") or {}).get("started") if isinstance(run.get("timings"), dict) else None
    cases = []
    for execution in run["executions"]:
        if not isinstance(execution, dict):
            continue
        item = execution.get("item") if isinstance(execution.get("item"), dict) else {}
        request = execution.get("request") if isinstance(execution.get("request"), dict) else {}
        response = execution.get("response") if isinstance(execution.get("response"), dict) else None
        assertions = [entry for entry in execution.get("assertions") or [] if isinstance(entry, dict)]
        failed = [entry for entry in assertions if entry.get("error")]
        request_error = execution.get("requestError")
        status = response.get("code") if response else None
        if request_error or response is None:
            result, message = "ERROR", _message((request_error or {}).get("message") if isinstance(request_error, dict) else "No response was received.")
        elif failed:
            errors = [entry["error"] for entry in failed if isinstance(entry["error"], dict)]
            text = "; ".join(f"{entry.get('assertion', 'Assertion')}: {error.get('message', '')}".strip() for entry, error in zip(failed, errors, strict=False))
            result, message = "FAIL", _message(text or "An assertion failed.")
        else:
            result, message = "PASS", None
        method = request.get("method")
        cases.append(ImportedCase(
            title=str(item.get("name") or f"{method or 'Request'} {_newman_path(request.get('url')) or ''}".strip()),
            method=method.upper() if isinstance(method, str) else None,
            path=_newman_path(request.get("url")),
            response_status=status if isinstance(status, int) else None,
            result=result,
            message=message,
            duration_ms=int(response.get("responseTime") or 0) if response else 0,
        ))
    generated_at = datetime.fromtimestamp(started / 1000, UTC).isoformat() if isinstance(started, int | float) else None
    return ImportedResults(tool="newman", name=str(name or "Newman run"), generated_at=generated_at, fingerprint=fingerprint, cases=cases)


def _parse_junit(text: str, fingerprint: str) -> ImportedResults:
    # Test reports never need a DTD; refusing one rules out entity expansion and external entities.
    if re.search(r"<!(DOCTYPE|ENTITY)", text, re.IGNORECASE):
        raise ResultsFileError("JUnit XML with a DOCTYPE or entities is not accepted.")
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise ResultsFileError(f"The XML could not be read: {error}.") from error
    if root.tag not in {"testsuites", "testsuite"}:
        raise ResultsFileError("This XML file is not a JUnit report (no <testsuites> or <testsuite> element).")
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    cases = []
    for suite in suites:
        suite_name = suite.get("name", "")
        for case in suite.findall("testcase"):
            name, classname = case.get("name", ""), case.get("classname", "")
            match = next((found for found in (REQUEST_LINE.search(value) for value in (classname, name, suite_name)) if found), None)
            failure, error, skipped = case.find("failure"), case.find("error"), case.find("skipped")
            outcome = "ERROR" if error is not None else "FAIL" if failure is not None else "SKIPPED" if skipped is not None else "PASS"
            problem = error if error is not None else failure
            try:
                seconds = float(case.get("time") or 0)
            except ValueError:
                seconds = 0
            cases.append(ImportedCase(
                title=name or classname or "Test case",
                suite=suite_name or classname,
                method=match.group(1).upper() if match else None,
                path=match.group(2) if match else None,
                result=outcome,
                message=_message(problem.get("message") or problem.text) if problem is not None else None,
                duration_ms=round(seconds * 1000),
            ))
    timestamp = next((suite.get("timestamp") for suite in suites if suite.get("timestamp")), None)
    name = root.get("name") or (suites[0].get("name") if suites else None) or "JUnit report"
    return ImportedResults(tool="junit", name=name, generated_at=timestamp, fingerprint=fingerprint, cases=cases)
