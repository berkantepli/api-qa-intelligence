import json

from app.domain.evidence import redact_headers, redact_text, redact_value, sanitize_url


def test_redact_value_masks_sensitive_keys_recursively():
    value = {"user": "qa", "password": "p", "nested": [{"api_key": "k", "auth": "a", "author": "kept"}]}

    assert redact_value(value) == {
        "user": "qa",
        "password": "[REDACTED]",
        "nested": [{"api_key": "[REDACTED]", "auth": "[REDACTED]", "author": "kept"}],
    }


def test_redact_headers_masks_credentials():
    headers = {"Authorization": "Bearer t", "Cookie": "s=1", "X-Api-Key": "k", "Accept": "application/json"}

    assert redact_headers(headers) == {
        "Authorization": "[REDACTED]",
        "Cookie": "[REDACTED]",
        "X-Api-Key": "[REDACTED]",
        "Accept": "application/json",
    }


def test_sanitize_url_removes_userinfo_and_masks_query_secrets():
    url = sanitize_url("https://user:pw@example.com:8443/items?token=abc&page=2#frag")

    assert url == "https://example.com:8443/items?token=%5BREDACTED%5D&page=2"


def test_redact_text_handles_json_and_plain_text():
    assert json.loads(redact_text('{"token": "abc", "ok": true}')) == {"token": "[REDACTED]", "ok": True}
    assert redact_text("password=hunter2 status=failed") == 'password="[REDACTED]" status=failed'
