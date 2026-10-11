import ipaddress
import os
import socket
from typing import Any

import anyio
import httpcore
import httpx
from fastapi import HTTPException

# NAT64 (RFC 6052) carries an IPv4 address in the last 32 bits; it can reach a private IPv4 network.
NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")
PINNED_ADDRESS_BLOCKED = "resolves to a private network address"


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
        if PINNED_ADDRESS_BLOCKED in str(error):
            return f"Could not connect to {subject}: its host name now {PINNED_ADDRESS_BLOCKED}, so the request was not sent."
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
    if _is_localhost(host):
        return

    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        literal_address = None

    if literal_address is not None:
        if literal_address.is_loopback or is_public_address(literal_address):
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

    if not resolved_addresses or any(not is_public_address(address) for address in resolved_addresses):
        raise HTTPException(
            status_code=422,
            detail=f"The {label} must use a public host or localhost. {PRIVATE_NETWORK_HINT}",
        )


def _is_localhost(host: str) -> bool:
    return host.lower().rstrip(".") == "localhost"


def is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """A globally routable address that does not tunnel to a private IPv4 address."""
    if not address.is_global:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        embedded = address.ipv4_mapped or address.sixtofour or (address.teredo[1] if address.teredo else None)
        if address in NAT64_PREFIX:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        if embedded is not None and not embedded.is_global:
            return False
    return True


def _connectable_address(host: str) -> str:
    """Resolves the host again when connecting and refuses private addresses, so a DNS answer that
    changes after the URL was checked (DNS rebinding) cannot reach the private network."""
    if _is_localhost(host):
        return host
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if literal.is_loopback or is_public_address(literal):
            return host
        raise httpcore.ConnectError(f"{host} {PINNED_ADDRESS_BLOCKED}")
    try:
        addresses = [ipaddress.ip_address(result[4][0]) for result in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)]
    except (OSError, ValueError) as error:
        raise httpcore.ConnectError(f"[Errno 8] nodename nor servname provided: {host}") from error
    if not addresses or any(not is_public_address(address) for address in addresses):
        raise httpcore.ConnectError(f"{host} {PINNED_ADDRESS_BLOCKED}")
    return str(addresses[0])


class _PublicOnlyBackend(httpcore.AsyncNetworkBackend):
    """Connects to the address that was just checked instead of letting the socket resolve the host again."""

    def __init__(self, inner: httpcore.AsyncNetworkBackend) -> None:
        self._inner = inner

    async def connect_tcp(self, host: str, port: int, timeout: float | None = None,
                          local_address: str | None = None, socket_options: Any = None) -> httpcore.AsyncNetworkStream:
        address = await anyio.to_thread.run_sync(_connectable_address, host)
        return await self._inner.connect_tcp(
            address, port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    async def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Unix sockets are not used for target APIs.")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def target_client(*, allow_private_network: bool = False, **kwargs: Any) -> httpx.AsyncClient:
    """An HTTP client for user-supplied URLs. Unless private networks are allowed, every connection
    is checked again at connect time. TLS still verifies the certificate for the original host name."""
    if allow_private_network or private_network_allowed():
        return httpx.AsyncClient(**kwargs)
    transport = httpx.AsyncHTTPTransport()
    pool = transport._pool  # httpx has no public hook for the connection backend.
    pool._network_backend = _PublicOnlyBackend(pool._network_backend)
    return httpx.AsyncClient(transport=transport, **kwargs)
