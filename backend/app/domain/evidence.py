import json
import re
from typing import Any
from urllib.parse import parse_qsl, quote, quote_plus, urlencode, urlsplit, urlunsplit

SENSITIVE_KEY = re.compile(
    r"authorization|authentication|(?:^|[^a-z])auth(?:$|[^a-z])|cookie|token|secret|"
    r"password|passwd|passphrase|credential|api[-_]?key|private[-_]?key|(?:^|[^a-z])key(?:$|[^a-z])|"
    r"session|signature|(?:^|[^a-z])(?:pwd|pin|otp)(?:$|[^a-z])",
    re.IGNORECASE,
)
# Secrets that give themselves away by their shape, wherever they appear in text.
AUTH_SCHEME_VALUE = re.compile(r"\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*", re.IGNORECASE)
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
CARD_CANDIDATE = re.compile(r"(?<![\d-])[3-6]\d{3}(?:[ -]?\d){9,15}(?![\d-])")


def _luhn_valid(digits: str) -> bool:
    total = 0
    for index, digit in enumerate(reversed(digits)):
        value = int(digit) * (2 if index % 2 else 1)
        total += value - 9 if value > 9 else value
    return total % 10 == 0


def _redact_card(match: re.Match[str]) -> str:
    digits = re.sub(r"[ -]", "", match.group(0))
    return "[REDACTED]" if 13 <= len(digits) <= 19 and _luhn_valid(digits) else match.group(0)


def scrub_text(value: str) -> str:
    """Masks bearer and basic credentials, JWTs, and payment card numbers inside free text."""
    value = AUTH_SCHEME_VALUE.sub(lambda match: f"{match.group(1)} [REDACTED]", value)
    value = JWT.sub("[REDACTED]", value)
    return CARD_CANDIDATE.sub(_redact_card, value)


def redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


def redact_headers(headers: dict[str, Any]) -> dict[str, str]:
    return {
        name: "[REDACTED]" if SENSITIVE_KEY.search(name) else scrub_text(str(value))
        for name, value in headers.items()
    }


def sanitize_url(url: str, secret_names: set[str] | None = None) -> str:
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
        (key, "[REDACTED]" if SENSITIVE_KEY.search(key) or key.lower() in (secret_names or set()) else value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))


# Shorter values would match too much ordinary text even as whole tokens ("1", "ok").
MIN_SECRET_CHARS = 3


def hide_secret_values(text: str, values: list[str]) -> str:
    """Masks known secret values wherever they appear as a value of their own: as typed, URL-encoded,
    or JSON-escaped (for example an API key that the target API echoes back in its response).
    A value inside a longer word or number is left alone, so a key such as "test" does not turn
    "latest" into "la[REDACTED]"."""
    secrets = {value for value in values if len(value.strip()) >= MIN_SECRET_CHARS}
    for value in sorted(secrets, key=len, reverse=True):
        for form in {value, quote(value, safe=""), quote_plus(value), json.dumps(value)[1:-1]}:
            text = re.sub(rf"(?<![A-Za-z0-9]){re.escape(form)}(?![A-Za-z0-9])", "[REDACTED]", text)
    return text


def hide_named_fields(text: str, names: set[str]) -> str:
    """Masks the values of JSON fields named like a credential (case-insensitive), whatever their
    length, for example an echoed {"pin": "12"}. Text that is not JSON is returned as it is."""
    if not names:
        return text
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        return text

    def walk(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: "[REDACTED]" if str(key).lower() in names else walk(item) for key, item in value.items()}
        if isinstance(value, list):
            return [walk(item) for item in value]
        return value

    masked = walk(document)
    return text if masked == document else json.dumps(masked, ensure_ascii=False, indent=2)


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
        return scrub_text(pattern.sub(r'\1"[REDACTED]"', value))


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
