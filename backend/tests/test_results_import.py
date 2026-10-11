import json

import pytest

from app.domain.results_import import ResultsFileError, parse_results_file

NEWMAN = {
    "collection": {"info": {"name": "Pets collection"}},
    "run": {
        "timings": {"started": 1760180400000},
        "executions": [
            {
                "item": {"name": "List pets"},
                "request": {"method": "GET", "url": {"raw": "{{baseUrl}}/api/v3/pets?limit=2", "path": ["api", "v3", "pets"]}},
                "response": {"code": 200, "responseTime": 41},
                "assertions": [{"assertion": "Status code is 200"}],
            },
            {
                "item": {"name": "Get a missing pet"},
                "request": {"method": "get", "url": {"raw": "{{baseUrl}}/pets/999"}},
                "response": {"code": 500, "responseTime": 12},
                "assertions": [{"assertion": "Status code is 404", "error": {"message": "expected 500 to equal 404, token=abc123"}}],
            },
            {
                "item": {"name": "Create pet"},
                "request": {"method": "POST", "url": "http://localhost:3000/pets"},
                "requestError": {"message": "connect ECONNREFUSED 127.0.0.1:3000"},
            },
        ],
    },
}


def parse(document):
    return parse_results_file(document.encode() if isinstance(document, str) else json.dumps(document).encode())


def test_reads_newman_requests_outcomes_and_statuses():
    results = parse(NEWMAN)

    assert (results.tool, results.name, results.generated_at) == ("newman", "Pets collection", "2025-10-11T11:00:00+00:00")
    assert [(case.title, case.method, case.path, case.response_status, case.result) for case in results.cases] == [
        ("List pets", "GET", "/api/v3/pets", 200, "PASS"),
        ("Get a missing pet", "GET", "/pets/999", 500, "FAIL"),
        ("Create pet", "POST", "/pets", None, "ERROR"),
    ]
    assert results.cases[1].message == 'Status code is 404: expected 500 to equal 404, token="[REDACTED]"'
    assert results.cases[2].message == "connect ECONNREFUSED 127.0.0.1:3000"


def test_reads_junit_and_finds_request_lines_in_names():
    xml = """<?xml version="1.0"?>
    <testsuites name="API tests">
      <testsuite name="GET /pets/{id}" timestamp="2026-10-12T09:00:00">
        <testcase classname="GET /pets/{id}" name="Valid request" time="0.120"/>
        <testcase classname="GET /pets/{id}" name="Unknown id" time="0.050"><failure message="Expected HTTP 404, received HTTP 200."/></testcase>
        <testcase classname="GET /pets/{id}" name="Skipped one"><skipped/></testcase>
      </testsuite>
      <testsuite name="UserTests">
        <testcase classname="com.example.UserTests" name="creates a user via POST /users" time="1"><error message="boom"/></testcase>
        <testcase classname="com.example.UserTests" name="has no request line"/>
      </testsuite>
    </testsuites>"""
    results = parse(xml)

    assert (results.tool, results.name, results.generated_at) == ("junit", "API tests", "2026-10-12T09:00:00")
    assert [(case.title, case.method, case.path, case.result, case.duration_ms) for case in results.cases] == [
        ("Valid request", "GET", "/pets/{id}", "PASS", 120),
        ("Unknown id", "GET", "/pets/{id}", "FAIL", 50),
        ("Skipped one", "GET", "/pets/{id}", "SKIPPED", 0),
        ("creates a user via POST /users", "POST", "/users", "ERROR", 1000),
        ("has no request line", None, None, "PASS", 0),
    ]
    assert results.cases[1].message == "Expected HTTP 404, received HTTP 200."


def test_same_file_gives_the_same_fingerprint():
    assert parse(NEWMAN).fingerprint == parse(NEWMAN).fingerprint
    assert parse(NEWMAN).fingerprint != parse({**NEWMAN, "collection": {}}).fingerprint


@pytest.mark.parametrize(
    ("contents", "message"),
    [
        ('<!DOCTYPE x [<!ENTITY a "aaaa">]><testsuite><testcase name="&a;"/></testsuite>', "DOCTYPE"),
        ("<html><body>not junit</body></html>", "not a JUnit report"),
        ("<testsuite><testcase", "could not be read"),
        ('{"api": "Pets", "endpoints": []}', "not a Newman report"),
        ("not a report", "neither JSON nor XML"),
    ],
)
def test_refuses_other_files(contents, message):
    with pytest.raises(ResultsFileError, match=message):
        parse(contents)


def test_parse_endpoint(client):
    response = client.post("/api/v1/results/parse", files={"file": ("newman.json", json.dumps(NEWMAN), "application/json")})
    assert response.status_code == 200
    assert response.json()["cases"][0]["path"] == "/api/v3/pets"

    refused = client.post("/api/v1/results/parse", files={"file": ("x.txt", "nope", "text/plain")})
    assert refused.status_code == 422
