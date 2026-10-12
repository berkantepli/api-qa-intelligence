import copy
import json

import pytest

from app.cli import main
from app.domain.openapi import summarize_openapi
from app.domain.spec_quality import grade

PET = {"type": "object", "properties": {"name": {"type": "string", "maxLength": 20, "description": "Pet name", "example": "Rex"}}, "required": ["name"]}
GOOD = {
    "openapi": "3.0.3",
    "info": {"title": "Pets", "version": "1.0"},
    "servers": [{"url": "https://api.example.com"}],
    "components": {"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "X-Key"}}},
    "paths": {
        "/pets": {
            "post": {
                "operationId": "createPet",
                "summary": "Create a pet",
                "security": [{"key": []}],
                "requestBody": {"required": True, "content": {"application/json": {"schema": PET}}},
                "responses": {
                    "201": {"content": {"application/json": {"schema": PET}}},
                    "401": {"description": "no key"},
                    "422": {"description": "invalid"},
                },
            },
        },
        "/pets/{petId}": {
            "delete": {
                "operationId": "deletePet",
                "summary": "Delete a pet",
                "parameters": [{"name": "petId", "in": "path", "required": True, "description": "Pet id", "schema": {"type": "integer", "minimum": 1, "example": 7}}],
                "responses": {"204": {"description": "deleted"}, "404": {"description": "missing"}},
            },
        },
    },
}


def report(document):
    return summarize_openapi(document).quality


def rule(quality, rule_id):
    return next(item for item in quality.rules if item.id == rule_id)


def test_a_well_described_contract_scores_100():
    quality = report(GOOD)

    assert (quality.score, quality.grade) == (100, "A")
    assert quality.findings == [] and quality.top_fixes == []
    assert "## Contract quality: 100 / 100 (A)" in quality.markdown


def test_each_rule_reports_what_is_missing():
    bad = copy.deepcopy(GOOD)
    bad["servers"] = []
    post = bad["paths"]["/pets"]["post"]
    post["responses"] = {"201": {"description": "created"}}
    post["operationId"] = "deletePet"
    del post["summary"]
    schema = post["requestBody"]["content"]["application/json"]["schema"] = copy.deepcopy(PET)
    schema["properties"]["name"] = {"type": "string"}
    delete = bad["paths"]["/pets/{petId}"]["delete"]
    delete["parameters"][0] = {"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}
    delete["responses"] = {"204": {"description": "deleted"}}

    quality = report(bad)
    findings = {(finding.rule, finding.method): finding.message for finding in quality.findings}

    assert findings == {
        ("success-schema", "POST"): "Response 201 has no JSON schema, so its body cannot be checked.",
        ("input-examples", "POST"): "No example, default, or enum for name (body).",
        ("input-examples", "DELETE"): "No example, default, or enum for petId (path).",
        ("error-responses", "POST"): "No 4xx response is documented, so negative checks guess 400 or 422.",
        ("error-responses", "DELETE"): "No 4xx response is documented, so negative checks guess 400 or 422.",
        ("input-limits", "POST"): "No limits (format, pattern, enum, length, or range) for name (body).",
        ("input-limits", "DELETE"): "No limits (format, pattern, enum, length, or range) for petId (path).",
        ("auth-errors", "POST"): "Secured, but neither 401 nor 403 is documented.",
        ("not-found", "DELETE"): "Takes a record id in the path, but 404 is not documented.",
        ("operation-id", "POST"): "operationId 'deletePet' is used by another endpoint too.",
        ("operation-id", "DELETE"): "operationId 'deletePet' is used by another endpoint too.",
        ("summary", "POST"): "No summary.",
        ("input-descriptions", "POST"): "No description for name (body).",
        ("input-descriptions", "DELETE"): "No description for petId (path).",
        ("server", None): "The contract declares no server, so every run needs a target URL typed in.",
    }
    # The rules that still apply and pass: a valid request can be built for both endpoints.
    assert rule(quality, "valid-request").score == 100
    # Only the valid-request rule (weight 2) and partial input credit remain.
    assert (quality.score, quality.grade) == (22, "F")


def test_rules_that_do_not_apply_are_left_out_of_the_score():
    quality = report({
        "openapi": "3.0.3", "info": {"title": "Ping", "version": "1"}, "servers": [{"url": "https://x"}],
        "paths": {"/ping": {"get": {"operationId": "ping", "summary": "Ping", "responses": {"204": {}, "400": {}}}}},
    })

    # No inputs, no credentials, and no record id: those rules do not apply.
    assert [item.id for item in quality.rules if item.applicable == 0] == ["input-examples", "input-limits", "auth-errors", "not-found", "input-descriptions"]
    assert quality.score == 100


def test_partial_credit_and_fixes_are_ordered_by_points():
    partial = copy.deepcopy(GOOD)
    parameters = partial["paths"]["/pets/{petId}"]["delete"]["parameters"]
    parameters.append({"name": "reason", "in": "query", "required": True, "schema": {"type": "string"}})

    quality = report(partial)

    # One of two required inputs on DELETE has an example: half credit there, full on POST.
    assert rule(quality, "input-examples").score == 75
    assert [fix.rule for fix in quality.top_fixes] == ["input-examples", "input-descriptions", "input-limits"]
    assert quality.top_fixes[0].advice == "Add examples for required inputs"
    assert quality.top_fixes[0].endpoints == 1


@pytest.mark.parametrize(("score", "letter"), [(100, "A"), (90, "A"), (89, "B"), (75, "B"), (60, "C"), (40, "D"), (39, "F"), (0, "F")])
def test_grades(score, letter):
    assert grade(score) == letter


def test_quality_route_scores_a_saved_overview(client):
    overview = summarize_openapi(GOOD).model_dump()
    overview.pop("quality")

    response = client.post("/api/v1/specs/quality", json=overview)

    assert response.status_code == 200
    assert response.json()["score"] == 100


def test_cli_lint_fails_below_the_minimum_score(tmp_path, capsys):
    bad = copy.deepcopy(GOOD)
    bad["servers"] = []
    path = tmp_path / "openapi.json"
    path.write_text(json.dumps(bad))

    assert main(["lint", str(path), "--json", str(tmp_path / "q.json"), "--markdown", "-"]) == 0
    out = capsys.readouterr()
    # Weights add up to 18; a missing server (weight 2) costs 11 points.
    assert "contract quality 89 / 100 (B)" in out.err
    assert "+11  Declare a server URL" in out.err
    assert "### Fixes worth most" in out.out
    assert json.loads((tmp_path / "q.json").read_text())["score"] == 89
    assert main(["lint", str(path), "--min-score", "90"]) == 1
    assert main(["lint", str(tmp_path / "missing.json")]) == 2
