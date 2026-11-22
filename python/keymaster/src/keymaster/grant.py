"""Memeplex grants as a Keymaster makes them: the grant link a client presents,
and the validity of a grant and a grant request under ``v: 1``.

docs/plans/memeplex-reference-1436.md, "Grant request flow" and "Wallet";
docs/plans/memeplex-1436.md, "One grant, one client, one chain".

This is packages/keymaster/src/grant.ts for the Python port, and gives the same
answer for every input: the rules of share/schema/memeplex/v1/grant.json and
grant-request.json and the checks beyond them. python/keymaster/tests/
test_grant.py holds it to tests/fixtures/memeplex-v1-vectors.json and
tests/fixtures/memeplex-grant-link-vectors.json, as the TypeScript port is.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

# The chains a grant may be created on. A grant on any other registry is void.
PERMITTED_GRANT_REGISTRIES = ("BTC:mainnet", "ZEC:mainnet", "ETH:mainnet", "SOL:mainnet-beta")

# The actions that permit the core kinds. A grant that lists no actions permits
# them all.
CORE_GRANT_ACTIONS = ("memeplex:post", "memeplex:reply", "memeplex:rate", "memeplex:tag")

GRANT_LINK_PREFIX = "archon://grant?request="

# The longest a link may be, in UTF-16 code units.
MAX_GRANT_LINK_LENGTH = 2048

# The characters String.prototype.trim removes.
JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0        "
    "        　﻿"
)

# Matched with fullmatch: `$` would also match before a trailing newline.
_DID = re.compile(r"did:[a-z0-9]+:[A-Za-z0-9._:%-]+")
_PINNED_DID_URL = re.compile(r"did:[a-z0-9]+:[A-Za-z0-9._:%-]+\?versionId=b[a-z2-7]{20,}")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")
_INSTANT = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z")


def is_instant(value: str) -> bool:
    """Whether a string that has the shape of an instant names a real one."""
    parts = _INSTANT.fullmatch(value)
    if not parts:
        return False
    year, month, day, hour, minute, second = (int(part) for part in parts.groups()[:6])
    if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59:
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return 1 <= day <= days


def is_grant_action(action: Any) -> bool:
    """Whether an action is one a grant may list: a core action, or the pinned
    DID URL of an extension kind's schema."""
    return isinstance(action, str) and (
        action in CORE_GRANT_ACTIONS or _PINNED_DID_URL.fullmatch(action) is not None
    )


def _is_integer(value: Any) -> bool:
    # What Number.isInteger accepts of a parsed JSON number: 1.0 is the integer 1.
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def _is_registry_list(registries: Any) -> bool:
    """The registries a grant request lists, when it limits where the client
    can publish: at least one of the permitted registries, each once."""
    return (
        isinstance(registries, list)
        and len(registries) >= 1
        and all(isinstance(registry, str) and registry in PERMITTED_GRANT_REGISTRIES for registry in registries)
        and len(set(registries)) == len(registries)
    )


def _matches_schema(value: dict[str, Any], request: bool) -> bool:
    """The grant schema, and the grant request schema, which also requires
    ``name`` and ``nonce`` and reads ``registries``. A field neither schema
    names is allowed, so ``registries`` in a grant is one of those."""
    client = value.get("client")
    if not isinstance(client, str) or not _DID.fullmatch(client):
        return False

    if request:
        name = value.get("name")
        # A name's length is counted in code points.
        if not isinstance(name, str) or not 1 <= len(name) <= 100:
            return False
        if "nonce" not in value:
            return False
        if "registries" in value and not _is_registry_list(value["registries"]):
            return False

    if "actions" in value:
        actions = value["actions"]
        if (
            not isinstance(actions, list)
            or len(actions) < 1
            or not all(is_grant_action(action) for action in actions)
            or len(set(actions)) != len(actions)
        ):
            return False

    if "nonce" in value:
        nonce = value["nonce"]
        if not isinstance(nonce, str) or len(nonce) < 22 or not _BASE64URL.fullmatch(nonce):
            return False

    if "expiresAt" in value:
        expires_at = value["expiresAt"]
        return isinstance(expires_at, str) and _INSTANT.fullmatch(expires_at) is not None

    return True


def _validate(value: Any, request: bool) -> str:
    if not isinstance(value, dict):
        return "schema"
    version = value.get("v")
    if not _is_integer(version):
        return "version"
    if version != 1:
        return "unsupported"
    if not _matches_schema(value, request):
        return "schema"
    if "expiresAt" in value and not is_instant(value["expiresAt"]):
        return "expiry-instant"
    return "valid"


def validate_grant(memeplex_grant: Any) -> str:
    """The validity of the ``memeplexGrant`` member of an asset's data:
    ``valid``, or the first of ``unsupported``, ``version``, ``schema`` and
    ``expiry-instant`` that makes it invalid."""
    return _validate(memeplex_grant, False)


def validate_grant_request(memeplex_grant_request: Any) -> str:
    """The validity of the ``memeplexGrantRequest`` a grant link carries."""
    return _validate(memeplex_grant_request, True)


def _refuse_constant(name: str) -> Any:
    # json accepts NaN and Infinity, which are not JSON.
    raise ValueError(name)


def _from_base64url(encoded: str) -> str | None:
    """The text an unpadded base64url string holds, or None when it is not one
    or does not hold UTF-8."""
    if not _BASE64URL.fullmatch(encoded) or len(encoded) % 4 == 1:
        return None
    try:
        text = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
    except ValueError:
        return None
    # A decoder for the web drops one leading byte order mark.
    return text[1:] if text.startswith("﻿") else text


def decode_grant_link(link: Any) -> dict[str, Any]:
    """The request a grant link carries, as ``{"request": …}``, or why the link
    is refused, as ``{"error": …}`` with the request's ``validity`` when the
    error is ``invalid-request``."""
    if not isinstance(link, str) or not link.startswith(GRANT_LINK_PREFIX):
        return {"error": "not-a-grant-link"}
    if len(link.encode("utf-16-le", "surrogatepass")) // 2 > MAX_GRANT_LINK_LENGTH:
        return {"error": "too-long"}

    text = _from_base64url(link[len(GRANT_LINK_PREFIX):])
    if text is None:
        return {"error": "undecodable"}
    try:
        carried = json.loads(text, parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        return {"error": "undecodable"}

    request = carried.get("memeplexGrantRequest") if isinstance(carried, dict) else None
    validity = validate_grant_request(request)
    if validity == "valid":
        return {"request": request}
    return {"error": "invalid-request", "validity": validity}
