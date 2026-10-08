import json

import httpx
import pytest


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


def test_ai_status_reports_reachable_model(client, mock_http, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3")
    mock_http.respond_with(lambda request: httpx.Response(200, json={"models": [{"name": "llama3:latest"}, {"name": "qwen"}]}))

    status = client.get("/api/v1/ai/status").json()

    assert status["reachable"] is True
    assert status["model_available"] is True
    assert status["available_models"] == ["llama3:latest", "qwen"]
    assert mock_http.requests[0].url.path == "/api/tags"


def test_ai_status_reports_missing_model(client, mock_http, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3:8b")
    mock_http.respond_with(lambda request: httpx.Response(200, json={"models": [{"name": "llama3:latest"}]}))

    status = client.get("/api/v1/ai/status").json()

    assert (status["reachable"], status["model_available"]) == (True, False)


def test_ai_status_reports_unreachable_server(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    status = client.get("/api/v1/ai/status").json()

    assert (status["reachable"], status["model_available"]) == (False, False)


def ollama_server(tags=("llama3:latest",), chat_status=200, chat_content="OK"):
    def handler(request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": name} for name in tags]})
        return httpx.Response(chat_status, json={"message": {"content": chat_content}})

    return handler


def steps(diagnosis):
    return [diagnosis[name]["status"] for name in ("application", "ollama", "model_check", "inference")]


def test_diagnosis_passes_every_step(client, mock_http, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3")
    mock_http.respond_with(ollama_server())

    diagnosis = client.get("/api/v1/ai/diagnose").json()

    assert steps(diagnosis) == ["available"] * 4
    assert diagnosis["available"] is True
    assert [request.url.path for request in mock_http.requests] == ["/api/tags", "/api/chat"]
    assert "Reply with the single word OK." in mock_http.requests[1].content.decode()


def test_diagnosis_skips_inference_when_model_is_missing(client, mock_http, monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "mistral")
    mock_http.respond_with(ollama_server())

    diagnosis = client.get("/api/v1/ai/diagnose").json()

    assert steps(diagnosis) == ["available", "available", "unavailable", "skipped"]
    assert "ollama pull mistral" in diagnosis["model_check"]["suggested_action"]
    assert diagnosis["available"] is False
    assert len(mock_http.requests) == 1


def test_diagnosis_skips_later_steps_when_ollama_is_down(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    diagnosis = client.get("/api/v1/ai/diagnose").json()

    assert steps(diagnosis) == ["available", "unavailable", "skipped", "skipped"]
    assert "OLLAMA_BASE_URL" in diagnosis["ollama"]["suggested_action"]


@pytest.mark.parametrize(("chat_status", "chat_content"), [(500, "OK"), (200, "")])
def test_diagnosis_reports_failed_inference(client, mock_http, monkeypatch, chat_status, chat_content):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3")
    mock_http.respond_with(ollama_server(chat_status=chat_status, chat_content=chat_content))

    diagnosis = client.get("/api/v1/ai/diagnose").json()

    assert steps(diagnosis) == ["available", "available", "available", "unavailable"]
    assert diagnosis["available"] is False


def test_scenario_ideas_list_existing_checks_so_they_are_not_repeated(client, mock_http):
    mock_http.respond_with(ollama_reply({"scenarios": []}))
    operation = {
        "method": "GET",
        "path": "/bugs/activity",
        "scenarios": [
            {"category": "happy_path", "title": "Valid request", "rationale": "r", "source": "contract"},
            {"category": "boundary", "title": "Test with rate limiting applied", "rationale": "r", "source": "ai_edited"},
            {"category": "negative", "title": "Old review idea", "rationale": "r", "source": "ai"},
        ],
    }

    client.post("/api/v1/specs/scenario-ideas", json={"operation": operation})

    sent = json.loads(mock_http.requests[0].content)
    context = json.loads(sent["messages"][1]["content"].split("\n", 1)[1])
    assert context["existing_checks"] == [
        {"title": "Valid request", "category": "happy_path"},
        {"title": "Test with rate limiting applied", "category": "boundary"},
    ]
    assert context["has_inputs_to_vary"] is False
    assert "Never repeat" in sent["messages"][0]["content"]
