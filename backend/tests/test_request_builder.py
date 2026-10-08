import pytest

from app.domain.openapi import (
    ApiBodyField,
    ApiOperation,
    ApiParameter,
    QaScenario,
    ScenarioRequestExample,
)
from app.domain.request_builder import build_check_request, describe_operation, request_readiness


def scenario(title, category, json_body=None, **example):
    return QaScenario(
        category=category,
        title=title,
        rationale="",
        request_example=ScenarioRequestExample(method="POST", path="/pets/{id}", json_body=json_body, **example),
    )


VALID = scenario("Valid request", "happy_path", {"name": "Rex", "age": 2}, expected_status_codes=[201])
INVALID_AGE = scenario("Send invalid age", "invalid_value", {"name": "Rex", "age": -1}, expected_status_codes=[422])
UNAUTHENTICATED = scenario(
    "Call without authentication", "security_minded", {"name": "Rex", "age": 2},
    omitted_parameters=[{"name": "Authorization", "location": "header"}], expected_status_codes=[401, 403],
)
OPERATION = ApiOperation(
    method="POST",
    path="/pets/{id}",
    request_body_content_type="application/json",
    request_body_required=True,
    parameters=[
        ApiParameter(name="limit", location="query", example=10),
        ApiParameter(name="Authorization", location="header", credential=True),
        ApiParameter(name="session", location="cookie"),
    ],
    request_body_fields=[ApiBodyField(name="name", required=True), ApiBodyField(name="age", field_type="integer")],
    response_schemas={"201": {"type": "object"}},
    scenarios=[VALID, INVALID_AGE, UNAUTHENTICATED],
)
DESCRIBED = describe_operation(OPERATION)
INPUTS = {
    "parameter:path:id": "p 1",
    "parameter:header:Authorization": "Bearer t",
    "parameter:cookie:session": "a b",
    "body:name": "Max",
    "body:age": "3",
}


def test_undocumented_path_parameters_are_required_inputs():
    assert DESCRIBED.parameters[-1].name == "id"
    assert DESCRIBED.valid_body_template == {"name": "Rex", "age": 2}


@pytest.mark.parametrize(
    ("inputs", "missing"),
    [
        ({}, ["id (path)", "name (body)"]),
        ({"parameter:path:id": "p1", "body:name": " "}, ["name (body)"]),
        ({"parameter:path:id": "p1", "body:name": "Rex"}, []),
    ],
)
def test_readiness_names_each_missing_input(inputs, missing):
    readiness = request_readiness(DESCRIBED, inputs)
    assert (readiness.ready, readiness.missing) == (not missing, missing)


def test_request_matches_the_web_app():
    assert build_check_request(DESCRIBED, INPUTS, VALID, "http://api.test") == {
        "base_url": "http://api.test",
        "method": "POST",
        "path": "/pets/p%201",
        "query_params": {"limit": "10"},
        "headers": {"Authorization": "Bearer t", "Cookie": "session=a%20b"},
        "form_body": False,
        "form_fields": {},
        "json_body": {"name": "Max", "age": 3},
        "expected_status_codes": [201],
        "response_schemas": {"201": {"type": "object"}},
    }


def test_deliberate_test_values_stay():
    assert build_check_request(DESCRIBED, INPUTS, INVALID_AGE, "http://api.test")["json_body"] == {"name": "Max", "age": -1}


def test_extra_headers_never_reach_a_check_that_omits_them():
    inputs = {"parameter:path:id": "1", "body:name": "Rex"}
    extra = {"authorization": "Bearer secret"}

    assert build_check_request(DESCRIBED, inputs, VALID, "http://api.test", extra)["headers"] == extra
    assert build_check_request(DESCRIBED, inputs, UNAUTHENTICATED, "http://api.test", extra)["headers"] == {}
