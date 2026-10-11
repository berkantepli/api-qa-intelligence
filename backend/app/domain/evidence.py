import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SENSITIVE_KEY = re.compile(
    r"authorization|authentication|(?:^|[^a-z])auth(?:$|[^a-z])|cookie|token|secret|"
    r"password|passwd|passphrase|credential|api[-_]?key|private[-_]?key|(?:^|[^a-z])key(?:$|[^a-z])|"
    r"session|signature|(?:^|[^a-z])(?:pwd|pin|otp)(?:$|[^a-z])",
    re.IGNORECASE,
)


def redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def redact_headers(headers: dict[str, Any]) -> dict[str, str]:
    return {
        name: "[REDACTED]" if SENSITIVE_KEY.search(name) else str(value)
        for name, value in headers.items()
    }


def sanitize_url(url: str) -> str:
    parts = urlsplit(url)
    host = parts.hostname or ""
    try:
        port = parts.port
    except ValueError:
        return ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port else host
    query = [
        (key, "[REDACTED]" if SENSITIVE_KEY.search(key) else value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))


def redact_text(value: str) -> str:
    try:
        parsed = json.loads(value)
        return json.dumps(redact_value(parsed), ensure_ascii=False, indent=2)
    except (json.JSONDecodeError, RecursionError):
        pattern = re.compile(
            r"((?:authorization|authentication|auth|cookie|token|secret|password|passwd|passphrase|credential|"
            r"api[-_]?key|private[-_]?key|\bkey|session\w*|signature|\bpwd|\bpin|\botp)"
            r"[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)",
            re.IGNORECASE,
        )
        return pattern.sub(r'\1"[REDACTED]"', value)


def strip_sensitive(value: Any) -> Any:
    """Removes sensitive keys (instead of masking them) from a value that will be kept and reused."""
    if isinstance(value, dict):
        return {key: strip_sensitive(item) for key, item in value.items() if not SENSITIVE_KEY.search(str(key))}
    if isinstance(value, list):
        return [strip_sensitive(item) for item in value]
    return value


def persistable_inputs(values: dict[str, Any], credential_keys: set[str]) -> dict[str, Any]:
    """The request details of one operation that may be saved: no credentials, by contract or by name.

    Keys look like ``parameter:<location>:<name>``, ``body:<field>``, or ``body:__raw`` (the whole JSON body).
    A value holding JSON loses its sensitive keys; raw text that still names a credential is not kept.
    """
    kept: dict[str, Any] = {}
    for key, value in values.items():
        name = key.rsplit(":", 1)[-1]
        if key in credential_keys or (name != "__raw" and SENSITIVE_KEY.search(name)):
            continue
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                if key == "body:__raw" and redact_text(value) != value:
                    continue
            else:
                if isinstance(parsed, (dict, list)):
                    stripped = strip_sensitive(parsed)
                    if stripped != parsed:
                        layout: dict[str, Any] = {"indent": 2} if "\n" in value else {"separators": (",", ":")}
                        value = json.dumps(stripped, ensure_ascii=False, **layout)
        kept[key] = value
    return kept
