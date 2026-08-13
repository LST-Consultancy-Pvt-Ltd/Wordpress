import json
import logging
import re as _re

logger = logging.getLogger(__name__)


def _repair_and_parse_json(broken: str) -> dict:
    """Best-effort repair of LLM-generated JSON. Handles:
    - smart quotes / curly quotes
    - trailing commas
    - extracts the largest balanced {...} substring
    - escapes raw newlines inside string values (the typical content_html bug)
    """
    # Replace smart quotes
    s = (broken
         .replace("“", '"').replace("”", '"')
         .replace("‘", "'").replace("’", "'"))

    # Find the first { and last } to isolate the JSON object
    first = s.find("{")
    last = s.rfind("}")
    if first != -1 and last != -1 and last > first:
        s = s[first:last + 1]

    # Remove trailing commas before } or ]
    s = _re.sub(r",(\s*[}\]])", r"\1", s)

    # Try parsing as-is
    try:
        return json.loads(s)
    except Exception:
        pass

    # Final fallback: walk character-by-character escaping raw newlines/CRs
    # that appear inside string literals (the most common content_html failure).
    out = []
    in_string = False
    escape = False
    for ch in s:
        if escape:
            out.append(ch)
            escape = False
            continue
        if ch == "\\":
            out.append(ch)
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            out.append(ch)
            continue
        if in_string and ch == "\n":
            out.append("\\n")
            continue
        if in_string and ch == "\r":
            out.append("\\r")
            continue
        if in_string and ch == "\t":
            out.append("\\t")
            continue
        out.append(ch)
    repaired = "".join(out)
    try:
        return json.loads(repaired)
    except Exception as final_err:
        # Last resort: return an empty dict so the caller can degrade gracefully.
        # Surface the real error in the log so we know it happened.
        logger.error(f"JSON repair ultimately failed: {final_err}. Raw head: {broken[:500]}")
        return {}
