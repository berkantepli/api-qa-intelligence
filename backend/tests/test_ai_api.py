import json

import httpx


def ollama_reply(content):
    return lambda request: httpx.Response(200, json={"message": {"content": json.dumps(content)}})


def sent_prompt(request: httpx.Request) -> str:
    return json.loads(request.content)["messages"][1]["content"]


ANALYSIS = {
    "summary": "The API returned 500.",
    "likely_causes": [{"cause": "Server error", "evidence": "HTTP 500", "confidence": "medium"}],
    "next_steps": ["Check server logs"],
    "limitations": "Based on one response.",
}

FAILED_CHECK = {
    "result": "FAIL",
    "method": "post",
    "path": "/login",
    "expected_status_codes": [200],
    "response_status": 500,
    "request_url": "http://127.0.0.1:8000/login?token=url-secret",
    "request_headers": {"Authorization": "Bearer header-secret"},
    "request_body": '{"password": "body-secret"}',
    "response_body": "error api_key=response-secret",
}


def test_failure_analysis_returns_model_output_with_redacted_evidence(client, mock_http):
    mock_http.respond_with(ollama_reply(ANALYSIS))

    response = client.post("/api/v1/runs/analyze-failure", json=FAILED_CHECK)

    assert response.status_code == 200
    assert response.json() == ANALYSIS
    prompt = sent_prompt(mock_http.requests[0])
    for secret in ("url-secret", "header-secret", "body-secret", "response-secret"):
        assert secret not in prompt
    assert '"method": "POST"' in prompt


def test_failure_analysis_is_only_for_failed_checks(client, mock_http):
    response = client.post("/api/v1/runs/analyze-failure", json={**FAILED_CHECK, "result": "PASS"})

    assert response.status_code == 422
    assert mock_http.requests == []


def test_invalid_model_output_reports_unavailable(client, mock_http):
    mock_http.respond_with(ollama_reply({"summary": "missing fields"}))

    response = client.post("/api/v1/runs/analyze-failure", json=FAILED_CHECK)

    assert response.status_code == 503


def test_unreachable_model_reports_unavailable(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    response = client.post("/api/v1/specs/scenario-ideas", json={"operation": {"method": "GET", "path": "/x"}})

    assert response.status_code == 503


def test_scenario_ideas_are_review_only_and_exclude_example_values(client, mock_http):
    mock_http.respond_with(ollama_reply({"scenarios": [{"category": "negative", "title": "Empty owner", "rationale": "r"}]}))
    operation = {
        "method": "GET",
        "path": "/pets",
        "parameters": [{"name": "owner", "location": "query", "required": True, "example": "example-secret"}],
        "request_body_fields": [{"name": "note", "example": "body-example-secret"}],
    }

    response = client.post("/api/v1/specs/scenario-ideas", json={"operation": operation})

    assert response.status_code == 200
    assert response.json()["scenarios"] == [
        {
            "category": "negative",
            "title": "Empty owner",
            "rationale": "r",
            "review_required": True,
            "source": "ai",
            "request_example": None,
        }
    ]
    prompt = sent_prompt(mock_http.requests[0])
    assert "owner" in prompt
    assert "example-secret" not in prompt
