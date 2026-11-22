"""Grants: what an identity lets a client application do in its name, and the
request by which a client asks for one.

A grant belongs to an app, which names it. A client of the app ``example``
asks by creating an asset whose data is ``{"exampleGrantRequest": {…}}``, and
the grant is an asset of the granting identity whose data is
``{"exampleGrant": {…}}``. Keymaster does with a grant only what is the same
for every app: it reads the request, checks the shape every request has, and
creates, lists, changes and revokes the grant. What an app's actions mean,
which registries it accepts and whether a grant is valid under its rules are
for that app's verifier.

This is packages/keymaster/src/grant.ts for the Python port, and gives the same
answer for every input. Both run tests/fixtures/grant-request-vectors.json.
"""

from __future__ import annotations

import math
import re
from typing import Any

# What a link to a grant request begins with. The request's DID follows. It is
# an auth link, as a challenge's is (``archon://auth?challenge=<DID>``): both
# name a DID that a service made and a wallet answers, and the parameter says
# which.
GRANT_LINK_PREFIX = "archon://auth?grant="

GRANT_REQUEST_SUFFIX = "GrantRequest"
GRANT_SUFFIX = "Grant"

# The characters String.prototype.trim removes.
JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0        "
    "        　﻿"
)

# Matched with fullmatch: `$` would also match before a trailing newline.
_APP = re.compile(r"[a-z][A-Za-z0-9]*")
_DATE_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))"
)


def is_date_time(value: Any) -> bool:
    """Whether a string is an RFC 3339 date-time on a day that exists, with
    ``T`` between the date and the time and ``Z`` or a numeric offset after it."""
    parts = _DATE_TIME.fullmatch(value) if isinstance(value, str) else None
    if not parts:
        return False
    year, month, day, hour, minute, second = (int(part) for part in parts.groups()[:6])
    offset_hour, offset_minute = int(parts.group(9) or 0), int(parts.group(10) or 0)
    if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59 or offset_hour > 23 or offset_minute > 59:
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return 1 <= day <= days


def is_name_list(value: Any) -> bool:
    """Whether a value is a list of at least one string, none empty and none twice."""
    return (
        isinstance(value, list)
        and len(value) >= 1
        and all(isinstance(name, str) and name for name in value)
        and len(set(value)) == len(value)
    )


def _is_number(value: Any) -> bool:
    # A JSON number: a boolean is not one, and neither is a float too large to be finite.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# A DID and nothing after it. A DID URL is not one: a query such as
# ``?versionSequence=1`` asks a node for an earlier version, which would be read
# as the request though the request has since changed or been deleted.
_BARE_DID = re.compile(r"did:[a-z0-9]+:[A-Za-z0-9_.:-]+")


def grant_request_id(named: str) -> str:
    """What names a grant request: its DID or an alias for it, or a link to it
    with the white space around it removed. Empty for what begins as a DID and
    is not one alone."""
    text = named.strip(JS_WHITESPACE)
    identifier = text
    if text.startswith(GRANT_LINK_PREFIX):
        # A link built with a URL library has the DID's colons percent-encoded.
        identifier = re.sub("%3[Aa]", ":", text[len(GRANT_LINK_PREFIX):])
    if identifier.startswith("did:") and not _BARE_DID.fullmatch(identifier):
        return ""
    return identifier


def _app_of(member: str, suffix: str) -> str | None:
    """The app a member of an asset's data names, given what follows the app's
    name in it, or None when the member names none."""
    app = member[: -len(suffix)] if member.endswith(suffix) else ""
    return app if _APP.fullmatch(app) else None


def _members_of(data: Any, suffix: str) -> list[tuple[str, str, Any]]:
    """The members of an asset's data that name an app, each as the app, the
    member and what it holds."""
    if not isinstance(data, dict):
        return []
    return [
        (app, member, value)
        for member, value in data.items()
        for app in [_app_of(member, suffix)]
        if app is not None
    ]


def grant_request_fault(request: Any) -> str | None:
    """The first member of a request that does not have the shape every
    request has, or None: ``request`` when it is not an object, else one of
    ``registries``, ``actions``, ``expiresAt``, ``name`` and ``v``. A member
    not named here is allowed, and is the app's."""
    if not isinstance(request, dict):
        return "request"
    if not is_name_list(request.get("registries")):
        return "registries"
    if "actions" in request and not is_name_list(request["actions"]):
        return "actions"
    if "expiresAt" in request and not is_date_time(request["expiresAt"]):
        return "expiresAt"
    if "name" in request and not isinstance(request["name"], str):
        return "name"
    if "v" in request and not _is_number(request["v"]):
        return "v"
    return None


def grant_request_in(data: Any) -> tuple[str, Any] | None:
    """The grant request an asset's data holds, as the app it names and what
    it holds: the one member named ``<app>GrantRequest``. None when the data
    holds none, or more than one. Whether what it holds has the shape of a
    request is grant_request_fault's to say."""
    found = _members_of(data, GRANT_REQUEST_SUFFIX)
    return (found[0][0], found[0][2]) if len(found) == 1 else None


def grant_in(data: Any) -> tuple[str, str, dict[str, Any]] | None:
    """The grant an asset's data holds, as the app it names, the member it is
    and the grant: the one member named ``<app>Grant`` whose value is an
    object with a string ``client``. None when the data holds none, or more
    than one."""
    found = [
        found
        for found in _members_of(data, GRANT_SUFFIX)
        if isinstance(found[2], dict) and isinstance(found[2].get("client"), str)
    ]
    return found[0] if len(found) == 1 else None


def grant_member(app: str) -> str:
    """The name of the member of an asset's data that holds an app's grant."""
    return app + GRANT_SUFFIX


MAX_SAFE_INTEGER = 2**53 - 1


def grant_request_of(doc: dict[str, Any]) -> dict[str, Any]:
    """The app, the client and the request of a grant request, from the request
    as a node resolves it: ``did``, ``app``, ``client`` and ``request``, or
    ``refused`` with why (``deleted``, ``not-an-asset``, ``changed``,
    ``not-a-request``, ``invalid``) and, for ``invalid``, the ``fault``.

    Who asks is the request's controller, and only while the request is as it
    was created. An asset's owner can transfer it to any identity, which signs
    nothing, and can replace its contents first. The creation is signed by its
    controller and holds the contents that controller gave it, so a request
    that has had any version after its first does not say who asks for what it
    holds. Nothing in the data is read for who asks.
    """
    document = doc.get("didDocument") or {}
    metadata = doc.get("didDocumentMetadata") or {}
    did, client = document.get("id"), document.get("controller")
    if metadata.get("deactivated"):
        return {"refused": "deleted"}
    if (doc.get("didDocumentRegistration") or {}).get("type") != "asset" or not did or not client:
        return {"refused": "not-an-asset"}
    if str(metadata.get("versionSequence")) != "1":
        return {"refused": "changed"}

    held = grant_request_in(doc.get("didDocumentData"))
    if held is None:
        return {"refused": "not-a-request"}
    app, request = held
    fault = grant_request_fault(request)
    if fault:
        return {"refused": "invalid", "fault": fault}
    return {"did": did, "app": app, "client": client, "request": request}


def anchored_on(doc: dict[str, Any], registry: str) -> bool:
    """Whether a resolved version is anchored on a registry: it names that
    registry as its chain and has the height and time of a block. ``confirmed``
    is not that, since a creation is confirmed from the start.
    """
    timestamp = (doc.get("didDocumentMetadata") or {}).get("timestamp")
    timestamp = timestamp if isinstance(timestamp, dict) else {}
    upper_bound = timestamp.get("upperBound")
    upper_bound = upper_bound if isinstance(upper_bound, dict) else {}
    height = upper_bound.get("height")
    return (
        timestamp.get("chain") == registry
        and isinstance(height, int)
        and not isinstance(height, bool)
        and abs(height) <= MAX_SAFE_INTEGER
        and isinstance(upper_bound.get("timeISO"), str)
    )
