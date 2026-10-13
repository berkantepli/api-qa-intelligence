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


def execute(client, response_json, **request):
    return client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/weather", "secret_names": ["appid"], **request,
    }).json()


def test_schema_differences_do_not_quote_a_credential(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"appid": "SECRET-APPID-123", "code": "SECRET-APPID-123"}))
    schema = {"200": {"type": "object", "properties": {"appid": {"enum": ["x"]}, "code": {"enum": ["y"]}}}}

    result = execute(client, None, query_params={"appid": "SECRET-APPID-123"}, response_schemas=schema)

    assert result["schema_check"]["status"] == "failed"
    assert "SECRET-APPID-123" not in json.dumps(result)
    assert "$.appid: [REDACTED] does not match the documented schema" in result["schema_check"]["errors"]
    assert "$.code: '[REDACTED]' is not one of 'y'" in result["schema_check"]["errors"]


def test_a_common_word_as_the_key_is_masked_only_as_a_value_of_its_own(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"note": "latest test results", "id": 12345, "key": "test"}))

    result = execute(client, None, query_params={"appid": "test"})

    body = json.loads(result["response_body"])
    assert body["note"] == "latest [REDACTED] results"
    assert body["id"] == 12345


def test_a_secret_across_the_display_limit_is_masked_whole(client, mock_http):
    secret = "SECRET-APPID-0123456789"
    text = "x " * 4_995 + secret + " tail"
    mock_http.respond_with(lambda request: httpx.Response(200, text=text, headers={"Content-Type": "text/plain"}))

    result = execute(client, None, query_params={"appid": secret})

    assert len(result["response_body"]) == 10_000 and result["response_truncated"] is True
    assert "SECRET-APP" not in result["response_body"]


def test_short_credentials_are_masked_where_they_are_echoed(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"pin": "12", "code": "abc", "label": "abcdef"}))

    result = client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/me", "secret_names": ["pin", "client"],
        "query_params": {"pin": "12"}, "headers": {"Client": "abc"},
    }).json()

    body = json.loads(result["response_body"])
    # Under its own name at any length; elsewhere as a value of its own (three characters or more).
    assert body == {"pin": "[REDACTED]", "code": "[REDACTED]", "label": "abcdef"}


def test_one_masker_handles_url_and_json_escaped_forms():
    from app.domain.evidence import hide_secret_values

    text = 'url=/x?k=a%2Fb%20c json="a\\/b \\"q\\"" plain=a/b c'
    assert hide_secret_values(text, ["a/b c", 'a\\/b "q"', "x"]).count("[REDACTED]") >= 2
    assert hide_secret_values("a/b c", ["a/b c"]) == "[REDACTED]"
    assert hide_secret_values("ok", ["ok"]) == "ok"
