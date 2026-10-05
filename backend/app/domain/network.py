import ipaddress
import socket

import httpx
from fastapi import HTTPException


def ensure_safe_target_host(url: httpx.URL) -> None:
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
            detail="The target URL must use a public host or localhost.",
        )

    try:
        resolved_addresses = {
            ipaddress.ip_address(result[4][0])
            for result in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError) as error:
        raise HTTPException(
            status_code=422,
            detail="The target URL host could not be resolved.",
        ) from error

    if not resolved_addresses or any(not address.is_global for address in resolved_addresses):
        raise HTTPException(
            status_code=422,
            detail="The target URL must use a public host or localhost.",
        )
