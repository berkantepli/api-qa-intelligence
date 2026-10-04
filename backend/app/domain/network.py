import ipaddress
import socket

from fastapi import HTTPException, status


def ensure_safe_target_host(host: str, port: int) -> None:
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
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The target URL must use a public host or localhost.",
        )

    try:
        resolved_addresses = {
            ipaddress.ip_address(result[4][0])
            for result in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The target URL host could not be resolved.",
        ) from error

    if not resolved_addresses or any(not address.is_global for address in resolved_addresses):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The target URL must use a public host or localhost.",
        )
