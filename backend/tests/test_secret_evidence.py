import json

import httpx


def echo(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"url": str(request.url), "headers": dict(request.headers)}, headers={"X-Client": request.headers.get("X-Client", "")})


def test_contract_credentials_with_ordinary_names_are_masked_in_evidence(client, mock_http):
    mock_http.respond_with(echo)

    result = client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/weather",
        "query_params": {"appid": "SECRET-APPID-123", "city": "Ankara"},
        "headers": {"X-Client": "SECRET-HDR-456"},
        "secret_names": ["appid", "X-Client"],
    }).json()

    evidence = json.dumps(result)
    assert "SECRET-APPID-123" not in evidence
    assert "SECRET-HDR-456" not in evidence
    assert "city=Ankara" in result["request_url"]
    assert result["request_headers"]["X-Client"] == "[REDACTED]"
    # The request itself still carried the real values.
    sent = mock_http.requests[0]
    assert sent.url.params["appid"] == "SECRET-APPID-123"
    assert sent.headers["X-Client"] == "SECRET-HDR-456"


def test_without_secret_names_ordinary_names_stay_visible(client, mock_http):
    mock_http.respond_with(echo)

    result = client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/weather", "query_params": {"city": "Ankara"},
    }).json()

    assert "city=Ankara" in result["request_url"]


def test_flows_mask_contract_credentials(client, mock_http):
    mock_http.respond_with(echo)

    result = client.post("/api/v1/flows/execute", json={
        "base_url": "http://127.0.0.1:8000", "headers": {"X-Client": "SECRET-HDR-456"}, "secret_names": ["X-Client"],
        "steps": [{"title": "Read", "role": "read", "method": "GET", "path": "/weather"}],
    }).json()

    assert result["steps"][0]["status"] == "PASS"
    assert "SECRET-HDR-456" not in json.dumps(result)
