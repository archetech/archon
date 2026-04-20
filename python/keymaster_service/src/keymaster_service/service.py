from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import logging
from typing import Any

from .config import Settings
from .crypto import (
    decrypt_message,
    decrypt_with_passphrase,
    derive_private_key_bytes,
    encrypt_message,
    encrypt_with_passphrase,
    generate_mnemonic,
    hash_json,
    hd_root_from_mnemonic,
    private_key_to_jwk_pair,
    sign_hash,
    ub64url,
    b64url,
    verify_sig,
)
from .gatekeeper_client import GatekeeperClient
from .wallet_store import JsonWalletStore


LOGGER = logging.getLogger(__name__)

DEFAULT_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {"propertyName": {"type": "string"}},
    "required": ["propertyName"],
}


class KeymasterServiceError(Exception):
    pass


class UnknownIDError(KeymasterServiceError):
    pass


class KeymasterService:
    def __init__(self, settings: Settings, gatekeeper: GatekeeperClient, wallet_store: JsonWalletStore):
        self.settings = settings
        self.gatekeeper = gatekeeper
        self.wallet_store = wallet_store
        self.default_registry = settings.default_registry or "hyperswarm"
        self.ephemeral_registry = "hyperswarm"
        self.max_alias_length = 32
        self._wallet_cache: dict[str, Any] | None = None
        self._root_cache = None
        self._lock = asyncio.Lock()
        self.server_ready = False

    async def startup(self) -> None:
        if self.settings.keymaster_db != "json":
            raise KeymasterServiceError(f"Unsupported ARCHON_KEYMASTER_DB for Python service: {self.settings.keymaster_db}")

        await self.gatekeeper.connect(wait_until_ready=True, interval_seconds=5)
        await self.load_wallet()
        try:
            await self.wait_for_node_id()
            self.server_ready = True
        except Exception:
            LOGGER.exception("Failed to wait for node ID")

    async def shutdown(self) -> None:
        await self.gatekeeper.close()

    async def wait_for_node_id(self) -> None:
        if not self.settings.node_id:
            raise KeymasterServiceError("ARCHON_NODE_ID is not set in the configuration.")

        ids = await self.list_ids()
        if self.settings.node_id not in ids:
            await self.create_id(self.settings.node_id)
            LOGGER.info("Created node ID '%s'", self.settings.node_id)

        while True:
            try:
                await self.resolve_did(self.settings.node_id)
                return
            except Exception:
                await asyncio.sleep(10)

    def _upgrade_wallet(self, wallet: dict[str, Any]) -> dict[str, Any]:
        upgraded = deepcopy(wallet)
        upgraded.setdefault("version", 2)
        upgraded.setdefault("seed", {})
        upgraded.setdefault("counter", 0)
        upgraded.setdefault("ids", {})
        upgraded.setdefault("aliases", {})
        return upgraded

    async def _save_loaded_wallet(self, wallet: dict[str, Any], overwrite: bool = True) -> bool:
        stored = await self.encrypt_wallet_for_storage(wallet)
        ok = self.wallet_store.save_wallet(stored, overwrite=overwrite)
        if ok:
            self._wallet_cache = wallet
        return ok

    async def load_wallet(self) -> dict[str, Any]:
        if self._wallet_cache is not None:
            return self._wallet_cache

        stored = self.wallet_store.load_wallet()
        if stored is None:
            stored = await self.new_wallet()

        decrypted = await self.decrypt_wallet(stored)
        self._wallet_cache = self._upgrade_wallet(decrypted)
        return self._wallet_cache

    async def save_wallet(self, wallet: dict[str, Any], overwrite: bool = True) -> bool:
        decrypted = await self.decrypt_wallet(wallet)
        upgraded = self._upgrade_wallet(decrypted)
        return await self._save_loaded_wallet(upgraded, overwrite=overwrite)

    async def new_wallet(self, mnemonic: str | None = None, overwrite: bool = False) -> dict[str, Any]:
        if not mnemonic:
            mnemonic = generate_mnemonic()

        try:
            self._root_cache = hd_root_from_mnemonic(mnemonic)
        except Exception as exc:
            raise KeymasterServiceError("Invalid parameter: mnemonic") from exc

        wallet = {
            "version": 2,
            "seed": {"mnemonicEnc": encrypt_with_passphrase(mnemonic, self.settings.passphrase)},
            "counter": 0,
            "ids": {},
            "aliases": {},
        }
        ok = await self.save_wallet(wallet, overwrite=overwrite)
        if not ok:
            raise KeymasterServiceError("save wallet failed")
        return wallet

    async def decrypt_wallet(self, stored: dict[str, Any]) -> dict[str, Any]:
        if "enc" not in stored:
            return self._upgrade_wallet(stored)

        seed = stored.get("seed", {})
        mnemonic = decrypt_with_passphrase(seed["mnemonicEnc"], self.settings.passphrase)
        self._root_cache = hd_root_from_mnemonic(mnemonic)
        root_pair = await self.hd_key_pair()
        plaintext = decrypt_message(root_pair["privateJwk"], stored["enc"])
        rest = json.loads(plaintext)
        return {"version": stored.get("version", 2), "seed": seed, **rest}

    async def encrypt_wallet_for_storage(self, wallet: dict[str, Any]) -> dict[str, Any]:
        root_pair = await self.hd_key_pair(wallet)
        rest = {key: value for key, value in wallet.items() if key not in {"version", "seed"}}
        enc = encrypt_message(root_pair["publicJwk"], json.dumps(rest, separators=(",", ":")))
        return {"version": wallet.get("version", 2), "seed": wallet["seed"], "enc": enc}

    async def decrypt_mnemonic(self) -> str:
        wallet = await self.load_wallet()
        return decrypt_with_passphrase(wallet["seed"]["mnemonicEnc"], self.settings.passphrase)

    async def _root_node(self, wallet: dict[str, Any] | None = None):
        if self._root_cache is not None:
            return self._root_cache
        if wallet is None:
            wallet = await self.load_wallet()
        mnemonic = decrypt_with_passphrase(wallet["seed"]["mnemonicEnc"], self.settings.passphrase)
        self._root_cache = hd_root_from_mnemonic(mnemonic)
        return self._root_cache

    async def hd_key_pair(self, wallet: dict[str, Any] | None = None) -> dict[str, dict[str, str]]:
        root = await self._root_node(wallet)
        return private_key_to_jwk_pair(root.PrivateKey().Raw().ToBytes())

    async def derive_key_pair(self, account: int, index: int, wallet: dict[str, Any] | None = None) -> dict[str, dict[str, str]]:
        root = await self._root_node(wallet)
        path = f"m/44'/0'/{account}'/0/{index}"
        return private_key_to_jwk_pair(derive_private_key_bytes(root, path))

    def did_match(self, did1: str, did2: str) -> bool:
        return did1.split(":")[-1] == did2.split(":")[-1]

    def validate_alias(self, alias: str, wallet: dict[str, Any], label: str = "name") -> str:
        if not isinstance(alias, str) or not alias.strip():
            raise KeymasterServiceError(f"Invalid parameter: {label} must be a non-empty string")
        alias = alias.strip()
        if len(alias) > self.max_alias_length:
            raise KeymasterServiceError(f"Invalid parameter: {label} too long")
        if alias in wallet.get("aliases", {}) or alias in wallet.get("ids", {}):
            raise KeymasterServiceError(f"Invalid parameter: {label} already used")
        return alias

    async def fetch_id_info(self, identifier: str | None = None, wallet: dict[str, Any] | None = None) -> dict[str, Any]:
        if wallet is None:
            wallet = await self.load_wallet()

        id_info = None
        if identifier:
            if identifier.startswith("did"):
                for info in wallet["ids"].values():
                    if self.did_match(identifier, info["did"]):
                        id_info = info
                        break
            else:
                id_info = wallet["ids"].get(identifier)
        else:
            current = wallet.get("current")
            if not current:
                raise KeymasterServiceError("No current ID")
            id_info = wallet["ids"].get(current)

        if not id_info:
            raise UnknownIDError("Unknown ID")
        return id_info

    async def id_in_wallet(self, did: str | None) -> bool:
        if not did:
            return False
        try:
            await self.fetch_id_info(did)
            return True
        except Exception:
            return False

    async def lookup_did(self, name: str) -> str:
        if name.startswith("did:"):
            return name
        wallet = await self.load_wallet()
        aliases = wallet.get("aliases", {})
        if name in aliases:
            return aliases[name]
        if name in wallet["ids"]:
            return wallet["ids"][name]["did"]
        return name

    async def resolve_did(self, name: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        actual_did = await self.lookup_did(name)
        docs = await self.gatekeeper.resolve_did(actual_did, options)
        metadata = docs.get("didResolutionMetadata") or {}
        if metadata.get("error"):
            raise KeymasterServiceError(metadata["error"])
        did_metadata = docs.setdefault("didDocumentMetadata", {})
        controller = docs.get("didDocument", {}).get("controller") or docs.get("didDocument", {}).get("id")
        did_metadata["isOwned"] = await self.id_in_wallet(controller)
        version_sequence = did_metadata.get("versionSequence")
        if version_sequence is not None:
            try:
                did_metadata["version"] = int(version_sequence)
            except (TypeError, ValueError):
                pass
        return docs

    async def list_registries(self) -> list[str]:
        return await self.gatekeeper.list_registries()

    async def list_ids(self) -> list[str]:
        wallet = await self.load_wallet()
        return sorted(wallet["ids"].keys())

    async def get_current_id(self) -> str | None:
        wallet = await self.load_wallet()
        return wallet.get("current") or None

    async def set_current_id(self, name: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            if name not in wallet["ids"]:
                raise UnknownIDError("Unknown ID")
            wallet["current"] = name
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def create_id_operation(self, name: str, account: int = 0, options: dict[str, Any] | None = None) -> dict[str, Any]:
        wallet = await self.load_wallet()
        options = options or {}
        registry = options.get("registry", self.default_registry)
        self.validate_alias(name, wallet)
        keypair = await self.derive_key_pair(account, 0, wallet)
        block = await self.gatekeeper.get_block(registry)
        operation = {
            "type": "create",
            "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "blockid": block.get("hash") if block else None,
            "registration": {"version": 1, "type": "agent", "registry": registry},
            "publicJwk": keypair["publicJwk"],
        }
        if operation["blockid"] is None:
            operation.pop("blockid")
        signature_hex = sign_hash(hash_json(operation), keypair["privateJwk"])
        operation["proof"] = {
            "type": "EcdsaSecp256k1Signature2019",
            "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "verificationMethod": "#key-1",
            "proofPurpose": "authentication",
            "proofValue": b64url(bytes.fromhex(signature_hex)),
        }
        return operation

    async def create_id(self, name: str, options: dict[str, Any] | None = None) -> str:
        async with self._lock:
            wallet = await self.load_wallet()
            name = self.validate_alias(name, wallet)
            account = wallet["counter"]
            signed = await self.create_id_operation(name, account, options or {})
            did = await self.gatekeeper.create_did(signed)
            wallet["ids"][name] = {"did": did, "account": account, "index": 0}
            wallet["counter"] += 1
            wallet["current"] = name
            await self._save_loaded_wallet(wallet, overwrite=True)
            return did

    async def remove_id(self, name: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            if name not in wallet["ids"]:
                raise UnknownIDError("Unknown ID")
            del wallet["ids"][name]
            if wallet.get("current") == name:
                wallet["current"] = next(iter(wallet["ids"].keys()), "")
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def rename_id(self, identifier: str, name: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            if identifier not in wallet["ids"]:
                raise UnknownIDError("Unknown ID")
            name = self.validate_alias(name, wallet)
            wallet["ids"][name] = wallet["ids"][identifier]
            del wallet["ids"][identifier]
            if wallet.get("current") == identifier:
                wallet["current"] = name
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def add_alias(self, alias: str, did: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            alias = self.validate_alias(alias, wallet, "alias")
            wallet.setdefault("aliases", {})[alias] = await self.lookup_did(did)
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def list_aliases(self) -> dict[str, str]:
        wallet = await self.load_wallet()
        return wallet.get("aliases", {})

    async def get_alias(self, alias: str) -> str | None:
        wallet = await self.load_wallet()
        return wallet.get("aliases", {}).get(alias)

    async def remove_alias(self, alias: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            wallet.setdefault("aliases", {}).pop(alias, None)
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def fetch_key_pair(self, name: str | None = None) -> dict[str, dict[str, str]] | None:
        wallet = await self.load_wallet()
        id_info = await self.fetch_id_info(name, wallet)
        return await self.derive_key_pair(id_info["account"], id_info.get("index", 0), wallet)

    async def add_proof(self, payload: dict[str, Any], controller: str | None = None, proof_purpose: str = "assertionMethod") -> dict[str, Any]:
        id_info = await self.fetch_id_info(controller)
        keypair = await self.fetch_key_pair(controller)
        if not keypair:
            raise KeymasterServiceError("addProof: no keypair")
        doc = await self.resolve_did(id_info["did"], {"confirm": "true"})
        verification_methods = doc.get("didDocument", {}).get("verificationMethod") or []
        key_fragment = verification_methods[0].get("id", "#key-1") if verification_methods else "#key-1"
        signature_hex = sign_hash(hash_json(payload), keypair["privateJwk"])
        return {
            **payload,
            "proof": {
                "type": "EcdsaSecp256k1Signature2019",
                "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "verificationMethod": f"{id_info['did']}{key_fragment}",
                "proofPurpose": proof_purpose,
                "proofValue": b64url(bytes.fromhex(signature_hex)),
            },
        }

    async def verify_proof(self, payload: dict[str, Any]) -> bool:
        proof = payload.get("proof")
        if not proof:
            return False
        unsigned = deepcopy(payload)
        unsigned.pop("proof", None)
        verification_method = proof.get("verificationMethod", "")
        signer_did = verification_method.split("#")[0]
        if not signer_did:
            return False
        doc = await self.resolve_did(signer_did, {"confirm": "true", "versionTime": proof.get("created")})
        verification_methods = doc.get("didDocument", {}).get("verificationMethod") or []
        public_jwk = verification_methods[0].get("publicKeyJwk") if verification_methods else None
        if not public_jwk:
            return False
        return verify_sig(hash_json(unsigned), ub64url(proof["proofValue"]).hex(), public_jwk)

    async def update_did(self, identifier: str, doc: dict[str, Any]) -> bool:
        did = await self.lookup_did(identifier)
        current = await self.resolve_did(did)
        registry = current.get("didDocumentRegistration", {}).get("registry")
        block = await self.gatekeeper.get_block(registry) if registry else None
        payload = {
            "type": "update",
            "did": did,
            "previd": current.get("didDocumentMetadata", {}).get("versionId"),
            "doc": {k: v for k, v in doc.items() if k not in {"didDocumentMetadata", "didResolutionMetadata"}},
        }
        if block and block.get("hash"):
            payload["blockid"] = block["hash"]
        controller = current.get("didDocument", {}).get("id")
        if current.get("didDocumentRegistration", {}).get("type") == "asset":
            controller = current.get("didDocument", {}).get("controller")
        signed = await self.add_proof(payload, controller, "authentication")
        return await self.gatekeeper.update_did(signed)

    async def revoke_did(self, identifier: str) -> bool:
        did = await self.lookup_did(identifier)
        current = await self.resolve_did(did)
        registry = current.get("didDocumentRegistration", {}).get("registry")
        block = await self.gatekeeper.get_block(registry) if registry else None
        payload = {
            "type": "delete",
            "did": did,
            "previd": current.get("didDocumentMetadata", {}).get("versionId"),
        }
        if block and block.get("hash"):
            payload["blockid"] = block["hash"]
        controller = current.get("didDocument", {}).get("id")
        if current.get("didDocumentRegistration", {}).get("type") == "asset":
            controller = current.get("didDocument", {}).get("controller")
        signed = await self.add_proof(payload, controller, "authentication")
        ok = await self.gatekeeper.delete_did(signed)
        if ok and current.get("didDocument", {}).get("controller"):
            await self.remove_from_owned(did, current["didDocument"]["controller"])
        return ok

    async def add_to_owned(self, did: str, owner: str | None = None) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            id_info = await self.fetch_id_info(owner, wallet)
            id_info.setdefault("owned", [])
            if did not in id_info["owned"]:
                id_info["owned"].append(did)
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def remove_from_owned(self, did: str, owner: str | None = None) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            try:
                id_info = await self.fetch_id_info(owner, wallet)
            except Exception:
                return True
            id_info.setdefault("owned", [])
            id_info["owned"] = [item for item in id_info["owned"] if item != did]
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def list_assets(self, owner: str | None = None) -> list[str]:
        id_info = await self.fetch_id_info(owner)
        return id_info.get("owned", [])

    async def create_asset(self, data: Any, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        registry = options.get("registry", self.default_registry)
        controller = options.get("controller")
        valid_until = options.get("validUntil")
        alias = options.get("alias")
        id_info = await self.fetch_id_info(controller)
        block = await self.gatekeeper.get_block(registry)
        payload = {
            "type": "create",
            "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "registration": {"version": 1, "type": "asset", "registry": registry},
            "controller": id_info["did"],
            "data": data,
        }
        if valid_until:
            payload["registration"]["validUntil"] = valid_until
        if block and block.get("hash"):
            payload["blockid"] = block["hash"]
        signed = await self.add_proof(payload, controller, "authentication")
        did = await self.gatekeeper.create_did(signed)
        if not valid_until:
            await self.add_to_owned(did, controller)
        if alias:
            await self.add_alias(alias, did)
        return did

    async def resolve_asset(self, did: str, options: dict[str, Any] | None = None) -> Any:
        doc = await self.resolve_did(did, options)
        if doc.get("didDocumentMetadata", {}).get("deactivated"):
            return {}
        return doc.get("didDocumentData") or {}

    async def merge_data(self, did: str, data: dict[str, Any]) -> bool:
        current = await self.resolve_asset(did)
        updated = {**current, **data}
        updated = {key: value for key, value in updated.items() if value is not None}
        return await self.update_did(did, {"didDocumentData": updated})

    async def test_agent(self, identifier: str) -> bool:
        try:
            doc = await self.resolve_did(identifier)
            return doc.get("didDocumentRegistration", {}).get("type") == "agent"
        except Exception:
            return False

    async def check_wallet(self) -> dict[str, int]:
        wallet = await self.load_wallet()
        checked = 0
        invalid = 0
        deleted = 0
        await self.resolve_seed_bank()

        for name, info in wallet["ids"].items():
            try:
                doc = await self.resolve_did(info["did"])
                if doc.get("didDocumentMetadata", {}).get("deactivated"):
                    deleted += 1
            except Exception:
                invalid += 1
            checked += 1

        for alias, did in wallet.get("aliases", {}).items():
            _ = alias
            try:
                doc = await self.resolve_did(did)
                if doc.get("didDocumentMetadata", {}).get("deactivated"):
                    deleted += 1
            except Exception:
                invalid += 1
            checked += 1

        return {"checked": checked, "invalid": invalid, "deleted": deleted}

    async def fix_wallet(self) -> dict[str, int]:
        ids_removed = 0
        owned_removed = 0
        held_removed = 0
        aliases_removed = 0
        async with self._lock:
            wallet = await self.load_wallet()
            for name in list(wallet["ids"].keys()):
                try:
                    doc = await self.resolve_did(wallet["ids"][name]["did"])
                    if doc.get("didDocumentMetadata", {}).get("deactivated"):
                        raise KeymasterServiceError("deactivated")
                except Exception:
                    del wallet["ids"][name]
                    ids_removed += 1

            for id_info in wallet["ids"].values():
                for field in ("owned", "held"):
                    items = list(id_info.get(field, []))
                    kept = []
                    for did in items:
                        try:
                            doc = await self.resolve_did(did)
                            if doc.get("didDocumentMetadata", {}).get("deactivated"):
                                raise KeymasterServiceError("deactivated")
                            kept.append(did)
                        except Exception:
                            if field == "owned":
                                owned_removed += 1
                            else:
                                held_removed += 1
                    if items:
                        id_info[field] = kept

            for alias, did in list(wallet.get("aliases", {}).items()):
                try:
                    doc = await self.resolve_did(did)
                    if doc.get("didDocumentMetadata", {}).get("deactivated"):
                        raise KeymasterServiceError("deactivated")
                except Exception:
                    del wallet["aliases"][alias]
                    aliases_removed += 1

            await self._save_loaded_wallet(wallet, overwrite=True)
        return {
            "idsRemoved": ids_removed,
            "ownedRemoved": owned_removed,
            "heldRemoved": held_removed,
            "aliasesRemoved": aliases_removed,
        }

    async def resolve_seed_bank(self) -> dict[str, Any]:
        keypair = await self.hd_key_pair()
        operation = {
            "type": "create",
            "created": "1970-01-01T00:00:00.000Z",
            "registration": {"version": 1, "type": "agent", "registry": self.default_registry},
            "publicJwk": keypair["publicJwk"],
        }
        signature_hex = sign_hash(hash_json(operation), keypair["privateJwk"])
        signed = {
            **operation,
            "proof": {
                "type": "EcdsaSecp256k1Signature2019",
                "created": "1970-01-01T00:00:00.000Z",
                "verificationMethod": "#key-1",
                "proofPurpose": "authentication",
                "proofValue": b64url(bytes.fromhex(signature_hex)),
            },
        }
        did = await self.gatekeeper.create_did(signed)
        return await self.gatekeeper.resolve_did(did)

    async def update_seed_bank(self, doc: dict[str, Any]) -> bool:
        keypair = await self.hd_key_pair()
        did = doc.get("didDocument", {}).get("id")
        if not did:
            raise KeymasterServiceError("seed bank missing DID")
        current = await self.gatekeeper.resolve_did(did)
        payload = {
            "type": "update",
            "did": did,
            "previd": current.get("didDocumentMetadata", {}).get("versionId"),
            "doc": doc,
        }
        signature_hex = sign_hash(hash_json(payload), keypair["privateJwk"])
        signed = {
            **payload,
            "proof": {
                "type": "EcdsaSecp256k1Signature2019",
                "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "verificationMethod": f"{did}#key-1",
                "proofPurpose": "authentication",
                "proofValue": b64url(bytes.fromhex(signature_hex)),
            },
        }
        return await self.gatekeeper.update_did(signed)

    async def backup_wallet(self, registry: str | None = None, wallet: dict[str, Any] | None = None) -> str:
        if wallet is None:
            wallet = await self.load_wallet()
        registry = registry or self.default_registry
        keypair = await self.hd_key_pair(wallet)
        seed_bank = await self.resolve_seed_bank()
        backup = encrypt_message(keypair["publicJwk"], json.dumps(wallet, separators=(",", ":")))
        operation = {
            "type": "create",
            "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "registration": {"version": 1, "type": "asset", "registry": registry},
            "controller": seed_bank.get("didDocument", {}).get("id"),
            "data": {"backup": backup},
        }
        signature_hex = sign_hash(hash_json(operation), keypair["privateJwk"])
        signed = {
            **operation,
            "proof": {
                "type": "EcdsaSecp256k1Signature2019",
                "created": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                "verificationMethod": f"{seed_bank.get('didDocument', {}).get('id')}#key-1",
                "proofPurpose": "authentication",
                "proofValue": b64url(bytes.fromhex(signature_hex)),
            },
        }
        backup_did = await self.gatekeeper.create_did(signed)
        data = seed_bank.get("didDocumentData") or {}
        if isinstance(data, dict):
            data["wallet"] = backup_did
            seed_bank["didDocumentData"] = data
            await self.update_seed_bank(seed_bank)
        return backup_did

    async def recover_wallet(self, did: str | None = None) -> dict[str, Any]:
        if not did:
            seed_bank = await self.resolve_seed_bank()
            did = (seed_bank.get("didDocumentData") or {}).get("wallet")
            if not did:
                raise KeymasterServiceError("No backup DID found")

        keypair = await self.hd_key_pair()
        data = await self.resolve_asset(did)
        backup = data.get("backup")
        if not isinstance(backup, str):
            raise KeymasterServiceError("Asset \"backup\" is missing or not a string")

        wallet = json.loads(decrypt_message(keypair["privateJwk"], backup))
        if isinstance(wallet, dict) and wallet.get("seed", {}).get("mnemonicEnc"):
            mnemonic = await self.decrypt_mnemonic()
            wallet["seed"]["mnemonicEnc"] = encrypt_with_passphrase(mnemonic, self.settings.passphrase)

        async with self._lock:
            upgraded = self._upgrade_wallet(wallet)
            await self._save_loaded_wallet(upgraded, overwrite=True)
        return upgraded

    async def backup_id(self, identifier: str | None = None) -> bool:
        wallet = await self.load_wallet()
        name = identifier or wallet.get("current")
        if not name:
            raise KeymasterServiceError("Invalid parameter: no current ID")
        id_info = await self.fetch_id_info(name, wallet)
        keypair = await self.hd_key_pair(wallet)
        backup = encrypt_message(keypair["publicJwk"], json.dumps({"name": name, "id": id_info}, separators=(",", ":")))
        doc = await self.resolve_did(id_info["did"])
        registry = doc.get("didDocumentRegistration", {}).get("registry")
        if not registry:
            raise KeymasterServiceError("no registry found for agent DID")
        backup_store_did = await self.create_asset({"backup": backup}, {"registry": registry, "controller": name})
        current_data = doc.get("didDocumentData") or {}
        updated_data = {**current_data, "backupStore": backup_store_did}
        return await self.update_did(name, {"didDocumentData": updated_data})

    async def recover_id(self, did: str) -> str:
        keypair = await self.hd_key_pair()
        doc = await self.resolve_did(did)
        backup_store_did = (doc.get("didDocumentData") or {}).get("backupStore")
        if not backup_store_did:
            raise KeymasterServiceError("backup not found in backupStore")
        backup_store = await self.resolve_asset(backup_store_did)
        backup = backup_store.get("backup")
        if not isinstance(backup, str):
            raise KeymasterServiceError("backup not found in backupStore")
        data = json.loads(decrypt_message(keypair["privateJwk"], backup))
        async with self._lock:
            wallet = await self.load_wallet()
            if data["name"] in wallet["ids"]:
                raise KeymasterServiceError(f"{data['name']} already exists in wallet")
            wallet["ids"][data["name"]] = data["id"]
            wallet["current"] = data["name"]
            wallet["counter"] += 1
            await self._save_loaded_wallet(wallet, overwrite=True)
        return data["name"]

    async def rotate_keys(self) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            current_name = wallet.get("current")
            if not current_name:
                raise KeymasterServiceError("No current ID")
            id_info = wallet["ids"][current_name]
            next_index = id_info.get("index", 0) + 1
            keypair = await self.derive_key_pair(id_info["account"], next_index, wallet)
            doc = await self.resolve_did(id_info["did"])
            did_document = doc.get("didDocument") or {}
            verification_methods = did_document.get("verificationMethod") or []
            if not verification_methods:
                raise KeymasterServiceError("DID Document missing verificationMethod")
            updated_method = dict(verification_methods[0])
            updated_method["id"] = f"#key-{next_index + 1}"
            updated_method["publicKeyJwk"] = keypair["publicJwk"]
            updated_doc = {
                **did_document,
                "verificationMethod": [updated_method],
                "authentication": [updated_method["id"]],
                "assertionMethod": [updated_method["id"]],
            }
            ok = await self.update_did(id_info["did"], {"didDocument": updated_doc})
            if ok:
                id_info["index"] = next_index
                await self._save_loaded_wallet(wallet, overwrite=True)
            return ok

    async def get_public_key_jwk(self, doc: dict[str, Any]) -> dict[str, str]:
        methods = doc.get("didDocument", {}).get("verificationMethod") or []
        if not methods or not methods[0].get("publicKeyJwk"):
            raise KeymasterServiceError("The DID document does not contain any verification methods.")
        return methods[0]["publicKeyJwk"]

    async def encrypt_message(self, message: str, receiver: str, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        encrypt_for_sender = options.get("encryptForSender", True)
        include_hash = options.get("includeHash", False)
        sender_keypair = await self.fetch_key_pair()
        if not sender_keypair:
            raise KeymasterServiceError("No valid sender keypair")
        receiver_doc = await self.resolve_did(receiver, {"confirm": "true"})
        receiver_public_jwk = await self.get_public_key_jwk(receiver_doc)
        encrypted = {
            "cipher_hash": __import__("hashlib").sha256(message.encode("utf-8")).hexdigest() if include_hash else None,
            "cipher_sender": encrypt_message(sender_keypair["publicJwk"], message) if encrypt_for_sender else None,
            "cipher_receiver": encrypt_message(receiver_public_jwk, message),
        }
        return await self.create_asset({"encrypted": encrypted}, options)

    async def decrypt_message(self, did: str) -> str:
        wallet = await self.load_wallet()
        id_info = await self.fetch_id_info()
        msg_doc = await self.resolve_did(did)
        encrypted = (msg_doc.get("didDocumentData") or {}).get("encrypted") or (msg_doc.get("didDocumentData") or {})
        if not encrypted or "cipher_receiver" not in encrypted:
            raise KeymasterServiceError("Invalid parameter: did not encrypted")
        sender = encrypted.get("sender") or msg_doc.get("didDocument", {}).get("controller")
        created = encrypted.get("created") or msg_doc.get("didDocumentMetadata", {}).get("created")
        if not sender:
            raise KeymasterServiceError("Sender DID could not be determined from message or DID document")
        sender_doc = await self.resolve_did(sender, {"confirm": "true", "versionTime": created} if created else {"confirm": "true"})
        sender_public_jwk = await self.get_public_key_jwk(sender_doc)
        ciphertext = encrypted.get("cipher_sender") if sender == id_info["did"] and encrypted.get("cipher_sender") else encrypted.get("cipher_receiver")
        if not isinstance(ciphertext, str) or not ciphertext:
            raise KeymasterServiceError("Encrypted payload is missing ciphertext")
        root = await self._root_node(wallet)
        index = id_info.get("index", 0)
        while index >= 0:
            path = f"m/44'/0'/{id_info['account']}'/0/{index}"
            keypair = private_key_to_jwk_pair(derive_private_key_bytes(root, path))
            try:
                _ = sender_public_jwk
                return decrypt_message(keypair["privateJwk"], ciphertext)
            except Exception:
                index -= 1
        raise KeymasterServiceError("ID can't decrypt ciphertext")

    async def encrypt_json(self, value: Any, receiver: str, options: dict[str, Any] | None = None) -> str:
        return await self.encrypt_message(json.dumps(value, separators=(",", ":")), receiver, options or {})

    async def decrypt_json(self, did: str) -> Any:
        return json.loads(await self.decrypt_message(did))

    async def create_schema(self, schema: Any | None = None, options: dict[str, Any] | None = None) -> str:
        schema = DEFAULT_SCHEMA if schema is None else schema
        if not self.validate_schema(schema):
            raise KeymasterServiceError("Invalid parameter: schema")
        return await self.create_asset({"schema": schema}, options or {})

    def validate_schema(self, schema: Any) -> bool:
        try:
            self.generate_schema_template(schema)
            return True
        except Exception:
            return False

    def generate_schema_template(self, schema: Any) -> dict[str, Any]:
        if not isinstance(schema, dict) or "$schema" not in schema or "properties" not in schema:
            raise KeymasterServiceError("Invalid parameter: schema")
        return {key: "TBD" for key in schema["properties"].keys()}

    async def get_schema(self, identifier: str) -> Any:
        asset = await self.resolve_asset(identifier)
        if asset.get("properties"):
            return asset
        return asset.get("schema")

    async def set_schema(self, identifier: str, schema: Any) -> bool:
        if not self.validate_schema(schema):
            raise KeymasterServiceError("Invalid parameter: schema")
        return await self.merge_data(identifier, {"schema": schema})

    async def test_schema(self, identifier: str) -> bool:
        try:
            schema = await self.get_schema(identifier)
            return bool(schema) and self.validate_schema(schema)
        except Exception:
            return False

    async def list_schemas(self, owner: str | None = None) -> list[str]:
        schemas = []
        for did in await self.list_assets(owner):
            if await self.test_schema(did):
                schemas.append(did)
        return schemas

    async def create_template(self, schema_id: str) -> dict[str, Any]:
        if not await self.test_schema(schema_id):
            raise KeymasterServiceError("Invalid parameter: schemaId")
        schema_did = await self.lookup_did(schema_id)
        template = self.generate_schema_template(await self.get_schema(schema_did))
        template["$schema"] = schema_did
        return template

    async def create_group(self, name: str, options: dict[str, Any] | None = None) -> str:
        return await self.create_asset({"name": name, "group": {"version": 2, "members": []}}, options or {})

    async def get_group(self, identifier: str) -> dict[str, Any] | None:
        asset = await self.resolve_asset(identifier)
        group = asset.get("group")
        if isinstance(group, dict) and group.get("version") == 2:
            return {"name": asset.get("name"), "members": group.get("members", [])}
        if isinstance(group, dict) and group.get("name") and isinstance(group.get("members"), list):
            return {"name": group["name"], "members": group["members"]}
        return None

    async def test_group(self, group_id: str, member_id: str | None = None) -> bool:
        try:
            group = await self.get_group(group_id)
            if not group:
                return False
            if not member_id:
                return True
            member_did = await self.lookup_did(member_id)
            if member_did in group["members"]:
                return True
            for did in group["members"]:
                if await self.test_group(did, member_did):
                    return True
            return False
        except Exception:
            return False

    async def add_group_member(self, group_id: str, member_id: str) -> bool:
        group_did = await self.lookup_did(group_id)
        member_did = await self.lookup_did(member_id)
        if group_did == member_did:
            raise KeymasterServiceError("Invalid parameter: can't add a group to itself")
        await self.resolve_did(member_did)
        group = await self.get_group(group_id)
        if not group:
            raise KeymasterServiceError("Invalid parameter: groupId")
        if member_did in group["members"]:
            return True
        if await self.test_group(member_id, group_id):
            raise KeymasterServiceError("Invalid parameter: can't create mutual membership")
        members = list(dict.fromkeys(group["members"] + [member_did]))
        return await self.merge_data(group_did, {"group": {"version": 2, "members": members}})

    async def remove_group_member(self, group_id: str, member_id: str) -> bool:
        group_did = await self.lookup_did(group_id)
        member_did = await self.lookup_did(member_id)
        await self.resolve_did(member_did)
        group = await self.get_group(group_did)
        if not group:
            raise KeymasterServiceError("Invalid parameter: groupId")
        members = [did for did in group["members"] if did != member_did]
        return await self.merge_data(group_did, {"group": {"version": 2, "members": members}})

    async def list_groups(self, owner: str | None = None) -> list[str]:
        groups = []
        for did in await self.list_assets(owner):
            if await self.test_group(did):
                groups.append(did)
        return groups

    async def create_challenge(self, challenge: dict[str, Any] | None = None, options: dict[str, Any] | None = None) -> str:
        return await self.create_asset({"challenge": challenge or {}}, options or {})

    async def create_response(self, challenge_did: str, options: dict[str, Any] | None = None) -> str:
        options = dict(options or {})
        options.setdefault("registry", self.ephemeral_registry)
        if "validUntil" not in options:
            expires = __import__("datetime").datetime.utcnow() + __import__("datetime").timedelta(hours=1)
            options["validUntil"] = expires.isoformat() + "Z"

        doc = await self.resolve_did(challenge_did)
        challenge_asset = await self.resolve_asset(challenge_did)
        challenge = challenge_asset.get("challenge") or {}
        requestor = doc.get("didDocument", {}).get("controller")
        if not requestor:
            raise KeymasterServiceError("Invalid parameter: requestor undefined")

        requested = len(challenge.get("credentials", []))
        response = {
            "challenge": challenge_did,
            "credentials": [],
            "requested": requested,
            "fulfilled": 0,
            "match": requested == 0,
        }
        return await self.encrypt_json({"response": response}, requestor, options)

    async def verify_response(self, response_did: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        _ = options
        response_doc = await self.resolve_did(response_did)
        wrapper = await self.decrypt_json(response_did)
        if not isinstance(wrapper, dict) or "response" not in wrapper:
            raise KeymasterServiceError("Invalid parameter: responseDID not a valid challenge response")
        response = wrapper["response"]
        challenge_asset = await self.resolve_asset(response["challenge"])
        challenge = challenge_asset.get("challenge") or {}
        response["vps"] = []
        response["match"] = len(response.get("credentials", [])) == len(challenge.get("credentials", []))
        response["responder"] = response_doc.get("didDocument", {}).get("controller")
        return response
