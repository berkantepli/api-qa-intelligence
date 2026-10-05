import socket

import httpx
import pytest
from fastapi import HTTPException

from app.domain import network
from app.domain.network import ensure_safe_target_host


@pytest.mark.parametrize("url", ["http://localhost:8000", "http://127.0.0.1:8000", "https://8.8.8.8"])
def test_allows_localhost_and_public_addresses(url):
    ensure_safe_target_host(httpx.URL(url))


@pytest.mark.parametrize("url", ["http://10.0.0.1", "http://192.168.1.10", "http://169.254.169.254"])
def test_rejects_private_and_link_local_addresses(url):
    with pytest.raises(HTTPException) as error:
        ensure_safe_target_host(httpx.URL(url))
    assert error.value.status_code == 422


def test_rejects_hostnames_that_resolve_to_private_addresses(monkeypatch):
    monkeypatch.setattr(
        network.socket,
        "getaddrinfo",
        lambda host, port, type: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", port))],
    )

    with pytest.raises(HTTPException, match="public host"):
        ensure_safe_target_host(httpx.URL("https://internal.example"))


def test_rejects_unresolvable_hostnames(monkeypatch):
    def fail(*args, **kwargs):
        raise socket.gaierror("not found")

    monkeypatch.setattr(network.socket, "getaddrinfo", fail)

    with pytest.raises(HTTPException, match="could not be resolved"):
        ensure_safe_target_host(httpx.URL("https://missing.example"))
