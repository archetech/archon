from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable
from copy import deepcopy
import json
import logging
import os
import struct
from typing import Any, Protocol, cast

import httpx

from .crypto import (
    b64url,
    decrypt_bytes,
    decrypt_message,
    decrypt_with_passphrase,
    derive_private_key_bytes,
    encrypt_bytes,
    encrypt_message,
    encrypt_with_passphrase,
    generate_jwk_pair,
    generate_mnemonic,
    hash_json,
    hash_message,
    hd_root_from_mnemonic,
    private_key_to_jwk_pair,
    sign_hash,
    ub64url,
    verify_sig,
)


LOGGER = logging.getLogger(__name__)

DEFAULT_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {"propertyName": {"type": "string"}},
    "required": ["propertyName"],
}


class NoticeTags:
    DMAIL = "dmail"
    POLL = "poll"
    BALLOT = "ballot"
    CREDENTIAL = "credential"


class PollItems:
    POLL = "poll"
    RESULTS = "results"


class KeymasterError(Exception):
    pass


class UnknownIDError(KeymasterError):
    pass


class GatekeeperProtocol(Protocol):
    async def list_registries(self) -> list[str]: ...
    async def create_did(self, operation: dict[str, Any]) -> str: ...
    async def resolve_did(self, did: str, options: dict[str, Any] | None = None) -> dict[str, Any]: ...
    async def update_did(self, operation: dict[str, Any]) -> bool: ...
    async def delete_did(self, operation: dict[str, Any]) -> bool: ...
    async def get_block(self, registry: str, block: str | None = None) -> dict[str, Any] | None: ...
    async def search(self, query: dict[str, Any]) -> list[str]: ...
    async def add_data(self, data: bytes) -> str: ...
    async def get_data(self, cid: str) -> bytes | None: ...
    async def add_text(self, text: str) -> str: ...
    async def get_text(self, cid: str) -> str | None: ...


class WalletStoreProtocol(Protocol):
    def save_wallet(self, wallet: dict[str, Any], overwrite: bool = False) -> bool: ...
    def load_wallet(self) -> dict[str, Any] | None: ...


class Keymaster:
    def __init__(
        self,
        gatekeeper: GatekeeperProtocol,
        wallet_store: WalletStoreProtocol,
        passphrase: str,
        default_registry: str = "hyperswarm",
        ephemeral_registry: str = "hyperswarm",
        max_alias_length: int = 32,
    ):
        self.gatekeeper = gatekeeper
        self.wallet_store = wallet_store
        self.passphrase = passphrase
        self.default_registry = default_registry or "hyperswarm"
        self.ephemeral_registry = ephemeral_registry
        self.max_alias_length = max_alias_length
        self.max_data_length = 8 * 1024
        self._wallet_cache: dict[str, Any] | None = None
        self._root_cache = None
        self._lock = asyncio.Lock()

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
            raise KeymasterError("Invalid parameter: mnemonic") from exc

        wallet = {
            "version": 2,
            "seed": {"mnemonicEnc": encrypt_with_passphrase(mnemonic, self.passphrase)},
            "counter": 0,
            "ids": {},
            "aliases": {},
        }
        ok = await self.save_wallet(wallet, overwrite=overwrite)
        if not ok:
            raise KeymasterError("save wallet failed")
        return wallet

    async def decrypt_wallet(self, stored: dict[str, Any]) -> dict[str, Any]:
        if "enc" not in stored:
            return self._upgrade_wallet(stored)

        seed = stored.get("seed", {})
        mnemonic = decrypt_with_passphrase(seed["mnemonicEnc"], self.passphrase)
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
        return decrypt_with_passphrase(wallet["seed"]["mnemonicEnc"], self.passphrase)

    async def change_passphrase(self, new_passphrase: str) -> bool:
        if not isinstance(new_passphrase, str) or not new_passphrase:
            raise KeymasterError("Invalid parameter: newPassphrase")

        wallet = await self.load_wallet()
        mnemonic = decrypt_with_passphrase(wallet["seed"]["mnemonicEnc"], self.passphrase)
        wallet["seed"]["mnemonicEnc"] = encrypt_with_passphrase(mnemonic, new_passphrase)

        self.passphrase = new_passphrase
        self._root_cache = hd_root_from_mnemonic(mnemonic)
        self._wallet_cache = wallet

        encrypted = await self.encrypt_wallet_for_storage(wallet)
        ok = self.wallet_store.save_wallet(encrypted, overwrite=True)
        if not ok:
            raise KeymasterError("Failed to save wallet with new passphrase")
        return True

    async def export_encrypted_wallet(self) -> dict[str, Any]:
        return await self.encrypt_wallet_for_storage(await self.load_wallet())

    async def _root_node(self, wallet: dict[str, Any] | None = None):
        if self._root_cache is not None:
            return self._root_cache
        if wallet is None:
            wallet = await self.load_wallet()
        mnemonic = decrypt_with_passphrase(wallet["seed"]["mnemonicEnc"], self.passphrase)
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

    def validate_alias(self, alias: str, wallet: dict[str, Any] | None = None, label: str = "name") -> str:
        if not isinstance(alias, str) or not alias.strip():
            raise KeymasterError(f"Invalid parameter: {label} must be a non-empty string")
        alias = alias.strip()
        if len(alias) > self.max_alias_length:
            raise KeymasterError(f"Invalid parameter: {label} too long")
        if any(not char.isprintable() for char in alias):
            raise KeymasterError(f"Invalid parameter: {label} contains unprintable characters")
        if wallet and (alias in wallet.get("aliases", {}) or alias in wallet.get("ids", {})):
            raise KeymasterError(f"Invalid parameter: {label} already used")
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
                raise KeymasterError("No current ID")
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
            raise KeymasterError(metadata["error"])
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

    def normalize_address_domain(self, domain: str) -> str:
        if not isinstance(domain, str) or not domain.strip():
            raise KeymasterError("Invalid parameter: domain")

        trimmed = domain.strip().lower()
        try:
            candidate = trimmed if "://" in trimmed else f"https://{trimmed}"
            url = __import__("urllib.parse").parse.urlparse(candidate)
            if not url.netloc:
                raise ValueError("missing hostname")
            return url.netloc.lower()
        except Exception as exc:
            raise KeymasterError("Invalid parameter: domain") from exc

    def parse_address(self, address: str) -> dict[str, str]:
        if not isinstance(address, str) or not address.strip():
            raise KeymasterError("Invalid parameter: address")

        trimmed = address.strip().lower()
        parts = trimmed.split("@")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise KeymasterError("Invalid parameter: address")

        name, domain_text = parts
        domain = self.normalize_address_domain(domain_text)
        return {"address": f"{name}@{domain}", "name": name, "domain": domain}

    async def _http_request(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        json_body: Any | None = None,
    ):
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            return await client.request(method, url, headers=headers, json=json_body)

    async def get_response_data(self, response: Any) -> Any:
        try:
            return response.json()
        except Exception:
            return None

    async def get_response_error(self, response: Any, fallback: str) -> str:
        data = await self.get_response_data(response)
        if isinstance(data, dict) and isinstance(data.get("message"), str):
            return data["message"]
        if isinstance(data, dict) and isinstance(data.get("error"), str):
            return data["error"]
        return fallback

    def address_api_endpoints(self, domain: str, path: str) -> list[str]:
        return [f"https://{domain}/names/api/{path}", f"https://{domain}/api/{path}"]

    async def fetch_address_api_response(
        self,
        domain: str,
        path: str,
        method: str,
        headers: dict[str, str] | None,
        json_body: Any | None,
        fallback: str,
    ) -> Any:
        last_response = None
        saw_network_error = False

        for endpoint in self.address_api_endpoints(domain, path):
            try:
                response = await self._http_request(method, endpoint, headers=headers, json_body=json_body)
                if 200 <= response.status_code < 300:
                    return response
                last_response = response
            except Exception:
                saw_network_error = True

        if last_response is not None:
            raise KeymasterError(await self.get_response_error(last_response, fallback))
        if saw_network_error:
            raise KeymasterError(fallback)
        raise KeymasterError(fallback)

    async def create_address_bearer_token(self, domain: str) -> str:
        last_error = "Failed to fetch address challenge"

        for endpoint in self.address_api_endpoints(domain, "challenge"):
            try:
                response = await self._http_request("GET", endpoint)
                if not (200 <= response.status_code < 300):
                    last_error = await self.get_response_error(response, last_error)
                    continue

                data = await self.get_response_data(response)
                if not isinstance(data, dict) or not isinstance(data.get("challenge"), str):
                    last_error = "Invalid address challenge"
                    continue

                return await self.create_response(data["challenge"], {"retries": 5, "delay": 1000})
            except Exception:
                last_error = "Failed to fetch address challenge"

        raise KeymasterError(last_error)

    def collect_addresses(self, id_info: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        addresses = {}
        for domain, info in (id_info or {}).get("addresses", {}).items():
            addresses[f"{info['name']}@{domain}"] = {"added": info["added"]}
        return addresses

    async def list_addresses(self) -> dict[str, dict[str, Any]]:
        wallet = await self.load_wallet()
        current = wallet.get("current")
        if not current:
            return {}
        return self.collect_addresses(wallet["ids"].get(current))

    async def get_address(self, domain: str) -> dict[str, Any] | None:
        normalized_domain = self.normalize_address_domain(domain)
        id_info = await self.fetch_id_info()
        stored = id_info.get("addresses", {}).get(normalized_domain)
        if not stored:
            return None
        return {
            "domain": normalized_domain,
            "name": stored["name"],
            "address": f"{stored['name']}@{normalized_domain}",
            "added": stored["added"],
        }

    async def import_address(self, domain: str) -> dict[str, dict[str, Any]]:
        normalized_domain = self.normalize_address_domain(domain)
        current = await self.fetch_id_info()
        response = await self._http_request("GET", f"https://{normalized_domain}/.well-known/names")
        if not (200 <= response.status_code < 300):
            raise KeymasterError(await self.get_response_error(response, "Failed to import addresses"))

        data = await self.get_response_data(response)
        names = data.get("names") if isinstance(data, dict) else {}
        if not isinstance(names, dict):
            names = {}
        imported = {}
        added = __import__("datetime").datetime.utcnow().isoformat() + "Z"

        async with self._lock:
            wallet = await self.load_wallet()
            id_info = wallet["ids"][wallet["current"]]
            id_info.setdefault("addresses", {})
            for name, did in names.items():
                if did != current["did"]:
                    continue
                address = f"{str(name).lower()}@{normalized_domain}"
                id_info["addresses"][normalized_domain] = {"name": str(name).lower(), "added": added}
                imported[address] = {"added": added}
            await self._save_loaded_wallet(wallet, overwrite=True)

        return imported

    async def check_address(self, address: str) -> dict[str, Any]:
        parsed = self.parse_address(address)
        try:
            response = await self._http_request(
                "GET", f"https://{parsed['domain']}/.well-known/names/{__import__('urllib.parse').parse.quote(parsed['name'])}"
            )
        except Exception:
            return {
                "address": parsed["address"],
                "status": "unreachable",
                "available": False,
                "did": None,
            }

        if response.status_code == 404:
            content_type = response.headers.get("content-type", "")
            data = await self.get_response_data(response) if "application/json" in content_type else None
            if isinstance(data, dict) and data.get("error") == "Name not found":
                return {
                    "address": parsed["address"],
                    "status": "available",
                    "available": True,
                    "did": None,
                }
            return {
                "address": parsed["address"],
                "status": "unsupported",
                "available": False,
                "did": None,
            }

        if not (200 <= response.status_code < 300):
            raise KeymasterError(await self.get_response_error(response, "Failed to check address"))

        data = await self.get_response_data(response)
        if not isinstance(data, dict) or not isinstance(data.get("did"), str):
            return {
                "address": parsed["address"],
                "status": "unsupported",
                "available": False,
                "did": None,
            }

        return {
            "address": parsed["address"],
            "status": "claimed",
            "available": False,
            "did": data["did"],
        }

    async def add_address(self, address: str) -> bool:
        parsed = self.parse_address(address)
        bearer_token = await self.create_address_bearer_token(parsed["domain"])
        await self.fetch_address_api_response(
            parsed["domain"],
            "name",
            "PUT",
            {"Authorization": f"Bearer {bearer_token}", "Content-Type": "application/json"},
            {"name": parsed["name"]},
            "Failed to add address",
        )

        async with self._lock:
            wallet = await self.load_wallet()
            id_info = wallet["ids"][wallet["current"]]
            id_info.setdefault("addresses", {})
            id_info["addresses"][parsed["domain"]] = {
                "name": parsed["name"],
                "added": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            }
            await self._save_loaded_wallet(wallet, overwrite=True)

        return True

    async def remove_address(self, address: str) -> bool:
        parsed = self.parse_address(address)
        id_info = await self.fetch_id_info()
        stored = id_info.get("addresses", {}).get(parsed["domain"])
        if not stored or stored.get("name") != parsed["name"]:
            raise KeymasterError("Invalid parameter: address")

        bearer_token = await self.create_address_bearer_token(parsed["domain"])
        await self.fetch_address_api_response(
            parsed["domain"],
            "name",
            "DELETE",
            {"Authorization": f"Bearer {bearer_token}"},
            None,
            "Failed to remove address",
        )

        async with self._lock:
            wallet = await self.load_wallet()
            current = wallet["ids"][wallet["current"]]
            addresses = current.get("addresses", {})
            current_stored = addresses.get(parsed["domain"])
            if current_stored and current_stored.get("name") == parsed["name"]:
                del addresses[parsed["domain"]]
            await self._save_loaded_wallet(wallet, overwrite=True)

        return True

    async def fetch_key_pair(self, name: str | None = None) -> dict[str, dict[str, str]] | None:
        wallet = await self.load_wallet()
        id_info = await self.fetch_id_info(name, wallet)
        return await self.derive_key_pair(id_info["account"], id_info.get("index", 0), wallet)

    async def decrypt_with_derived_keys(
        self,
        wallet: dict[str, Any],
        id_info: dict[str, Any],
        ciphertext: str,
    ) -> str:
        root = await self._root_node(wallet)
        index = id_info.get("index", 0)

        while index >= 0:
            path = f"m/44'/0'/{id_info['account']}'/0/{index}"
            keypair = private_key_to_jwk_pair(derive_private_key_bytes(root, path))
            try:
                return decrypt_message(keypair["privateJwk"], ciphertext)
            except Exception:
                index -= 1

        raise KeymasterError("ID can't decrypt ciphertext")

    def generate_salted_id(self, vault: dict[str, Any], member_did: str) -> str:
        if not vault.get("version"):
            return hash_message(f"{vault['salt']}{member_did}")

        suffix = member_did.split(":")[-1]
        return hash_message(f"{vault['salt']}{suffix}")

    def generate_ballot_key(self, vault: dict[str, Any], member_did: str) -> str:
        return self.generate_salted_id(vault, member_did)[: self.max_alias_length]

    async def decrypt_vault(self, vault: dict[str, Any]) -> dict[str, Any]:
        wallet = await self.load_wallet()
        id_info = await self.fetch_id_info(None, wallet)
        my_member_id = self.generate_salted_id(vault, id_info["did"])
        my_vault_key = vault.get("keys", {}).get(my_member_id)

        if not my_vault_key:
            raise KeymasterError("No access to vault")

        private_jwk = json.loads(await self.decrypt_with_derived_keys(wallet, id_info, my_vault_key))

        config: dict[str, Any] = {}
        is_owner = False
        try:
            config = json.loads(await self.decrypt_with_derived_keys(wallet, id_info, vault["config"]))
            is_owner = True
        except Exception:
            pass

        members: dict[str, Any] = {}
        if config.get("secretMembers"):
            try:
                members = json.loads(await self.decrypt_with_derived_keys(wallet, id_info, vault["members"]))
            except Exception:
                pass
        else:
            try:
                members = json.loads(decrypt_message(private_jwk, vault["members"]))
            except Exception:
                pass

        items = json.loads(decrypt_message(private_jwk, vault["items"]))
        return {
            "isOwner": is_owner,
            "privateJwk": private_jwk,
            "config": config,
            "members": members,
            "items": items,
        }

    async def check_vault_owner(self, vault_id: str) -> str:
        id_info = await self.fetch_id_info()
        vault_doc = await self.resolve_did(vault_id)
        controller = vault_doc.get("didDocument", {}).get("controller")

        if controller != id_info["did"]:
            raise KeymasterError("Only vault owner can modify the vault")

        return controller

    async def add_member_key(self, vault: dict[str, Any], member_did: str, private_jwk: dict[str, str]) -> None:
        member_doc = await self.resolve_did(member_did, {"confirm": True})
        member_public_jwk = await self.get_public_key_jwk(member_doc)
        member_key = encrypt_message(member_public_jwk, json.dumps(private_jwk, separators=(",", ":")))
        member_key_id = self.generate_salted_id(vault, member_did)
        vault.setdefault("keys", {})[member_key_id] = member_key

    async def check_vault_version(self, vault_id: str, vault: dict[str, Any]) -> None:
        if vault.get("version") == 1:
            return

        if not vault.get("version"):
            id_info = await self.fetch_id_info()
            decrypted = await self.decrypt_vault(vault)

            vault["version"] = 1
            vault["keys"] = {}

            await self.add_member_key(vault, id_info["did"], decrypted["privateJwk"])

            for member_did in decrypted["members"].keys():
                await self.add_member_key(vault, member_did, decrypted["privateJwk"])

            await self.merge_data(vault_id, {"vault": vault})
            return

        raise KeymasterError("Unsupported vault version")

    def get_agent_did(self, doc: dict[str, Any]) -> str:
        if doc.get("didDocumentRegistration", {}).get("type") != "agent":
            raise KeymasterError("Document is not an agent")

        did = doc.get("didDocument", {}).get("id")
        if not did:
            raise KeymasterError("Agent document does not have a DID")

        return did

    def get_mime_type(self, buffer: bytes) -> str:
        signatures = {
            b"\x89PNG\r\n\x1a\n": "image/png",
            b"\xff\xd8\xff": "image/jpeg",
            b"GIF87a": "image/gif",
            b"GIF89a": "image/gif",
        }
        for signature, mime in signatures.items():
            if buffer.startswith(signature):
                return mime

        if len(buffer) >= 12 and buffer[:4] == b"RIFF" and buffer[8:12] == b"WEBP":
            return "image/webp"

        try:
            text = buffer.decode("utf-8")
        except UnicodeDecodeError:
            return "application/octet-stream"

        try:
            json.loads(text)
            return "application/json"
        except Exception:
            pass

        if all(character.isprintable() or character in "\t\n\r" for character in text):
            return "text/plain"

        return "application/octet-stream"

    def _parse_jpeg_size(self, buffer: bytes) -> tuple[int, int] | None:
        if len(buffer) < 4 or buffer[:2] != b"\xff\xd8":
            return None

        markers = {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }
        index = 2
        while index + 1 < len(buffer):
            if buffer[index] != 0xFF:
                index += 1
                continue

            while index < len(buffer) and buffer[index] == 0xFF:
                index += 1
            if index >= len(buffer):
                return None

            marker = buffer[index]
            index += 1

            if marker in {0xD8, 0xD9}:
                continue
            if marker == 0xDA:
                return None
            if index + 2 > len(buffer):
                return None

            segment_length = int.from_bytes(buffer[index:index + 2], "big")
            if segment_length < 2 or index + segment_length > len(buffer):
                return None

            if marker in markers:
                if index + 7 > len(buffer):
                    return None
                height = int.from_bytes(buffer[index + 3:index + 5], "big")
                width = int.from_bytes(buffer[index + 5:index + 7], "big")
                return width, height

            index += segment_length

        return None

    def _parse_webp_size(self, buffer: bytes) -> tuple[int, int] | None:
        if len(buffer) < 30 or buffer[:4] != b"RIFF" or buffer[8:12] != b"WEBP":
            return None

        chunk = buffer[12:16]
        if chunk == b"VP8X" and len(buffer) >= 30:
            width = int.from_bytes(buffer[24:27], "little") + 1
            height = int.from_bytes(buffer[27:30], "little") + 1
            return width, height

        if chunk == b"VP8 " and len(buffer) >= 30:
            width = struct.unpack("<H", buffer[26:28])[0] & 0x3FFF
            height = struct.unpack("<H", buffer[28:30])[0] & 0x3FFF
            return width, height

        if chunk == b"VP8L" and len(buffer) >= 25:
            bits = int.from_bytes(buffer[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height

        return None

    def parse_image_metadata(self, buffer: bytes) -> tuple[str, int, int]:
        if len(buffer) >= 24 and buffer.startswith(b"\x89PNG\r\n\x1a\n"):
            width = int.from_bytes(buffer[16:20], "big")
            height = int.from_bytes(buffer[20:24], "big")
            return "png", width, height

        if len(buffer) >= 10 and buffer[:6] in {b"GIF87a", b"GIF89a"}:
            width = int.from_bytes(buffer[6:8], "little")
            height = int.from_bytes(buffer[8:10], "little")
            return "gif", width, height

        jpeg_size = self._parse_jpeg_size(buffer)
        if jpeg_size:
            return "jpg", jpeg_size[0], jpeg_size[1]

        webp_size = self._parse_webp_size(buffer)
        if webp_size:
            return "webp", webp_size[0], webp_size[1]

        raise KeymasterError("Invalid parameter: buffer")

    async def generate_image_asset(self, filename: str, buffer: bytes) -> dict[str, Any]:
        image_type, width, height = self.parse_image_metadata(buffer)
        cid = await self.gatekeeper.add_data(buffer)
        return {
            "file": {
                "cid": cid,
                "filename": filename,
                "type": f"image/{image_type}",
                "bytes": len(buffer),
            },
            "image": {
                "width": width,
                "height": height,
            },
        }

    async def create_image(self, buffer: bytes, options: dict[str, Any] | None = None) -> str:
        options = deepcopy(options or {})
        filename = options.get("filename") or "image"
        asset = await self.generate_image_asset(filename, buffer)
        return await self.create_asset(asset, options)

    async def update_image(self, identifier: str, buffer: bytes, options: dict[str, Any] | None = None) -> bool:
        options = deepcopy(options or {})
        filename = options.get("filename") or "image"
        asset = await self.generate_image_asset(filename, buffer)
        return await self.merge_data(identifier, asset)

    async def get_image(self, identifier: str) -> dict[str, Any] | None:
        asset = await self.resolve_asset(identifier)
        if not isinstance(asset, dict):
            return None

        file = asset.get("file")
        image = asset.get("image")
        if not isinstance(file, dict) or not file.get("cid") or not isinstance(image, dict):
            return None

        data = await self.gatekeeper.get_data(file["cid"])
        file_asset = deepcopy(file)
        if data is not None:
            file_asset["data"] = data

        return {
            "file": file_asset,
            "image": deepcopy(image),
        }

    async def test_image(self, identifier: str) -> bool:
        try:
            return await self.get_image(identifier) is not None
        except Exception:
            return False

    async def generate_file_asset(self, filename: str, buffer: bytes) -> dict[str, Any]:
        cid = await self.gatekeeper.add_data(buffer)
        return {
            "cid": cid,
            "filename": filename,
            "type": self.get_mime_type(buffer),
            "bytes": len(buffer),
        }

    async def create_file(self, buffer: bytes, options: dict[str, Any] | None = None) -> str:
        options = deepcopy(options or {})
        filename = options.get("filename") or "file"
        file_asset = await self.generate_file_asset(filename, buffer)
        return await self.create_asset({"file": file_asset}, options)

    async def update_file(self, identifier: str, buffer: bytes, options: dict[str, Any] | None = None) -> bool:
        options = deepcopy(options or {})
        filename = options.get("filename") or "file"
        file_asset = await self.generate_file_asset(filename, buffer)
        return await self.merge_data(identifier, {"file": file_asset})

    async def collect_stream_bytes(self, stream: bytes | bytearray | AsyncIterable[bytes]) -> bytes:
        if isinstance(stream, (bytes, bytearray)):
            return bytes(stream)

        stream_iterable = cast(AsyncIterable[bytes], stream)
        chunks: list[bytes] = []
        async for chunk in stream_iterable:
            chunk_bytes = bytes(chunk)
            if chunk_bytes:
                chunks.append(chunk_bytes)
        return b"".join(chunks)

    async def generate_file_asset_from_stream(
        self,
        filename: str,
        stream: bytes | bytearray | AsyncIterable[bytes],
        content_type: str,
        bytes_count: int,
    ) -> dict[str, Any]:
        buffer = await self.collect_stream_bytes(stream)
        cid = await self.gatekeeper.add_data(buffer)
        return {
            "cid": cid,
            "filename": filename,
            "type": content_type,
            "bytes": bytes_count if bytes_count else len(buffer),
        }

    async def create_file_stream(
        self,
        stream: bytes | bytearray | AsyncIterable[bytes],
        options: dict[str, Any] | None = None,
    ) -> str:
        options = deepcopy(options or {})
        filename = options.get("filename") or "file"
        content_type = options.get("contentType") or "application/octet-stream"
        bytes_count = int(options.get("bytes") or 0)
        file_asset = await self.generate_file_asset_from_stream(filename, stream, content_type, bytes_count)
        return await self.create_asset({"file": file_asset}, options)

    async def update_file_stream(
        self,
        identifier: str,
        stream: bytes | bytearray | AsyncIterable[bytes],
        options: dict[str, Any] | None = None,
    ) -> bool:
        options = deepcopy(options or {})
        filename = options.get("filename") or "file"
        content_type = options.get("contentType") or "application/octet-stream"
        bytes_count = int(options.get("bytes") or 0)
        file_asset = await self.generate_file_asset_from_stream(filename, stream, content_type, bytes_count)
        return await self.merge_data(identifier, {"file": file_asset})

    async def get_file(self, identifier: str) -> dict[str, Any] | None:
        asset = await self.resolve_asset(identifier)
        if not isinstance(asset, dict):
            return None

        file = asset.get("file")
        if not isinstance(file, dict) or not file.get("cid"):
            return None

        data = await self.gatekeeper.get_data(file["cid"])
        file_asset = deepcopy(file)
        if data is not None:
            file_asset["data"] = data
        return file_asset

    async def test_file(self, identifier: str) -> bool:
        try:
            return await self.get_file(identifier) is not None
        except Exception:
            return False

    async def create_vault(self, options: dict[str, Any] | None = None) -> str:
        options = deepcopy(options or {})
        id_info = await self.fetch_id_info()
        id_keypair = await self.fetch_key_pair()
        if not id_keypair:
            raise KeymasterError("No valid sender keypair")
        version = 1 if "version" not in options else (1 if options.get("version") == 1 else None)
        vault_keypair = generate_jwk_pair()
        public_jwk = id_keypair["publicJwk"] if options.get("secretMembers") else vault_keypair["publicJwk"]
        vault = {
            "version": version,
            "publicJwk": vault_keypair["publicJwk"],
            "salt": b64url(os.urandom(16)),
            "config": encrypt_message(id_keypair["publicJwk"], json.dumps(options, separators=(",", ":"))),
            "members": encrypt_message(public_jwk, json.dumps({}, separators=(",", ":"))),
            "keys": {},
            "items": encrypt_message(vault_keypair["publicJwk"], json.dumps({}, separators=(",", ":"))),
            "sha256": hash_json({}),
        }

        await self.add_member_key(vault, id_info["did"], vault_keypair["privateJwk"])
        return await self.create_asset({"vault": vault}, options)

    async def get_vault(self, vault_id: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        asset = await self.resolve_asset(vault_id, options)
        if not isinstance(asset, dict) or not isinstance(asset.get("vault"), dict):
            raise KeymasterError("Invalid parameter: vaultId")
        return asset["vault"]

    async def test_vault(self, identifier: str, options: dict[str, Any] | None = None) -> bool:
        try:
            vault = await self.get_vault(identifier, options)
            return vault is not None
        except Exception:
            return False

    async def add_vault_member(self, vault_id: str, member_id: str) -> bool:
        owner = await self.check_vault_owner(vault_id)

        id_keypair = await self.fetch_key_pair()
        if not id_keypair:
            raise KeymasterError("No valid sender keypair")
        vault = await self.get_vault(vault_id)
        decrypted = await self.decrypt_vault(vault)
        member_doc = await self.resolve_did(member_id, {"confirm": True})
        member_did = self.get_agent_did(member_doc)

        if owner == member_did:
            return False

        decrypted["members"][member_did] = {"added": __import__("datetime").datetime.utcnow().isoformat() + "Z"}
        public_jwk = id_keypair["publicJwk"] if decrypted["config"].get("secretMembers") else vault["publicJwk"]
        vault["members"] = encrypt_message(public_jwk, json.dumps(decrypted["members"], separators=(",", ":")))

        await self.add_member_key(vault, member_did, decrypted["privateJwk"])
        return await self.merge_data(vault_id, {"vault": vault})

    async def remove_vault_member(self, vault_id: str, member_id: str) -> bool:
        owner = await self.check_vault_owner(vault_id)

        id_keypair = await self.fetch_key_pair()
        if not id_keypair:
            raise KeymasterError("No valid sender keypair")
        vault = await self.get_vault(vault_id)
        decrypted = await self.decrypt_vault(vault)
        member_doc = await self.resolve_did(member_id, {"confirm": True})
        member_did = self.get_agent_did(member_doc)

        if owner == member_did:
            return False

        decrypted["members"].pop(member_did, None)
        public_jwk = id_keypair["publicJwk"] if decrypted["config"].get("secretMembers") else vault["publicJwk"]
        vault["members"] = encrypt_message(public_jwk, json.dumps(decrypted["members"], separators=(",", ":")))
        vault.setdefault("keys", {}).pop(self.generate_salted_id(vault, member_did), None)
        return await self.merge_data(vault_id, {"vault": vault})

    async def list_vault_members(self, vault_id: str) -> dict[str, Any]:
        vault = await self.get_vault(vault_id)
        decrypted = await self.decrypt_vault(vault)

        if decrypted["isOwner"]:
            await self.check_vault_version(vault_id, vault)

        return decrypted["members"]

    async def add_vault_item(self, vault_id: str, name: str, buffer: bytes) -> bool:
        await self.check_vault_owner(vault_id)

        vault = await self.get_vault(vault_id)
        decrypted = await self.decrypt_vault(vault)
        valid_name = self.validate_alias(name)
        encrypted_data = encrypt_bytes(vault["publicJwk"], buffer)
        cid = await self.gatekeeper.add_text(encrypted_data)
        item = {
            "cid": cid,
            "sha256": hash_message(buffer),
            "bytes": len(buffer),
            "type": self.get_mime_type(buffer),
            "added": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        }
        if len(encrypted_data) < self.max_data_length:
            item["data"] = encrypted_data

        decrypted["items"][valid_name] = item
        vault["items"] = encrypt_message(vault["publicJwk"], json.dumps(decrypted["items"], separators=(",", ":")))
        vault["sha256"] = hash_json(decrypted["items"])
        return await self.merge_data(vault_id, {"vault": vault})

    async def remove_vault_item(self, vault_id: str, name: str) -> bool:
        await self.check_vault_owner(vault_id)

        vault = await self.get_vault(vault_id)
        decrypted = await self.decrypt_vault(vault)
        decrypted["items"].pop(name, None)
        vault["items"] = encrypt_message(vault["publicJwk"], json.dumps(decrypted["items"], separators=(",", ":")))
        vault["sha256"] = hash_json(decrypted["items"])
        return await self.merge_data(vault_id, {"vault": vault})

    async def list_vault_items(self, vault_id: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        vault = await self.get_vault(vault_id, options)
        decrypted = await self.decrypt_vault(vault)
        return decrypted["items"]

    async def get_vault_item(self, vault_id: str, name: str, options: dict[str, Any] | None = None) -> bytes | None:
        vault = await self.get_vault(vault_id, options)
        decrypted = await self.decrypt_vault(vault)
        item = decrypted["items"].get(name)
        if not item:
            return None

        encrypted_data = item.get("data") or await self.gatekeeper.get_text(item["cid"])
        if not encrypted_data:
            raise KeymasterError(f"Failed to retrieve data for item '{name}' (CID: {item['cid']})")

        return decrypt_bytes(decrypted["privateJwk"], encrypted_data)

    async def add_proof(self, payload: dict[str, Any], controller: str | None = None, proof_purpose: str = "assertionMethod") -> dict[str, Any]:
        id_info = await self.fetch_id_info(controller)
        keypair = await self.fetch_key_pair(controller)
        if not keypair:
            raise KeymasterError("addProof: no keypair")
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

    async def change_registry(self, identifier: str, registry: str) -> bool:
        if not isinstance(registry, str) or not registry:
            raise KeymasterError("Invalid parameter: registry")

        if registry not in await self.list_registries():
            raise KeymasterError(f"Registry not supported: {registry}")

        did = await self.lookup_did(identifier)
        current = await self.resolve_did(did)
        current_registration = current.get("didDocumentRegistration") or {}
        if registry == current_registration.get("registry"):
            return True

        return await self.update_did(
            did,
            {
                "didDocumentRegistration": {
                    **current_registration,
                    "registry": registry,
                }
            },
        )

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

    async def add_to_held(self, did: str) -> bool:
        async with self._lock:
            wallet = await self.load_wallet()
            current = wallet.get("current")
            if not current:
                raise KeymasterError("No current ID")
            id_info = wallet["ids"][current]
            held = set(id_info.get("held", []))
            held.add(did)
            id_info["held"] = list(held)
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def remove_from_held(self, did: str) -> bool:
        changed = False
        async with self._lock:
            wallet = await self.load_wallet()
            current = wallet.get("current")
            if not current:
                raise KeymasterError("No current ID")
            id_info = wallet["ids"][current]
            held = set(id_info.get("held", []))
            if did in held:
                held.remove(did)
                changed = True
                id_info["held"] = list(held)
                await self._save_loaded_wallet(wallet, overwrite=True)
        return changed

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

    async def clone_asset(self, identifier: str, options: dict[str, Any] | None = None) -> str:
        asset_doc = await self.resolve_did(identifier)
        if asset_doc.get("didDocumentRegistration", {}).get("type") != "asset":
            raise KeymasterError("Invalid parameter: id")

        asset_data = asset_doc.get("didDocumentData") or {}
        if not isinstance(asset_data, dict):
            raise KeymasterError("Invalid parameter: id")

        clone_data = {**asset_data, "cloned": asset_doc.get("didDocument", {}).get("id")}
        return await self.create_asset(clone_data, options or {})

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

    async def transfer_asset(self, identifier: str, controller: str) -> bool:
        asset_doc = await self.resolve_did(identifier)
        if asset_doc.get("didDocumentRegistration", {}).get("type") != "asset":
            raise KeymasterError("Invalid parameter: id")

        current_controller = asset_doc.get("didDocument", {}).get("controller")
        if current_controller == controller:
            return True

        agent_doc = await self.resolve_did(controller)
        if agent_doc.get("didDocumentRegistration", {}).get("type") != "agent":
            raise KeymasterError("Invalid parameter: controller")

        asset_did = asset_doc.get("didDocument", {}).get("id")
        updated_did_document = {
            **(asset_doc.get("didDocument") or {}),
            "controller": agent_doc.get("didDocument", {}).get("id"),
        }

        ok = await self.update_did(identifier, {"didDocument": updated_did_document})
        if ok and asset_did and current_controller:
            await self.remove_from_owned(asset_did, current_controller)
            try:
                await self.add_to_owned(asset_did, controller)
            except Exception:
                pass
        return ok

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

        for info in wallet["ids"].values():
            try:
                doc = await self.resolve_did(info["did"])
                if doc.get("didDocumentMetadata", {}).get("deactivated"):
                    deleted += 1
            except Exception:
                invalid += 1
            checked += 1

        for did in wallet.get("aliases", {}).values():
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
                        raise KeymasterError("deactivated")
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
                                raise KeymasterError("deactivated")
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
                        raise KeymasterError("deactivated")
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
            raise KeymasterError("seed bank missing DID")
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
                raise KeymasterError("No backup DID found")

        keypair = await self.hd_key_pair()
        data = await self.resolve_asset(did)
        backup = data.get("backup")
        if not isinstance(backup, str):
            raise KeymasterError("Asset \"backup\" is missing or not a string")

        wallet = json.loads(decrypt_message(keypair["privateJwk"], backup))
        if isinstance(wallet, dict) and wallet.get("seed", {}).get("mnemonicEnc"):
            mnemonic = await self.decrypt_mnemonic()
            wallet["seed"]["mnemonicEnc"] = encrypt_with_passphrase(mnemonic, self.passphrase)

        async with self._lock:
            upgraded = self._upgrade_wallet(wallet)
            await self._save_loaded_wallet(upgraded, overwrite=True)
        return upgraded

    async def backup_id(self, identifier: str | None = None) -> bool:
        wallet = await self.load_wallet()
        name = identifier or wallet.get("current")
        if not name:
            raise KeymasterError("Invalid parameter: no current ID")
        id_info = await self.fetch_id_info(name, wallet)
        keypair = await self.hd_key_pair(wallet)
        backup = encrypt_message(keypair["publicJwk"], json.dumps({"name": name, "id": id_info}, separators=(",", ":")))
        doc = await self.resolve_did(id_info["did"])
        registry = doc.get("didDocumentRegistration", {}).get("registry")
        if not registry:
            raise KeymasterError("no registry found for agent DID")
        backup_store_did = await self.create_asset({"backup": backup}, {"registry": registry, "controller": name})
        current_data = doc.get("didDocumentData") or {}
        updated_data = {**current_data, "backupStore": backup_store_did}
        return await self.update_did(name, {"didDocumentData": updated_data})

    async def recover_id(self, did: str) -> str:
        keypair = await self.hd_key_pair()
        doc = await self.resolve_did(did)
        backup_store_did = (doc.get("didDocumentData") or {}).get("backupStore")
        if not backup_store_did:
            raise KeymasterError("backup not found in backupStore")
        backup_store = await self.resolve_asset(backup_store_did)
        backup = backup_store.get("backup")
        if not isinstance(backup, str):
            raise KeymasterError("backup not found in backupStore")
        data = json.loads(decrypt_message(keypair["privateJwk"], backup))
        async with self._lock:
            wallet = await self.load_wallet()
            if data["name"] in wallet["ids"]:
                raise KeymasterError(f"{data['name']} already exists in wallet")
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
                raise KeymasterError("No current ID")
            id_info = wallet["ids"][current_name]
            next_index = id_info.get("index", 0) + 1
            keypair = await self.derive_key_pair(id_info["account"], next_index, wallet)
            doc = await self.resolve_did(id_info["did"])
            did_document = doc.get("didDocument") or {}
            verification_methods = did_document.get("verificationMethod") or []
            if not verification_methods:
                raise KeymasterError("DID Document missing verificationMethod")
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
            raise KeymasterError("The DID document does not contain any verification methods.")
        return methods[0]["publicKeyJwk"]

    async def encrypt_message(self, message: str, receiver: str, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        encrypt_for_sender = options.get("encryptForSender", True)
        include_hash = options.get("includeHash", False)
        sender_keypair = await self.fetch_key_pair()
        if not sender_keypair:
            raise KeymasterError("No valid sender keypair")
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
            raise KeymasterError("Invalid parameter: did not encrypted")
        sender = encrypted.get("sender") or msg_doc.get("didDocument", {}).get("controller")
        created = encrypted.get("created") or msg_doc.get("didDocumentMetadata", {}).get("created")
        if not sender:
            raise KeymasterError("Sender DID could not be determined from message or DID document")
        sender_doc = await self.resolve_did(sender, {"confirm": "true", "versionTime": created} if created else {"confirm": "true"})
        sender_public_jwk = await self.get_public_key_jwk(sender_doc)
        ciphertext = encrypted.get("cipher_sender") if sender == id_info["did"] and encrypted.get("cipher_sender") else encrypted.get("cipher_receiver")
        if not isinstance(ciphertext, str) or not ciphertext:
            raise KeymasterError("Encrypted payload is missing ciphertext")
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
        raise KeymasterError("ID can't decrypt ciphertext")

    async def encrypt_json(self, value: Any, receiver: str, options: dict[str, Any] | None = None) -> str:
        return await self.encrypt_message(json.dumps(value, separators=(",", ":")), receiver, options or {})

    async def decrypt_json(self, did: str) -> Any:
        return json.loads(await self.decrypt_message(did))

    async def create_schema(self, schema: Any | None = None, options: dict[str, Any] | None = None) -> str:
        schema = DEFAULT_SCHEMA if schema is None else schema
        if not self.validate_schema(schema):
            raise KeymasterError("Invalid parameter: schema")
        return await self.create_asset({"schema": schema}, options or {})

    def validate_schema(self, schema: Any) -> bool:
        try:
            self.generate_schema_template(schema)
            return True
        except Exception:
            return False

    def generate_schema_template(self, schema: Any) -> dict[str, Any]:
        if not isinstance(schema, dict) or "$schema" not in schema or "properties" not in schema:
            raise KeymasterError("Invalid parameter: schema")
        return {key: "TBD" for key in schema["properties"].keys()}

    async def get_schema(self, identifier: str) -> Any:
        asset = await self.resolve_asset(identifier)
        if asset.get("properties"):
            return asset
        return asset.get("schema")

    async def set_schema(self, identifier: str, schema: Any) -> bool:
        if not self.validate_schema(schema):
            raise KeymasterError("Invalid parameter: schema")
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
            raise KeymasterError("Invalid parameter: schemaId")
        schema_did = await self.lookup_did(schema_id)
        template = self.generate_schema_template(await self.get_schema(schema_did))
        template["$schema"] = schema_did
        return template

    async def create_group(self, name: str, options: dict[str, Any] | None = None) -> str:
        return await self.create_asset({"name": name, "group": {"version": 2, "members": []}}, options or {})

    async def poll_template(self) -> dict[str, Any]:
        next_week = __import__("datetime").datetime.now(__import__("datetime").timezone.utc) + __import__("datetime").timedelta(days=7)
        return {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": next_week.isoformat().replace("+00:00", "Z"),
        }

    def _parse_poll_deadline(self, value: Any):
        if not isinstance(value, str) or not value:
            raise KeymasterError("Invalid parameter: poll.deadline")

        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = __import__("datetime").datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise KeymasterError("Invalid parameter: poll.deadline") from exc

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=__import__("datetime").timezone.utc)
        return parsed.astimezone(__import__("datetime").timezone.utc)

    async def create_poll(self, config: dict[str, Any], options: dict[str, Any] | None = None) -> str:
        if not isinstance(config, dict) or config.get("version") != 2:
            raise KeymasterError("Invalid parameter: poll.version")

        if not isinstance(config.get("name"), str) or not config["name"]:
            raise KeymasterError("Invalid parameter: poll.name")

        if not isinstance(config.get("description"), str) or not config["description"]:
            raise KeymasterError("Invalid parameter: poll.description")

        poll_options = config.get("options")
        if not isinstance(poll_options, list) or len(poll_options) < 2 or len(poll_options) > 10:
            raise KeymasterError("Invalid parameter: poll.options")

        deadline = self._parse_poll_deadline(config.get("deadline"))
        if deadline < __import__("datetime").datetime.now(__import__("datetime").timezone.utc):
            raise KeymasterError("Invalid parameter: poll.deadline")

        vault_did = await self.create_vault(options or {})
        buffer = json.dumps(config, separators=(",", ":")).encode("utf-8")
        await self.add_vault_item(vault_did, PollItems.POLL, buffer)
        return vault_did

    async def get_poll(self, identifier: str) -> dict[str, Any] | None:
        is_vault = await self.test_vault(identifier)
        if not is_vault:
            return None

        try:
            buffer = await self.get_vault_item(identifier, PollItems.POLL)
            if not buffer:
                return None
            return json.loads(buffer.decode("utf-8"))
        except Exception:
            return None

    async def test_poll(self, identifier: str) -> bool:
        try:
            return await self.get_poll(identifier) is not None
        except Exception:
            return False

    async def list_polls(self, owner: str | None = None) -> list[str]:
        polls: list[str] = []
        for did in await self.list_assets(owner):
            if await self.test_poll(did):
                polls.append(did)
        return polls

    async def add_poll_voter(self, poll_id: str, member_id: str) -> bool:
        if not await self.get_poll(poll_id):
            raise KeymasterError("Invalid parameter: pollId")
        return await self.add_vault_member(poll_id, member_id)

    async def remove_poll_voter(self, poll_id: str, member_id: str) -> bool:
        if not await self.get_poll(poll_id):
            raise KeymasterError("Invalid parameter: pollId")
        return await self.remove_vault_member(poll_id, member_id)

    async def list_poll_voters(self, poll_id: str) -> dict[str, Any]:
        if not await self.get_poll(poll_id):
            raise KeymasterError("Invalid parameter: pollId")
        return await self.list_vault_members(poll_id)

    async def view_poll(self, poll_id: str) -> dict[str, Any]:
        id_info = await self.fetch_id_info()
        config = await self.get_poll(poll_id)

        if not config:
            raise KeymasterError("Invalid parameter: pollId")

        doc = await self.resolve_did(poll_id)
        is_owner = doc.get("didDocument", {}).get("controller") == id_info["did"]
        vote_expired = self._parse_poll_deadline(config["deadline"]) < __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        )

        is_eligible = False
        has_voted = False
        ballots: list[str] = []

        try:
            vault = await self.get_vault(poll_id)
            members = await self.list_vault_members(poll_id)
            is_eligible = is_owner or bool(members.get(id_info["did"]))

            items = await self.list_vault_items(poll_id)
            for item_name in items.keys():
                if item_name not in {PollItems.POLL, PollItems.RESULTS}:
                    ballots.append(item_name)

            has_voted = self.generate_ballot_key(vault, id_info["did"]) in ballots
        except Exception:
            is_eligible = False

        view = {
            "description": config["description"],
            "options": config["options"],
            "deadline": config["deadline"],
            "isOwner": is_owner,
            "isEligible": is_eligible,
            "voteExpired": vote_expired,
            "hasVoted": has_voted,
            "ballots": ballots,
        }

        if is_owner:
            view["results"] = await self.compute_poll_results(poll_id, config)
        else:
            try:
                results_buffer = await self.get_vault_item(poll_id, PollItems.RESULTS)
                if results_buffer:
                    view["results"] = json.loads(results_buffer.decode("utf-8"))
            except Exception:
                pass

        return view

    async def compute_poll_results(self, poll_id: str, config: dict[str, Any]) -> dict[str, Any]:
        vault = await self.get_vault(poll_id)
        members = await self.list_vault_members(poll_id)
        items = await self.list_vault_items(poll_id)

        results: dict[str, Any] = {
            "tally": [{"vote": 0, "option": "spoil", "count": 0}],
            "ballots": [],
        }
        for index, option in enumerate(config["options"], start=1):
            results["tally"].append({"vote": index, "option": option, "count": 0})

        key_to_member = {
            self.generate_ballot_key(vault, member_did): member_did for member_did in members.keys()
        }
        owner_id = await self.fetch_id_info()
        key_to_member[self.generate_ballot_key(vault, owner_id["did"])] = owner_id["did"]

        voted = 0
        for item_name, item_meta in items.items():
            if item_name in {PollItems.POLL, PollItems.RESULTS}:
                continue

            ballot_buffer = await self.get_vault_item(poll_id, item_name)
            if not ballot_buffer:
                continue

            ballot_did = ballot_buffer.decode("utf-8")
            decrypted = await self.decrypt_json(ballot_did)
            vote = decrypted.get("vote")
            option_name = "spoil" if vote == 0 else config["options"][vote - 1]
            received = item_meta.get("added", "") if isinstance(item_meta, dict) else ""

            results["ballots"].append(
                {
                    "voter": key_to_member.get(item_name, item_name),
                    "vote": vote,
                    "option": option_name,
                    "received": received,
                }
            )

            voted += 1
            if isinstance(vote, int) and 0 <= vote < len(results["tally"]):
                results["tally"][vote]["count"] += 1

        total = len(members) + 1
        vote_expired = self._parse_poll_deadline(config["deadline"]) < __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        )
        results["votes"] = {
            "eligible": total,
            "received": voted,
            "pending": total - voted,
        }
        results["final"] = vote_expired or voted == total
        return results

    async def vote_poll(self, poll_id: str, vote: int, options: dict[str, Any] | None = None) -> str:
        id_info = await self.fetch_id_info()
        did_poll = await self.lookup_did(poll_id)
        doc = await self.resolve_did(did_poll)
        config = await self.get_poll(poll_id)

        if not config:
            raise KeymasterError("Invalid parameter: pollId")

        owner = doc.get("didDocument", {}).get("controller")
        if not owner:
            raise KeymasterError("Keymaster: owner missing from poll")

        is_eligible = False
        if id_info["did"] == owner:
            is_eligible = True
        else:
            try:
                vault = await self.get_vault(did_poll)
                await self.decrypt_vault(vault)
                is_eligible = True
            except Exception:
                is_eligible = False

        if not is_eligible:
            raise KeymasterError("Invalid parameter: pollId")

        expired = self._parse_poll_deadline(config["deadline"]) < __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        )
        if expired:
            raise KeymasterError("Invalid parameter: poll has expired")

        if not isinstance(vote, int) or vote < 0 or vote > len(config["options"]):
            raise KeymasterError("Invalid parameter: vote")

        ballot = {"poll": did_poll, "vote": vote}
        return await self.encrypt_json(ballot, owner, options or {})

    async def send_poll(self, poll_id: str) -> str:
        did_poll = await self.lookup_did(poll_id)
        config = await self.get_poll(did_poll)

        if not config:
            raise KeymasterError("Invalid parameter: pollId")

        voters = list((await self.list_vault_members(did_poll)).keys())
        if not voters:
            raise KeymasterError("Keymaster: No poll voters found")

        valid_until = (__import__("datetime").datetime.utcnow() + __import__("datetime").timedelta(days=7)).isoformat() + "Z"
        return await self.create_notice(
            {"to": voters, "dids": [did_poll]},
            {"registry": self.ephemeral_registry, "validUntil": valid_until},
        )

    async def send_ballot(self, ballot_did: str, poll_id: str) -> str:
        did_poll = await self.lookup_did(poll_id)
        config = await self.get_poll(did_poll)

        if not config:
            raise KeymasterError("Invalid parameter: pollId is not a valid poll")

        poll_doc = await self.resolve_did(did_poll)
        owner_did = poll_doc.get("didDocument", {}).get("controller")
        if not owner_did:
            raise KeymasterError("Keymaster: poll owner not found")

        valid_until = (__import__("datetime").datetime.utcnow() + __import__("datetime").timedelta(days=7)).isoformat() + "Z"
        return await self.create_notice(
            {"to": [owner_did], "dids": [ballot_did]},
            {"registry": self.ephemeral_registry, "validUntil": valid_until},
        )

    async def view_ballot(self, ballot_did: str) -> dict[str, Any]:
        ballot_doc = await self.resolve_did(ballot_did)
        result: dict[str, Any] = {
            "poll": "",
            "voter": ballot_doc.get("didDocument", {}).get("controller") or None,
        }

        try:
            data = await self.decrypt_json(ballot_did)
            result["poll"] = data["poll"]
            result["vote"] = data["vote"]

            config = await self.get_poll(data["poll"])
            if config and 0 < data["vote"] <= len(config["options"]):
                result["option"] = config["options"][data["vote"] - 1]
            elif data["vote"] == 0:
                result["option"] = "spoil"
        except Exception:
            pass

        return result

    async def update_poll(self, ballot: str) -> bool:
        id_info = await self.fetch_id_info()
        did_ballot = await self.lookup_did(ballot)
        ballot_doc = await self.resolve_did(did_ballot)
        voter_did = ballot_doc.get("didDocument", {}).get("controller")

        try:
            ballot_data = await self.decrypt_json(did_ballot)
            if not ballot_data.get("poll") or ballot_data.get("vote") is None:
                raise KeymasterError("Invalid parameter: ballot")
        except Exception as exc:
            raise KeymasterError("Invalid parameter: ballot") from exc

        did_poll = ballot_data["poll"]
        poll_doc = await self.resolve_did(did_poll)
        owner_did = poll_doc.get("didDocument", {}).get("controller")
        config = await self.get_poll(did_poll)

        if not config:
            raise KeymasterError("Cannot find poll related to ballot")
        if id_info["did"] != owner_did:
            raise KeymasterError("Invalid parameter: only owner can update a poll")

        vault = await self.get_vault(did_poll)
        members = await self.list_vault_members(did_poll)
        if not voter_did or (voter_did != id_info["did"] and voter_did not in members):
            raise KeymasterError("Invalid parameter: voter is not a poll member")

        expired = self._parse_poll_deadline(config["deadline"]) < __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        )
        if expired:
            raise KeymasterError("Invalid parameter: poll has expired")

        vote = ballot_data["vote"]
        if not isinstance(vote, int) or vote < 0 or vote > len(config["options"]):
            raise KeymasterError("Invalid parameter: ballot.vote")

        ballot_key = self.generate_ballot_key(vault, voter_did)
        await self.add_vault_item(did_poll, ballot_key, did_ballot.encode("utf-8"))
        return True

    async def publish_poll(self, poll_id: str, options: dict[str, Any] | None = None) -> bool:
        reveal = bool((options or {}).get("reveal", False))
        id_info = await self.fetch_id_info()
        doc = await self.resolve_did(poll_id)
        owner = doc.get("didDocument", {}).get("controller")

        if id_info["did"] != owner:
            raise KeymasterError("Invalid parameter: only owner can publish a poll")

        config = await self.get_poll(poll_id)
        if not config:
            raise KeymasterError(f"Invalid parameter: {poll_id}")

        results = await self.compute_poll_results(poll_id, config)
        if not results.get("final"):
            raise KeymasterError("Invalid parameter: poll not final")

        if not reveal:
            results.pop("ballots", None)

        await self.add_vault_item(poll_id, PollItems.RESULTS, json.dumps(results, separators=(",", ":")).encode("utf-8"))
        return True

    async def unpublish_poll(self, poll_id: str) -> bool:
        id_info = await self.fetch_id_info()
        doc = await self.resolve_did(poll_id)
        owner = doc.get("didDocument", {}).get("controller")

        if id_info["did"] != owner:
            raise KeymasterError(f"Invalid parameter: {poll_id}")

        config = await self.get_poll(poll_id)
        if not config:
            raise KeymasterError(f"Invalid parameter: {poll_id}")

        return await self.remove_vault_item(poll_id, PollItems.RESULTS)

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
            raise KeymasterError("Invalid parameter: can't add a group to itself")
        await self.resolve_did(member_did)
        group = await self.get_group(group_id)
        if not group:
            raise KeymasterError("Invalid parameter: groupId")
        if member_did in group["members"]:
            return True
        if await self.test_group(member_id, group_id):
            raise KeymasterError("Invalid parameter: can't create mutual membership")
        members = list(dict.fromkeys(group["members"] + [member_did]))
        return await self.merge_data(group_did, {"group": {"version": 2, "members": members}})

    async def remove_group_member(self, group_id: str, member_id: str) -> bool:
        group_did = await self.lookup_did(group_id)
        member_did = await self.lookup_did(member_id)
        await self.resolve_did(member_did)
        group = await self.get_group(group_did)
        if not group:
            raise KeymasterError("Invalid parameter: groupId")
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

    def is_managed_did(self, value: str) -> bool:
        return isinstance(value, str) and value.startswith("did:")

    def is_verifiable_credential(self, value: Any) -> bool:
        return (
            isinstance(value, dict)
            and isinstance(value.get("@context"), list)
            and isinstance(value.get("type"), list)
            and isinstance(value.get("issuer"), str)
            and isinstance(value.get("credentialSubject"), dict)
        )

    async def bind_credential(
        self,
        subject_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        options = options or {}
        schema = options.get("schema")
        valid_from = options.get("validFrom") or (__import__("datetime").datetime.utcnow().isoformat() + "Z")
        valid_until = options.get("validUntil")
        claims = deepcopy(options.get("claims")) if isinstance(options.get("claims"), dict) else options.get("claims")

        id_info = await self.fetch_id_info()
        try:
            subject_uri = await self.lookup_did(subject_id)
        except Exception:
            subject_uri = subject_id

        vc = {
            "@context": [
                "https://www.w3.org/ns/credentials/v2",
                "https://www.w3.org/ns/credentials/examples/v2",
            ],
            "type": ["VerifiableCredential"],
            "issuer": id_info["did"],
            "validFrom": valid_from,
            "validUntil": valid_until,
            "credentialSubject": {"id": subject_uri},
        }

        if schema:
            schema_did = await self.lookup_did(schema)
            schema_doc = await self.get_schema(schema_did)
            if not claims and isinstance(schema_doc, dict):
                claims = self.generate_schema_template(schema_doc)
            if isinstance(schema_doc, dict) and isinstance(schema_doc.get("$credentialContext"), list) and schema_doc["$credentialContext"]:
                vc["@context"] = schema_doc["$credentialContext"]
            if isinstance(schema_doc, dict) and isinstance(schema_doc.get("$credentialType"), list) and schema_doc["$credentialType"]:
                vc["type"] = schema_doc["$credentialType"]
            vc["credentialSchema"] = {"id": schema_did, "type": "JsonSchema"}

        if isinstance(claims, dict) and claims:
            vc["credentialSubject"] = {"id": subject_uri, **claims}

        return vc

    async def issue_credential(self, credential: dict[str, Any] | None, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        id_info = await self.fetch_id_info()

        if options.get("schema") and options.get("subject"):
            credential = await self.bind_credential(
                options["subject"],
                {
                    "schema": options.get("schema"),
                    "claims": options.get("claims"),
                    "validFrom": options.get("validFrom"),
                    "validUntil": options.get("validUntil"),
                },
            )

        if not isinstance(credential, dict) or credential.get("issuer") != id_info["did"]:
            raise KeymasterError("Invalid parameter: credential.issuer")

        signed = await self.add_proof(credential)
        subject_id = credential.get("credentialSubject", {}).get("id")
        if self.is_managed_did(subject_id):
            return await self.encrypt_json(signed, subject_id, {**options, "includeHash": True})
        return await self.encrypt_json(signed, id_info["did"], {**options, "includeHash": True, "encryptForSender": False})

    def verify_tag_list(self, tags: list[str]) -> list[str]:
        if not isinstance(tags, list):
            raise KeymasterError("Invalid parameter: tags")

        verified: list[str] = []
        seen: set[str] = set()
        for tag in tags:
            if not isinstance(tag, str) or not tag.strip():
                raise KeymasterError(f"Invalid parameter: Invalid tag: '{tag}'")

            normalized = tag.strip()
            if normalized not in seen:
                seen.add(normalized)
                verified.append(normalized)

        return verified

    async def verify_recipient_list(self, recipients: list[str]) -> list[str]:
        if not isinstance(recipients, list):
            raise KeymasterError("Invalid parameter: list")

        verified: list[str] = []
        for recipient in recipients:
            if not isinstance(recipient, str):
                raise KeymasterError(f"Invalid parameter: Invalid recipient type: {type(recipient).__name__}")

            did = await self.lookup_did(recipient)
            if await self.test_agent(did):
                verified.append(did)
                continue

            raise KeymasterError(f"Invalid parameter: Invalid recipient: {recipient}")

        return verified

    async def verify_did_list(self, did_list: list[str]) -> list[str]:
        if not isinstance(did_list, list):
            raise KeymasterError("Invalid parameter: didList")

        verified: list[str] = []
        for item in did_list:
            did = await self.lookup_did(item) if isinstance(item, str) else item
            if not self.is_managed_did(did):
                raise KeymasterError(f"Invalid parameter: Invalid DID: {item}")
            verified.append(did)

        return verified

    async def verify_notice(self, notice: dict[str, Any]) -> dict[str, Any]:
        to = notice.get("to")
        dids = notice.get("dids")
        if not isinstance(to, list) or not to:
            raise KeymasterError("Invalid parameter: notice.to")
        if not isinstance(dids, list) or not dids:
            raise KeymasterError("Invalid parameter: notice.dids")

        verified_to = await self.verify_recipient_list(to)
        verified_dids = await self.verify_did_list(dids)
        return {"to": verified_to, "dids": verified_dids}

    async def create_notice(self, message: dict[str, Any], options: dict[str, Any] | None = None) -> str:
        notice = await self.verify_notice(message)
        return await self.create_asset({"notice": notice}, options or {})

    async def update_notice(self, identifier: str, message: dict[str, Any]) -> bool:
        notice = await self.verify_notice(message)
        return await self.merge_data(identifier, {"notice": notice})

    async def add_to_notices(self, did: str, tags: list[str]) -> bool:
        verified_tags = self.verify_tag_list(tags)
        async with self._lock:
            wallet = await self.load_wallet()
            current = wallet.get("current")
            if not current:
                raise KeymasterError("No current ID")

            id_info = wallet["ids"][current]
            notices = id_info.setdefault("notices", {})
            notices[did] = {"tags": verified_tags}
            await self._save_loaded_wallet(wallet, overwrite=True)
        return True

    async def import_notice(self, did: str) -> bool:
        wallet = await self.load_wallet()
        id_info = await self.fetch_id_info(None, wallet)

        if did in (id_info.get("notices") or {}):
            return True

        asset = await self.resolve_asset(did)
        notice = asset.get("notice") if isinstance(asset, dict) else None
        if not isinstance(notice, dict):
            return False

        recipients = notice.get("to")
        if not isinstance(recipients, list) or id_info["did"] not in recipients:
            return False

        imported = False
        for notice_did in notice.get("dids") or []:
            accepted = await self.accept_credential(notice_did)
            if not accepted:
                return False

            await self.add_to_notices(did, [NoticeTags.CREDENTIAL])
            imported = True

        return imported

    async def search_notices(self) -> bool:
        id_info = await self.fetch_id_info()
        where = {"notice.to[*]": {"$in": [id_info["did"]]}}

        try:
            notices = await self.gatekeeper.search({"where": where})
        except Exception as exc:
            raise KeymasterError("Failed to search for notices") from exc

        existing = id_info.get("notices") or {}
        for notice_did in notices or []:
            if notice_did in existing:
                continue

            try:
                await self.import_notice(notice_did)
            except Exception:
                continue

        return True

    async def cleanup_notices(self) -> bool:
        changed = False
        async with self._lock:
            wallet = await self.load_wallet()
            current = wallet.get("current")
            if not current:
                raise KeymasterError("No current ID")

            id_info = wallet["ids"][current]
            notices = id_info.get("notices")
            if not notices:
                return True

            for notice_did in list(notices.keys()):
                try:
                    asset = await self.resolve_asset(notice_did)
                    if not isinstance(asset, dict) or not isinstance(asset.get("notice"), dict):
                        del notices[notice_did]
                        changed = True
                except Exception:
                    del notices[notice_did]
                    changed = True

            if changed:
                await self._save_loaded_wallet(wallet, overwrite=True)

        return True

    async def refresh_notices(self) -> bool:
        await self.search_notices()
        return await self.cleanup_notices()

    async def send_credential(self, did: str, options: dict[str, Any] | None = None) -> str | None:
        vc = await self.get_credential(did)
        if not vc:
            return None
        subject_id = vc.get("credentialSubject", {}).get("id")
        if not self.is_managed_did(subject_id):
            return None
        valid_until = (__import__("datetime").datetime.utcnow() + __import__("datetime").timedelta(days=7)).isoformat() + "Z"
        message = {"to": [subject_id], "dids": [did]}
        return await self.create_notice(message, {"registry": self.ephemeral_registry, "validUntil": valid_until, **(options or {})})

    async def update_credential(self, did: str, credential: dict[str, Any]) -> bool:
        did = await self.lookup_did(did)
        original = await self.decrypt_json(did)
        if not self.is_verifiable_credential(original):
            raise KeymasterError("Invalid parameter: did is not a credential")
        if not isinstance(credential, dict) or not isinstance(credential.get("credentialSubject"), dict) or not credential["credentialSubject"].get("id"):
            raise KeymasterError("Invalid parameter: credential")

        unsigned = deepcopy(credential)
        unsigned.pop("proof", None)
        signed = await self.add_proof(unsigned)
        message = json.dumps(signed, separators=(",", ":"))
        sender_keypair = await self.fetch_key_pair()
        if not sender_keypair:
            raise KeymasterError("No valid sender keypair")

        holder = credential["credentialSubject"]["id"]
        msg_hash = __import__("hashlib").sha256(message.encode("utf-8")).hexdigest()
        if self.is_managed_did(holder):
            holder_doc = await self.resolve_did(holder, {"confirm": "true"})
            receive_public_jwk = await self.get_public_key_jwk(holder_doc)
            encrypted = {
                "cipher_hash": msg_hash,
                "cipher_sender": encrypt_message(sender_keypair["publicJwk"], message),
                "cipher_receiver": encrypt_message(receive_public_jwk, message),
            }
        else:
            encrypted = {
                "cipher_hash": msg_hash,
                "cipher_sender": None,
                "cipher_receiver": encrypt_message(sender_keypair["publicJwk"], message),
            }
        return await self.update_did(did, {"didDocumentData": {"encrypted": encrypted}})

    async def revoke_credential(self, credential: str) -> bool:
        did = await self.lookup_did(credential)
        return await self.revoke_did(did)

    async def list_issued(self, issuer: str | None = None) -> list[str]:
        id_info = await self.fetch_id_info(issuer)
        issued = []
        for did in id_info.get("owned", []):
            try:
                credential = await self.decrypt_json(did)
                if self.is_verifiable_credential(credential) and credential.get("issuer") == id_info["did"]:
                    issued.append(did)
            except Exception:
                pass
        return issued

    async def accept_credential(self, did: str) -> bool:
        try:
            id_info = await self.fetch_id_info()
            credential_did = await self.lookup_did(did)
            vc = await self.decrypt_json(credential_did)
            if self.is_verifiable_credential(vc) and vc.get("credentialSubject", {}).get("id") != id_info["did"]:
                return False
            return await self.add_to_held(credential_did)
        except Exception:
            return False

    async def get_credential(self, identifier: str) -> dict[str, Any] | None:
        did = await self.lookup_did(identifier)
        vc = await self.decrypt_json(did)
        if not self.is_verifiable_credential(vc):
            return None
        return vc

    async def remove_credential(self, identifier: str) -> bool:
        did = await self.lookup_did(identifier)
        return await self.remove_from_held(did)

    async def list_credentials(self, identifier: str | None = None) -> list[str]:
        id_info = await self.fetch_id_info(identifier)
        return id_info.get("held", [])

    async def publish_credential(self, did: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        reveal = bool((options or {}).get("reveal", False))
        id_info = await self.fetch_id_info()
        credential = await self.lookup_did(did)
        vc = await self.decrypt_json(credential)
        if not self.is_verifiable_credential(vc):
            raise KeymasterError("Invalid parameter: did is not a credential")
        if vc.get("credentialSubject", {}).get("id") != id_info["did"]:
            raise KeymasterError("Invalid parameter: only subject can publish a credential")

        doc = await self.resolve_did(id_info["did"])
        did_document_data = deepcopy(doc.get("didDocumentData") or {})
        manifest = did_document_data.setdefault("manifest", {})
        published_vc = deepcopy(vc)
        if not reveal:
            published_vc["credentialSubject"] = {"id": published_vc["credentialSubject"]["id"]}
        manifest[credential] = published_vc
        ok = await self.update_did(id_info["did"], {"didDocumentData": did_document_data})
        if not ok:
            raise KeymasterError("update DID failed")
        return published_vc

    async def unpublish_credential(self, did: str) -> str:
        id_info = await self.fetch_id_info()
        doc = await self.resolve_did(id_info["did"])
        credential = await self.lookup_did(did)
        did_document_data = deepcopy(doc.get("didDocumentData") or {})
        manifest = did_document_data.get("manifest") or {}
        if credential in manifest:
            del manifest[credential]
            did_document_data["manifest"] = manifest
            await self.update_did(id_info["did"], {"didDocumentData": did_document_data})
            return f"OK credential {did} removed from manifest"
        raise KeymasterError("Invalid parameter: did")

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
            raise KeymasterError("Invalid parameter: requestor undefined")

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
            raise KeymasterError("Invalid parameter: responseDID not a valid challenge response")
        response = wrapper["response"]
        challenge_asset = await self.resolve_asset(response["challenge"])
        challenge = challenge_asset.get("challenge") or {}
        response["vps"] = []
        response["match"] = len(response.get("credentials", [])) == len(challenge.get("credentials", []))
        response["responder"] = response_doc.get("didDocument", {}).get("controller")
        return response