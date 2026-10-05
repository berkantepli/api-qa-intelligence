import base64
import json

import httpx
import pytest

from app.api.runs import MAX_RESPONSE_SIZE_BYTES

BASE_URL = "http://127.0.0.1:8000"


def execute(client, **overrides):
    payload = {"base_url": BASE_URL, "method": "GET", "path": "/health", **overrides}
    return client.post("/api/v1/runs/execute", json=payload)


def test_pass_when_status_matches_expectation(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"status": "ok"}))

    result = execute(client).json()

    assert result["result"] == "PASS"
    assert result["response_status"] == 200
    assert json.loads(result["response_body"]) == {"status": "ok"}
    assert str(mock_http.requests[0].url) == f"{BASE_URL}/health"


def test_fail_when_status_does_not_match(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(500, text="boom"))

    result = execute(client, expected_status_codes=[200, 204]).json()

    assert result["result"] == "FAIL"
    assert result["response_status"] == 500
    assert result["expected_status_codes"] == [200, 204]


def test_error_when_target_is_unreachable(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    result = execute(client).json()

    assert result["result"] == "ERROR"
    assert result["response_status"] is None
    assert "could not reach" in result["error"]


def test_sends_real_values_but_records_redacted_evidence(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(201, json={"token": "issued-secret"}))

    result = execute(
        client,
        method="post",
        path="/login",
        query_params={"api_key": "query-secret", "page": "1"},
        headers={"Authorization": "Bearer header-secret"},
        json_body={"user": "qa", "password": "body-secret"},
        expected_status_codes=[201],
    ).json()

    sent = mock_http.requests[0]
    assert sent.method == "POST"
    assert sent.headers["Authorization"] == "Bearer header-secret"
    assert sent.url.params["api_key"] == "query-secret"
    assert json.loads(sent.content) == {"user": "qa", "password": "body-secret"}

    assert result["result"] == "PASS"
    evidence = json.dumps(result)
    for secret in ("header-secret", "query-secret", "body-secret", "issued-secret"):
        assert secret not in evidence
    assert result["request_headers"]["Authorization"] == "[REDACTED]"
    assert result["request_headers"]["Content-Type"] == "application/json"


def test_form_upload_uses_multipart_and_omits_file_contents(client, mock_http):
    result = execute(
        client,
        method="POST",
        path="/upload",
        headers={"Content-Type": "application/json"},
        form_fields={"note": "hello"},
        file_uploads={
            "file": [{"filename": "a.txt", "content_type": "text/plain", "content_base64": base64.b64encode(b"file-bytes").decode()}]
        },
    ).json()

    sent = mock_http.requests[0]
    assert sent.headers["Content-Type"].startswith("multipart/form-data; boundary=")
    assert b"file-bytes" in sent.content
    assert b"hello" in sent.content

    assert "file-bytes" not in json.dumps(result)
    assert json.loads(result["request_body"])["files"] == {"file": [{"filename": "a.txt", "content_type": "text/plain"}]}


def test_empty_file_list_is_sent_and_recorded_as_json(client, mock_http):
    result = execute(client, method="POST", path="/items", file_uploads={"file": []}, json_body={"x": 1}).json()

    assert mock_http.requests[0].headers["Content-Type"] == "application/json"
    assert result["request_headers"]["Content-Type"] == "application/json"
    assert json.loads(result["request_body"]) == {"json": {"x": 1}}


def test_large_responses_are_truncated(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, content=b"x" * (MAX_RESPONSE_SIZE_BYTES + 10)))

    result = execute(client).json()

    assert result["response_truncated"] is True
    assert len(result["response_body"]) <= 10_000


@pytest.mark.parametrize(
    "overrides",
    [
        {"base_url": "http://127.0.0.1:8000/api"},
        {"base_url": "http://u:p@127.0.0.1:8000"},
        {"base_url": "http://10.0.0.1"},
        {"path": "/../admin"},
        {"path": "relative"},
        {"method": "TRACE"},
        {"headers": {"Host": "evil.example"}},
        {"expected_status_codes": [700]},
        {"file_uploads": {"file": [{"filename": "a.txt", "content_base64": "not base64!"}]}},
    ],
)
def test_rejects_unsafe_or_invalid_requests_without_calling_target(client, mock_http, overrides):
    response = execute(client, **overrides)

    assert response.status_code == 422
    assert mock_http.requests == []


def test_batch_summarizes_results(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200 if request.url.path == "/ok" else 404))

    response = client.post(
        "/api/v1/runs/execute-batch",
        json={
            "scenarios": [
                {"base_url": BASE_URL, "method": "GET", "path": "/ok"},
                {"base_url": BASE_URL, "method": "GET", "path": "/missing"},
                {"base_url": BASE_URL, "method": "GET", "path": "/missing", "expected_status_codes": [404]},
            ]
        },
    ).json()

    assert (response["total"], response["passed"], response["failed"], response["errors"]) == (3, 2, 1, 0)
    assert [item["result"] for item in response["results"]] == ["PASS", "FAIL", "PASS"]
