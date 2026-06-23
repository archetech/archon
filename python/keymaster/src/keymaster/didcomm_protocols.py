"""DIDComm v2 application-protocol message builders (Python port of
didcomm-protocols.ts). These produce the plaintext DIDComm message (type + body,
optional thid for responses) that is then packed/sent. Pure functions."""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import unquote

TRUST_PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping"
TRUST_PING_RESPONSE_TYPE = "https://didcomm.org/trust-ping/2.0/ping-response"
BASIC_MESSAGE_TYPE = "https://didcomm.org/basicmessage/2.0/message"
DISCOVER_FEATURES_QUERIES_TYPE = "https://didcomm.org/discover-features/2.0/queries"
DISCOVER_FEATURES_DISCLOSE_TYPE = "https://didcomm.org/discover-features/2.0/disclose"
OUT_OF_BAND_INVITATION_TYPE = "https://didcomm.org/out-of-band/2.0/invitation"

ISSUE_CREDENTIAL_PROPOSE_TYPE = "https://didcomm.org/issue-credential/3.0/propose-credential"
ISSUE_CREDENTIAL_OFFER_TYPE = "https://didcomm.org/issue-credential/3.0/offer-credential"
ISSUE_CREDENTIAL_REQUEST_TYPE = "https://didcomm.org/issue-credential/3.0/request-credential"
ISSUE_CREDENTIAL_TYPE = "https://didcomm.org/issue-credential/3.0/issue-credential"
PRESENT_PROOF_PROPOSE_TYPE = "https://didcomm.org/present-proof/3.0/propose-presentation"
PRESENT_PROOF_REQUEST_TYPE = "https://didcomm.org/present-proof/3.0/request-presentation"
PRESENT_PROOF_PRESENTATION_TYPE = "https://didcomm.org/present-proof/3.0/presentation"

VC_ATTACHMENT_FORMAT = "aries/ld-proof-vc@v1.0"
VP_ATTACHMENT_FORMAT = "dif/presentation-exchange/submission@v1.0"

MEDIATE_REQUEST_TYPE = "https://didcomm.org/coordinate-mediation/2.0/mediate-request"
MEDIATE_GRANT_TYPE = "https://didcomm.org/coordinate-mediation/2.0/mediate-grant"
MEDIATE_DENY_TYPE = "https://didcomm.org/coordinate-mediation/2.0/mediate-deny"
KEYLIST_UPDATE_TYPE = "https://didcomm.org/coordinate-mediation/2.0/keylist-update"
KEYLIST_UPDATE_RESPONSE_TYPE = "https://didcomm.org/coordinate-mediation/2.0/keylist-update-response"
KEYLIST_QUERY_TYPE = "https://didcomm.org/coordinate-mediation/2.0/keylist-query"
KEYLIST_TYPE = "https://didcomm.org/coordinate-mediation/2.0/keylist"


def _with_thid(message: dict[str, Any], thid: str | None) -> dict[str, Any]:
    if thid:
        message["thid"] = thid
    return message


# --- Trust Ping / Basic Message / Discover Features / Out-of-Band -----------

def trust_ping(response_requested: bool = True) -> dict[str, Any]:
    return {"type": TRUST_PING_TYPE, "body": {"response_requested": response_requested}}


def trust_ping_response(thid: str) -> dict[str, Any]:
    return {"type": TRUST_PING_RESPONSE_TYPE, "thid": thid, "body": {}}


def basic_message(content: str) -> dict[str, Any]:
    return {"type": BASIC_MESSAGE_TYPE, "body": {"content": content}}


def discover_features_query(match: str = "*") -> dict[str, Any]:
    return {"type": DISCOVER_FEATURES_QUERIES_TYPE, "body": {"queries": [{"feature-type": "protocol", "match": match}]}}


def discover_features_disclose(thid: str, protocol_ids: list[str]) -> dict[str, Any]:
    return {
        "type": DISCOVER_FEATURES_DISCLOSE_TYPE,
        "thid": thid,
        "body": {"disclosures": [{"feature-type": "protocol", "id": pid} for pid in protocol_ids]},
    }


def out_of_band_invitation(from_did: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"type": OUT_OF_BAND_INVITATION_TYPE, "from": from_did, "body": {"accept": ["didcomm/v2"], **(body or {})}}


def _to_base64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).rstrip(b"=").decode("ascii")


def _from_base64url(value: str) -> str:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii")).decode("utf-8")


def encode_out_of_band_invitation(invitation: dict[str, Any], base: str = "https://didcomm.org") -> str:
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}_oob={_to_base64url(json.dumps(invitation, separators=(',', ':')))}"


def decode_out_of_band_invitation(url_or_oob: str) -> dict[str, Any]:
    import re

    match = re.search(r"[?&]_oob=([^&]+)", url_or_oob)
    oob = unquote(match.group(1)) if match else url_or_oob
    return json.loads(_from_base64url(oob))


# --- Issue Credential 3.0 / Present Proof 3.0 -------------------------------

def _json_attachment(attach_id: str, attach_format: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"id": attach_id, "media_type": "application/json", "format": attach_format, "data": {"json": payload}}


def offer_credential(comment: str | None = None) -> dict[str, Any]:
    return {"type": ISSUE_CREDENTIAL_OFFER_TYPE, "body": {"comment": comment} if comment else {}}


def request_credential(thid: str | None = None, comment: str | None = None) -> dict[str, Any]:
    return _with_thid({"type": ISSUE_CREDENTIAL_REQUEST_TYPE, "body": {"comment": comment} if comment else {}}, thid)


def issue_credential_message(credential: dict[str, Any], thid: str | None = None, comment: str | None = None) -> dict[str, Any]:
    attach_id = "vc-1"
    body: dict[str, Any] = {"formats": [{"attach_id": attach_id, "format": VC_ATTACHMENT_FORMAT}]}
    if comment:
        body = {"comment": comment, **body}
    return _with_thid(
        {"type": ISSUE_CREDENTIAL_TYPE, "body": body, "attachments": [_json_attachment(attach_id, VC_ATTACHMENT_FORMAT, credential)]},
        thid,
    )


def request_presentation(comment: str | None = None) -> dict[str, Any]:
    return {"type": PRESENT_PROOF_REQUEST_TYPE, "body": {"comment": comment} if comment else {}}


def presentation_message(presentation: dict[str, Any], thid: str | None = None, comment: str | None = None) -> dict[str, Any]:
    attach_id = "vp-1"
    body: dict[str, Any] = {"formats": [{"attach_id": attach_id, "format": VP_ATTACHMENT_FORMAT}]}
    if comment:
        body = {"comment": comment, **body}
    return _with_thid(
        {"type": PRESENT_PROOF_PRESENTATION_TYPE, "body": body, "attachments": [_json_attachment(attach_id, VP_ATTACHMENT_FORMAT, presentation)]},
        thid,
    )


def attached_json(message: dict[str, Any], index: int = 0) -> Any:
    attachments = message.get("attachments") if isinstance(message, dict) else None
    if not attachments or index >= len(attachments):
        return None
    return attachments[index].get("data", {}).get("json")


# --- Coordinate Mediation 2.0 ----------------------------------------------

def mediate_request() -> dict[str, Any]:
    return {"type": MEDIATE_REQUEST_TYPE, "body": {}}


def mediate_grant(routing_did: str, thid: str | None = None) -> dict[str, Any]:
    return _with_thid({"type": MEDIATE_GRANT_TYPE, "body": {"routing_did": routing_did}}, thid)


def mediate_deny(thid: str | None = None) -> dict[str, Any]:
    return _with_thid({"type": MEDIATE_DENY_TYPE, "body": {}}, thid)


def keylist_update(recipient_dids: list[str], action: str = "add") -> dict[str, Any]:
    return {"type": KEYLIST_UPDATE_TYPE, "body": {"updates": [{"recipient_did": did, "action": action} for did in recipient_dids]}}


def keylist_update_response(updated: list[dict[str, Any]], thid: str | None = None) -> dict[str, Any]:
    return _with_thid({"type": KEYLIST_UPDATE_RESPONSE_TYPE, "body": {"updated": updated}}, thid)


def keylist_query() -> dict[str, Any]:
    return {"type": KEYLIST_QUERY_TYPE, "body": {}}


def keylist(recipient_dids: list[str], thid: str | None = None) -> dict[str, Any]:
    return _with_thid({"type": KEYLIST_TYPE, "body": {"keys": [{"recipient_did": did} for did in recipient_dids]}}, thid)
