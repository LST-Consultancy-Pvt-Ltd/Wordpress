"""Secret redaction for anything that leaves the process: logs, audit
records, API error details and stored bridge error messages."""
import re
from typing import Any

_SENSITIVE_KEYS = re.compile(
    r"(?i)(secret|token|password|passphrase|api[_-]?key|authorization|signature|credential|cookie|private[_-]?key)"
)
_INLINE = [
    re.compile(r'(?i)\b((?:api[_-]?key|apikey|access[_-]?key|token|secret|password|signature)["\']?\s*[=:]\s*["\']?)([^&\s"\',}]+)'),
    re.compile(r"(?i)(bearer\s+)([A-Za-z0-9._~+/=-]{8,})"),
    re.compile(r"(?i)(x-bridge-signature:\s*)([0-9a-f]{16,})"),
]
REDACTED = "***REDACTED***"


def redact_text(text: str) -> str:
    if not isinstance(text, str):
        return text
    for pat in _INLINE:
        text = pat.sub(lambda m: m.group(1) + REDACTED, text)
    return text


def redact(value: Any, _depth: int = 0) -> Any:
    """Recursively redact dict values under sensitive keys and inline secrets in strings."""
    if _depth > 8:
        return value
    if isinstance(value, dict):
        return {k: (REDACTED if isinstance(k, str) and _SENSITIVE_KEYS.search(k) and v not in (None, "")
                    else redact(v, _depth + 1)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, _depth + 1) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value
