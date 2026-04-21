from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from typing import Any

from keymaster import Keymaster


MOCK_JSON = {
    "key": "value",
    "list": [1, 2, 3],
    "obj": {"name": "some object"},
}

MOCK_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "email": {"type": "string", "format": "email"},
    },
    "required": ["email"],
}


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class FakeWalletStore:
    def __init__(self) -> None:
        self.wallet: dict[str, Any] | None = None

    def save_wallet(self, wallet: dict[str, Any], overwrite: bool = False) -> bool:
        if self.wallet is not None and not overwrite:
            return False
        self.wallet = deepcopy(wallet)
        return True

    def load_wallet(self) -> dict[str, Any] | None:
        return deepcopy(self.wallet)


class FakeGatekeeper:
    def __init__(self, registries: list[str] | None = None) -> None:
        self.registries = registries or ["local", "hyperswarm", "BTC:signet"]
        self.docs: dict[str, dict[str, Any]] = {}
        self._counter = 0
        self._operation_dids: dict[str, str] = {}

    async def list_registries(self) -> list[str]:
        return list(self.registries)

    async def get_block(self, registry: str, block: str | None = None) -> dict[str, Any] | None:
        _ = block
        if registry not in self.registries:
            return None
        return {"hash": f"block-{registry}"}

    async def create_did(self, operation: dict[str, Any]) -> str:
        operation_payload = {key: value for key, value in operation.items() if key != "proof"}
        operation_key = hashlib.sha256(
            json.dumps(operation_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        did = self._operation_dids.get(operation_key)
        if did is not None and did in self.docs:
            return did

        self._counter += 1
        did = f"did:test:{self._counter:04d}"
        self._operation_dids[operation_key] = did
        registration = deepcopy(operation["registration"])

        if registration.get("type") == "agent":
            did_document = {
                "id": did,
                "verificationMethod": [
                    {
                        "id": "#key-1",
                        "controller": did,
                        "publicKeyJwk": deepcopy(operation["publicJwk"]),
                    }
                ],
                "authentication": ["#key-1"],
                "assertionMethod": ["#key-1"],
            }
            did_document_data: dict[str, Any] = {}
        else:
            did_document = {
                "id": did,
                "controller": operation["controller"],
            }
            did_document_data = deepcopy(operation.get("data") or {})

        self.docs[did] = {
            "didResolutionMetadata": {},
            "didDocument": did_document,
            "didDocumentData": did_document_data,
            "didDocumentMetadata": {
                "created": operation.get("created") or datetime.now(timezone.utc).isoformat(),
                "versionId": f"{did}#1",
                "versionSequence": 1,
                "deactivated": False,
            },
            "didDocumentRegistration": registration,
        }

        return did

    async def resolve_did(self, did: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        _ = options
        if did not in self.docs:
            return {
                "didResolutionMetadata": {"error": "notFound"},
                "didDocumentMetadata": {},
            }
        return deepcopy(self.docs[did])

    async def update_did(self, operation: dict[str, Any]) -> bool:
        did = operation["did"]
        current = deepcopy(self.docs[did])
        doc_update = deepcopy(operation.get("doc") or {})

        if "didDocument" in doc_update:
            current["didDocument"] = deepcopy(doc_update["didDocument"])
        elif any(key in doc_update for key in ("id", "controller", "verificationMethod", "authentication", "assertionMethod")):
            current["didDocument"] = deepcopy(doc_update)

        if "didDocumentData" in doc_update:
            current["didDocumentData"] = deepcopy(doc_update["didDocumentData"])
        elif any(key in doc_update for key in ("schema", "group", "encrypted", "challenge", "backup", "name")):
            current["didDocumentData"] = deepcopy(doc_update)

        if "didDocumentRegistration" in doc_update:
            current["didDocumentRegistration"] = deepcopy(doc_update["didDocumentRegistration"])

        if "didDocumentMetadata" in doc_update:
            metadata = deepcopy(doc_update["didDocumentMetadata"])
            metadata.setdefault("deactivated", current["didDocumentMetadata"].get("deactivated", False))
            current["didDocumentMetadata"] = metadata

        next_sequence = current["didDocumentMetadata"].get("versionSequence", 1) + 1
        current["didDocumentMetadata"]["versionSequence"] = next_sequence
        current["didDocumentMetadata"]["versionId"] = f"{did}#{next_sequence}"
        current["didDocumentMetadata"].setdefault("created", datetime.now(timezone.utc).isoformat())

        self.docs[did] = current
        return True

    async def delete_did(self, operation: dict[str, Any]) -> bool:
        did = operation["did"]
        current = deepcopy(self.docs[did])
        next_sequence = current["didDocumentMetadata"].get("versionSequence", 1) + 1
        current["didDocumentMetadata"]["versionSequence"] = next_sequence
        current["didDocumentMetadata"]["versionId"] = f"{did}#{next_sequence}"
        current["didDocumentMetadata"]["deactivated"] = True
        self.docs[did] = current
        return True

    async def search(self, query: dict[str, Any]) -> list[str]:
        where = query.get("where") or {}
        clause = where.get("notice.to[*]") or {}
        recipients = clause.get("$in") or []
        if not recipients:
            return []

        matches: list[str] = []
        for did, doc in self.docs.items():
            notice = (doc.get("didDocumentData") or {}).get("notice")
            if not isinstance(notice, dict):
                continue

            to_list = notice.get("to") or []
            if any(recipient in to_list for recipient in recipients):
                matches.append(did)

        return matches


@dataclass
class TestBed:
    keymaster: Keymaster
    gatekeeper: FakeGatekeeper
    wallet_store: FakeWalletStore


def make_testbed(passphrase: str = "passphrase") -> TestBed:
    gatekeeper = FakeGatekeeper()
    wallet_store = FakeWalletStore()
    keymaster = Keymaster(gatekeeper=gatekeeper, wallet_store=wallet_store, passphrase=passphrase)
    return TestBed(keymaster=keymaster, gatekeeper=gatekeeper, wallet_store=wallet_store)