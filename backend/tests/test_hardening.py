import ipaddress
import socket

import httpcore
import httpx
import pytest

from app.domain.evidence import redact_text, redact_value, scrub_text
from app.domain.network import (
    _connectable_address,
    is_public_address,
    request_error_reason,
    target_client,
)


def test_pages_cannot_be_framed_by_other_sites(client):
    response = client.get("/health")

    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize(("text", "hidden"), [
    ("note: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"),
    ("Authorization header was Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="),
    ("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEFghi in a log", "eyJhbGciOiJIUzI1NiJ9"),
    ("card 4111 1111 1111 1111 declined", "4111 1111 1111 1111"),
    ("card 5500-0000-0000-0004", "5500-0000-0000-0004"),
])
def test_free_text_secrets_are_masked(text, hidden):
    assert hidden not in scrub_text(text)
    assert hidden not in redact_text(text)


def test_secrets_inside_json_string_values_are_masked():
    redacted = redact_value({"note": "Bearer abcdefghijklmnop1234", "card_number": "4111111111111111", "order_id": "4111111111111112"})

    assert redacted == {"note": "Bearer [REDACTED]", "card_number": "[REDACTED]", "order_id": "4111111111111112"}


@pytest.mark.parametrize(("address", "public"), [
    ("8.8.8.8", True),
    ("2606:4700:4700::1111", True),
    ("10.0.0.1", False),
    ("64:ff9b::a00:1", False),  # NAT64 for 10.0.0.1
    ("64:ff9b::808:808", True),  # NAT64 for 8.8.8.8
    ("2002:a00:1::", False),  # 6to4 for 10.0.0.1
    ("::ffff:10.0.0.1", False),
])
def test_public_addresses_do_not_tunnel_to_private_ones(address, public):
    assert is_public_address(ipaddress.ip_address(address)) is public


def test_a_host_that_starts_resolving_to_a_private_address_is_refused_at_connect(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(None, None, None, "", ("10.0.0.5", 0))])

    with pytest.raises(httpcore.ConnectError, match="private network address"):
        _connectable_address("rebind.example")


def test_connections_go_to_the_checked_address(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(None, None, None, "", ("93.184.216.34", 0))])

    assert _connectable_address("api.example.com") == "93.184.216.34"
    assert _connectable_address("localhost") == "localhost"
    assert _connectable_address("127.0.0.1") == "127.0.0.1"


def test_rebinding_is_explained():
    error = httpx.ConnectError("rebind.example resolves to a private network address")

    assert "now resolves to a private network address" in request_error_reason(error, "the target API", 15)


def test_target_client_checks_connections_unless_private_networks_are_allowed(monkeypatch):
    monkeypatch.delenv("API_QA_ALLOW_PRIVATE_NETWORK", raising=False)
    checked = target_client()
    plain = target_client(allow_private_network=True)

    assert type(checked._transport._pool._network_backend).__name__ == "_PublicOnlyBackend"
    assert type(plain._transport._pool._network_backend).__name__ != "_PublicOnlyBackend"


def test_localhost_with_a_trailing_dot_is_allowed(client, mock_http):
    response = client.post("/api/v1/runs/execute", json={"base_url": "http://localhost.:8000", "method": "GET", "path": "/x"})

    assert response.status_code == 200


def test_line_breaks_in_headers_are_refused(client, mock_http):
    response = client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/x", "headers": {"X-A": "v\r\nInjected: yes"},
    })

    assert response.status_code == 422
    assert "line breaks" in str(response.json()["detail"])
    assert mock_http.requests == []
