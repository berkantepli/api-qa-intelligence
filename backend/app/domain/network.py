import ipaddress
import os
import socket

import httpx
from fastapi import HTTPException


class HostResolutionError(HTTPException):
    """The target host name does not resolve; a connection probe reports it as unreachable."""


def parse_target_base_url(base_url: str, *, allow_private_network: bool = False) -> httpx.URL:
    """Validates a target API base URL the same way for checks and connection probes.

    Private-network hosts are blocked unless the caller allows them (the CLI's
    --allow-private-network, because a CI job usually tests a service on its own network) or the
    server is started with API_QA_ALLOW_PRIVATE_NETWORK=1 (for example in Docker, where an API on
    the host machine is reached through a private address such as host.docker.internal).
    """
    base = httpx.URL(base_url)
    if base.username or base.password:
        raise HTTPException(
            status_code=422,
            detail="Target URLs with embedded credentials are not supported; use a request header instead.",
        )
    if base.query or base.fragment:
        raise HTTPException(
            status_code=422,
            detail="Base URL cannot contain a query or fragment, for example https://api.example.com/v1.",
        )
    if not allow_private_network:
        ensure_safe_target_host(base)
    return base


PRIVATE_NETWORK_HINT = (
    "Private network addresses are allowed when the app is started with API_QA_ALLOW_PRIVATE_NETWORK=1 "
    "(CLI: --allow-private-network)."
)
DNS_FAILURE_MARKERS = ("name or service not known", "nodename nor servname", "getaddrinfo", "name resolution", "no address associated")


def request_error_reason(error: httpx.HTTPError, subject: str, timeout_seconds: int) -> str:
    """Says why a request got no response, in words a user can act on."""
    if isinstance(error, httpx.TimeoutException):
        return f"{subject[0].upper()}{subject[1:]} did not respond within {timeout_seconds} seconds."
    if isinstance(error, httpx.ConnectError):
        if any(marker in str(error).lower() for marker in DNS_FAILURE_MARKERS):
            return f"Could not connect to {subject}: its host name could not be resolved. Check the URL."
        return f"Could not connect to {subject}: the connection was refused or the host is unreachable. Check that the server is running and the URL is correct."
    if isinstance(error, httpx.RemoteProtocolError):
        return f"{subject[0].upper()}{subject[1:]} closed the connection without a valid HTTP response."
    return f"The request to {subject} failed before a response arrived."


def private_network_allowed() -> bool:
    return os.getenv("API_QA_ALLOW_PRIVATE_NETWORK", "").lower() in {"1", "true", "yes"}


def ensure_safe_target_host(url: httpx.URL, label: str = "target URL") -> None:
    if private_network_allowed():
        return
    host = url.host
    port = url.port or (443 if url.scheme == "https" else 80)
    if host.lower() == "localhost":
        return

    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        literal_address = None

    if literal_address is not None:
        if literal_address.is_loopback or literal_address.is_global:
            return
        raise HTTPException(
            status_code=422,
            detail=f"The {label} must use a public host or localhost. {PRIVATE_NETWORK_HINT}",
        )

    try:
        resolved_addresses = {
            ipaddress.ip_address(result[4][0])
            for result in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError) as error:
        raise HostResolutionError(
            status_code=422,
            detail=f"The {label} host could not be resolved. Check the spelling of the URL.",
        ) from error

    if not resolved_addresses or any(not address.is_global for address in resolved_addresses):
        raise HTTPException(
            status_code=422,
            detail=f"The {label} must use a public host or localhost. {PRIVATE_NETWORK_HINT}",
        )
