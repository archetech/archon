"""Keymaster CLI — Python port of packages/keymaster/src/cli.ts.

Mirrors the TypeScript CLI command surface by instantiating the Python
Keymaster library directly against a remote gatekeeper HTTP endpoint and a
local JSON wallet file. Command names, argument shapes, and output formats
match the TypeScript CLI so tooling can swap implementations.

Environment:
    ARCHON_NODE_URL / ARCHON_GATEKEEPER_URL  Gatekeeper HTTP URL (default http://localhost:4224)
    ARCHON_WALLET_PATH                        Wallet file path (default ./wallet.json)
    ARCHON_PASSPHRASE                         Required — wallet passphrase
    ARCHON_DEFAULT_REGISTRY                   Default registry (optional)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

from keymaster.core import Keymaster

from .gatekeeper_client import GatekeeperClient
from .wallet_store import JsonWalletStore


UPDATE_OK = "OK"
UPDATE_FAILED = "Update failed"
LIGHTNING_ZAP_STATUS_CHECKS = 3
LIGHTNING_ZAP_STATUS_DELAY_MS = 1000


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=4, default=_json_default))


def _json_default(obj: Any) -> Any:
    if isinstance(obj, (bytes, bytearray)):
        return base64.b64encode(bytes(obj)).decode("ascii")
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _error(message: Any) -> None:
    if isinstance(message, dict) and "error" in message:
        print(message["error"], file=sys.stderr)
        return
    print(str(message), file=sys.stderr)


WALLET_CREATION_COMMANDS = {
    "create-wallet",
    "new-wallet",
    "create-id",
    "import-wallet",
    "restore-wallet-file",
}


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

async def cmd_create_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    wallet = await km.load_wallet()
    _print_json(wallet)


async def cmd_new_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    await km.new_wallet(overwrite=True)
    _print_json(await km.load_wallet())


async def cmd_change_passphrase(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.change_passphrase(args.new_passphrase)
    print(UPDATE_OK if ok else "Failed")


async def cmd_check_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    result = await km.check_wallet()
    checked = result.get("checked", 0)
    invalid = result.get("invalid", 0)
    deleted = result.get("deleted", 0)
    if invalid == 0 and deleted == 0:
        print(f"{checked} DIDs checked, no problems found")
    else:
        print(f"{checked} DIDs checked, {invalid} invalid DIDs found, {deleted} deleted DIDs found")


async def cmd_fix_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    result = await km.fix_wallet()
    ids_removed = result.get("idsRemoved", 0)
    owned_removed = result.get("ownedRemoved", 0)
    held_removed = result.get("heldRemoved", 0)
    aliases_removed = result.get("aliasesRemoved", 0)
    print(
        f"{ids_removed} IDs and {owned_removed} owned DIDs and "
        f"{held_removed} held DIDs and {aliases_removed} aliases were removed"
    )


async def cmd_import_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    wallet = await km.new_wallet(mnemonic=args.recovery_phrase)
    _print_json(wallet)


async def cmd_show_wallet(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.load_wallet())


async def cmd_backup_wallet_file(km: Keymaster, args: argparse.Namespace) -> None:
    wallet = await km.export_encrypted_wallet()
    Path(args.file).write_text(json.dumps(wallet, indent=4), encoding="utf-8")
    print(UPDATE_OK)


async def cmd_restore_wallet_file(km: Keymaster, args: argparse.Namespace) -> None:
    wallet = json.loads(Path(args.file).read_text(encoding="utf-8"))
    ok = await km.save_wallet(wallet, overwrite=True)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_show_mnemonic(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.decrypt_mnemonic())


async def cmd_backup_wallet_did(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.backup_wallet())


async def cmd_recover_wallet_did(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.recover_wallet(args.did))


# Identity --------------------------------------------------------------------

async def cmd_create_id(km: Keymaster, args: argparse.Namespace) -> None:
    opts = {"registry": args.registry} if args.registry else {}
    print(await km.create_id(args.name, opts or None))


async def cmd_resolve_id(km: Keymaster, args: argparse.Namespace) -> None:
    current = await km.get_current_id()
    if not current:
        _error("No current ID set")
        return
    id_info = await km.fetch_id_info(current)
    _print_json(await km.resolve_did(id_info["did"]))


async def cmd_backup_id(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.backup_id()
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_recover_id(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.recover_id(args.did))


async def cmd_remove_id(km: Keymaster, args: argparse.Namespace) -> None:
    await km.remove_id(args.name)
    print(f"ID {args.name} removed")


async def cmd_rename_id(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.rename_id(args.old_name, args.new_name)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_list_ids(km: Keymaster, args: argparse.Namespace) -> None:
    current = await km.get_current_id()
    for name in await km.list_ids():
        if name == current:
            print(f"{name}  <<< current")
        else:
            print(name)


async def cmd_use_id(km: Keymaster, args: argparse.Namespace) -> None:
    await km.set_current_id(args.name)
    print(UPDATE_OK)


async def cmd_rotate_keys(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.rotate_keys()
    print(UPDATE_OK if ok else UPDATE_FAILED)


# DID -------------------------------------------------------------------------

async def cmd_resolve_did(km: Keymaster, args: argparse.Namespace) -> None:
    try:
        doc = await km.resolve_did(args.did, {"confirm": bool(args.confirm)} if args.confirm else None)
        _print_json(doc)
    except Exception:
        _error(f"cannot resolve {args.did}")


async def cmd_resolve_did_version(km: Keymaster, args: argparse.Namespace) -> None:
    try:
        doc = await km.resolve_did(args.did, {"versionSequence": int(args.version)})
        _print_json(doc)
    except Exception:
        _error(f"cannot resolve {args.did}")


async def cmd_revoke_did(km: Keymaster, args: argparse.Namespace) -> None:
    try:
        ok = await km.revoke_did(args.did)
        print(UPDATE_OK if ok else UPDATE_FAILED)
    except Exception:
        _error(f"cannot revoke {args.did}")


async def cmd_change_registry(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.change_registry(args.id, args.registry)
    print(UPDATE_OK if ok else UPDATE_FAILED)


# Encryption ------------------------------------------------------------------

async def cmd_encrypt_message(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.encrypt_message(args.message, args.did))


async def cmd_encrypt_file(km: Keymaster, args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8")
    print(await km.encrypt_message(text, args.did))


async def cmd_decrypt_did(km: Keymaster, args: argparse.Namespace) -> None:
    try:
        print(await km.decrypt_message(args.did))
    except Exception:
        _error(f"cannot decrypt {args.did}")


async def cmd_decrypt_json(km: Keymaster, args: argparse.Namespace) -> None:
    try:
        _print_json(await km.decrypt_json(args.did))
    except Exception:
        _error(f"cannot decrypt {args.did}")


# Signing ---------------------------------------------------------------------

async def cmd_sign_file(km: Keymaster, args: argparse.Namespace) -> None:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    _print_json(await km.add_proof(payload))


async def cmd_verify_file(km: Keymaster, args: argparse.Namespace) -> None:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    is_valid = await km.verify_proof(payload)
    print(f"proof in {args.file} {'is valid' if is_valid else 'is NOT valid'}")


# Challenge / response --------------------------------------------------------

async def cmd_create_challenge(km: Keymaster, args: argparse.Namespace) -> None:
    challenge = None
    if args.file:
        challenge = json.loads(Path(args.file).read_text(encoding="utf-8"))
    opts = {"alias": args.alias} if args.alias else None
    print(await km.create_challenge(challenge, opts))


async def cmd_create_challenge_cc(km: Keymaster, args: argparse.Namespace) -> None:
    challenge = {"credentials": [{"schema": args.did}]}
    opts = {"alias": args.alias} if args.alias else None
    print(await km.create_challenge(challenge, opts))


async def cmd_create_response(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.create_response(args.challenge))


async def cmd_verify_response(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.verify_response(args.response))


# Credentials -----------------------------------------------------------------

async def cmd_bind_credential(km: Keymaster, args: argparse.Namespace) -> None:
    vc = await km.bind_credential(args.subject, {"schema": args.schema})
    _print_json(vc)


async def cmd_issue_credential(km: Keymaster, args: argparse.Namespace) -> None:
    vc = json.loads(Path(args.file).read_text(encoding="utf-8"))
    opts: dict[str, Any] = {}
    if args.alias:
        opts["alias"] = args.alias
    if args.registry:
        opts["registry"] = args.registry
    print(await km.issue_credential(vc, opts or None))


async def cmd_list_issued(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_issued())


async def cmd_update_credential(km: Keymaster, args: argparse.Namespace) -> None:
    vc = json.loads(Path(args.file).read_text(encoding="utf-8"))
    ok = await km.update_credential(args.did, vc)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_revoke_credential(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.revoke_credential(args.did)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_accept_credential(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.accept_credential(args.did)
    if ok:
        print(UPDATE_OK)
        if args.alias:
            await km.add_alias(args.alias, args.did)
    else:
        print(UPDATE_FAILED)


async def cmd_list_credentials(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_credentials())


async def cmd_get_credential(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.get_credential(args.did))


async def cmd_view_credential(km: Keymaster, args: argparse.Namespace) -> None:
    credential = await km.get_credential(args.did)
    if not credential:
        _error("Credential not found")
        return
    types = credential.get("type") or []
    print(f"Credential: {args.did}")
    print(f"Type:       {', '.join(types) if isinstance(types, list) else types}")
    print(f"Issuer:     {credential.get('issuer', '')}")
    subject = credential.get("credentialSubject") or {}
    print(f"Subject:    {subject.get('id', '')}")
    print(f"Valid from: {credential.get('validFrom', '')}")
    if credential.get("validUntil"):
        print(f"Valid until: {credential['validUntil']}")
    schema = credential.get("credentialSchema")
    if schema:
        print(f"Schema:     {schema.get('id', '')}")
    claims = {k: v for k, v in subject.items() if k != "id"}
    if claims:
        print(f"Claims:     {json.dumps(claims, indent=4)}")
    is_valid = await km.verify_proof(credential)
    print(f"Proof:      {'valid' if is_valid else 'INVALID'}")


async def cmd_publish_credential(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.publish_credential(args.did, {"reveal": False}))


async def cmd_reveal_credential(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.publish_credential(args.did, {"reveal": True}))


async def cmd_unpublish_credential(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.unpublish_credential(args.did))


# Aliases ---------------------------------------------------------------------

async def cmd_add_alias(km: Keymaster, args: argparse.Namespace) -> None:
    await km.add_alias(args.alias, args.did)
    print(UPDATE_OK)


async def cmd_get_alias(km: Keymaster, args: argparse.Namespace) -> None:
    did = await km.get_alias(args.alias)
    print(did if did else f"{args.alias} not found")


async def cmd_remove_alias(km: Keymaster, args: argparse.Namespace) -> None:
    await km.remove_alias(args.alias)
    print(UPDATE_OK)


async def cmd_list_aliases(km: Keymaster, args: argparse.Namespace) -> None:
    aliases = await km.list_aliases()
    if aliases:
        _print_json(aliases)
    else:
        print("No aliases defined")


# Addresses -------------------------------------------------------------------

async def cmd_list_addresses(km: Keymaster, args: argparse.Namespace) -> None:
    addresses = await km.list_addresses()
    if addresses:
        _print_json(addresses)
    else:
        print("No addresses defined")


async def cmd_get_address(km: Keymaster, args: argparse.Namespace) -> None:
    address = await km.get_address(args.domain)
    if address:
        _print_json(address)
    else:
        print(f"{args.domain} not found")


async def cmd_import_address(km: Keymaster, args: argparse.Namespace) -> None:
    addresses = await km.import_address(args.domain)
    if addresses:
        _print_json(addresses)
    else:
        print("No addresses imported")


async def cmd_check_address(km: Keymaster, args: argparse.Namespace) -> None:
    result = await km.check_address(args.address)
    status = result.get("status")
    address = result.get("address")
    if status == "available":
        print(f"{address} is available")
    elif status == "claimed":
        print(f"{address} is claimed by {result.get('did')}")
    elif status == "unsupported":
        print(f"{address} domain does not appear to support names")
    else:
        print(f"{address} domain is unreachable")


async def cmd_add_address(km: Keymaster, args: argparse.Namespace) -> None:
    await km.add_address(args.address)
    print(UPDATE_OK)


async def cmd_remove_address(km: Keymaster, args: argparse.Namespace) -> None:
    await km.remove_address(args.address)
    print(UPDATE_OK)


# Nostr -----------------------------------------------------------------------

async def cmd_add_nostr(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.add_nostr(args.id))


async def cmd_import_nostr(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.import_nostr(args.nsec, args.id))


async def cmd_remove_nostr(km: Keymaster, args: argparse.Namespace) -> None:
    await km.remove_nostr(args.id)
    print(UPDATE_OK)


# Lightning -------------------------------------------------------------------

async def cmd_add_lightning(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.add_lightning(args.id))


async def cmd_remove_lightning(km: Keymaster, args: argparse.Namespace) -> None:
    await km.remove_lightning(args.id)
    print(UPDATE_OK)


async def cmd_lightning_balance(km: Keymaster, args: argparse.Namespace) -> None:
    balance = await km.get_lightning_balance(args.id)
    print(f"{balance.get('balance')} sats")


async def cmd_lightning_decode(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.decode_lightning_invoice(args.bolt11))


async def cmd_lightning_invoice(km: Keymaster, args: argparse.Namespace) -> None:
    invoice = await km.create_lightning_invoice(int(args.amount), args.memo, args.id)
    _print_json(invoice)


async def cmd_lightning_pay(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.pay_lightning_invoice(args.bolt11, args.id))


async def cmd_lightning_check(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.check_lightning_payment(args.payment_hash, args.id))


async def cmd_publish_lightning(km: Keymaster, args: argparse.Namespace) -> None:
    await km.publish_lightning(args.id)
    print(UPDATE_OK)


async def cmd_unpublish_lightning(km: Keymaster, args: argparse.Namespace) -> None:
    await km.unpublish_lightning(args.id)
    print(UPDATE_OK)


async def cmd_lightning_zap(km: Keymaster, args: argparse.Namespace) -> None:
    result = await km.zap_lightning(args.recipient, int(args.amount), args.memo)
    payment_hash = result.get("paymentHash")
    status = await km.check_lightning_payment(payment_hash)
    for _ in range(1, LIGHTNING_ZAP_STATUS_CHECKS):
        if status.get("paid"):
            break
        await asyncio.sleep(LIGHTNING_ZAP_STATUS_DELAY_MS / 1000)
        status = await km.check_lightning_payment(payment_hash)
    _print_json(
        {
            **result,
            "paid": status.get("paid"),
            "status": status.get("status"),
            "preimage": status.get("preimage"),
        }
    )


async def cmd_lightning_payments(km: Keymaster, args: argparse.Namespace) -> None:
    payments = await km.get_lightning_payments(args.id)
    if not payments:
        print("No payments found.")
        return
    for p in payments:
        time_str = p.get("time")
        date = "—"
        if time_str:
            # Format matches TS: YYYY/MM/DD HH:MM:SS
            import datetime as _dt

            try:
                if isinstance(time_str, (int, float)):
                    d = _dt.datetime.fromtimestamp(time_str / 1000 if time_str > 1e12 else time_str)
                else:
                    d = _dt.datetime.fromisoformat(str(time_str).replace("Z", "+00:00"))
                date = d.strftime("%Y/%m/%d %H:%M:%S")
            except Exception:
                date = str(time_str)
        fee = f" (fee: {p['fee']})" if p.get("fee", 0) > 0 else ""
        memo = f' "{p["memo"]}"' if p.get("memo") else ""
        status = " [pending]" if p.get("pending") else ""
        print(f"{date}  {p.get('amount')} sats{fee}{memo}{status}")


# Groups ----------------------------------------------------------------------

async def cmd_create_group(km: Keymaster, args: argparse.Namespace) -> None:
    opts: dict[str, Any] = {}
    if args.alias:
        opts["alias"] = args.alias
    if args.registry:
        opts["registry"] = args.registry
    print(await km.create_group(args.group_name, opts or None))


async def cmd_list_groups(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_groups())


async def cmd_get_group(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.get_group(args.did))


async def cmd_add_group_member(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.add_group_member(args.group, args.member))


async def cmd_remove_group_member(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.remove_group_member(args.group, args.member))


async def cmd_test_group(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.test_group(args.group, args.member))


# Schemas ---------------------------------------------------------------------

async def cmd_create_schema(km: Keymaster, args: argparse.Namespace) -> None:
    schema = json.loads(Path(args.file).read_text(encoding="utf-8"))
    opts: dict[str, Any] = {}
    if args.alias:
        opts["alias"] = args.alias
    if args.registry:
        opts["registry"] = args.registry
    print(await km.create_schema(schema, opts or None))


async def cmd_list_schemas(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_schemas())


async def cmd_get_schema(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.get_schema(args.did))


async def cmd_create_schema_template(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.create_template(args.schema))


# Assets ----------------------------------------------------------------------

def _asset_opts(args: argparse.Namespace) -> dict[str, Any] | None:
    opts: dict[str, Any] = {}
    if getattr(args, "alias", None):
        opts["alias"] = args.alias
    if getattr(args, "registry", None):
        opts["registry"] = args.registry
    return opts or None


async def cmd_create_asset(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.create_asset({}, _asset_opts(args)))


async def cmd_create_asset_json(km: Keymaster, args: argparse.Namespace) -> None:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    print(await km.create_asset(data, _asset_opts(args)))


async def cmd_create_asset_image(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    opts = _asset_opts(args) or {}
    opts["filename"] = Path(args.file).name
    print(await km.create_image(data, opts))


async def cmd_create_asset_file(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    opts = _asset_opts(args) or {}
    opts["filename"] = Path(args.file).name
    opts["bytes"] = len(data)
    print(await km.create_file(data, opts))


async def cmd_get_asset(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.resolve_asset(args.id))


async def cmd_get_asset_json(km: Keymaster, args: argparse.Namespace) -> None:
    asset = await km.resolve_asset(args.id)
    Path(args.file).write_text(json.dumps(asset, indent=4), encoding="utf-8")
    print(f"Data written to {args.file}")


async def cmd_get_asset_image(km: Keymaster, args: argparse.Namespace) -> None:
    image_asset = await km.get_image(args.id)
    file_obj = image_asset.get("file") if image_asset else None
    data = file_obj.get("data") if file_obj else None
    if not data:
        _error("Image not found")
        return
    output_file = args.file or file_obj.get("filename")
    if isinstance(data, str):
        # Python core may return base64 or raw; handle both
        try:
            data_bytes = base64.b64decode(data)
        except Exception:
            data_bytes = data.encode("latin-1")
    else:
        data_bytes = bytes(data)
    Path(output_file).write_bytes(data_bytes)
    print(f"Data written to {output_file}")


async def cmd_get_asset_file(km: Keymaster, args: argparse.Namespace) -> None:
    file_asset = await km.get_file(args.id)
    if not file_asset or not file_asset.get("data"):
        _error("File not found")
        return
    output_file = args.file or file_asset.get("filename")
    data = file_asset["data"]
    if isinstance(data, str):
        try:
            data = base64.b64decode(data)
        except Exception:
            data = data.encode("latin-1")
    Path(output_file).write_bytes(bytes(data))
    print(f"Data written to {output_file}")


async def cmd_update_asset_json(km: Keymaster, args: argparse.Namespace) -> None:
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    ok = await km.merge_data(args.id, data)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_update_asset_image(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    ok = await km.update_image(args.id, data, {"filename": Path(args.file).name})
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_update_asset_file(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    ok = await km.update_file(args.id, data, {"filename": Path(args.file).name, "bytes": len(data)})
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_transfer_asset(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.transfer_asset(args.id, args.controller)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_clone_asset(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.clone_asset(args.id, _asset_opts(args)))


async def cmd_get_property(km: Keymaster, args: argparse.Namespace) -> None:
    doc = await km.resolve_did(args.id)
    data = (doc or {}).get("didDocumentData") or {}
    value = data.get(args.key) if isinstance(data, dict) else None
    if value is not None:
        _print_json(value)


async def cmd_set_property(km: Keymaster, args: argparse.Namespace) -> None:
    parsed: Any = None
    if args.value is not None:
        try:
            parsed = json.loads(args.value)
        except Exception:
            parsed = args.value
    ok = await km.merge_data(args.id, {args.key: parsed})
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_list_assets(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_assets())


# Polls -----------------------------------------------------------------------

async def cmd_create_poll_template(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.poll_template())


async def cmd_create_poll(km: Keymaster, args: argparse.Namespace) -> None:
    config = json.loads(Path(args.file).read_text(encoding="utf-8"))
    print(await km.create_poll(config, _asset_opts(args)))


async def cmd_add_poll_voter(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.add_poll_voter(args.poll, args.member)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_remove_poll_voter(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.remove_poll_voter(args.poll, args.member)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_list_poll_voters(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_poll_voters(args.poll))


async def cmd_view_poll(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.view_poll(args.poll))


async def cmd_vote_poll(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.vote_poll(args.poll, int(args.vote)))


async def cmd_send_poll(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.send_poll(args.poll))


async def cmd_send_ballot(km: Keymaster, args: argparse.Namespace) -> None:
    print(await km.send_ballot(args.ballot, args.poll))


async def cmd_view_ballot(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.view_ballot(args.ballot))


async def cmd_update_poll(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.update_poll(args.ballot)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_publish_poll(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.publish_poll(args.poll)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_reveal_poll(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.publish_poll(args.poll, {"reveal": True})
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_unpublish_poll(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.unpublish_poll(args.poll)
    print(UPDATE_OK if ok else UPDATE_FAILED)


# Vaults ----------------------------------------------------------------------

async def cmd_create_vault(km: Keymaster, args: argparse.Namespace) -> None:
    opts: dict[str, Any] = {}
    if args.alias:
        opts["alias"] = args.alias
    if args.registry:
        opts["registry"] = args.registry
    if args.secret_members:
        opts["secretMembers"] = True
    print(await km.create_vault(opts or None))


async def cmd_list_vault_items(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_vault_items(args.id))


async def cmd_add_vault_member(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.add_vault_member(args.id, args.member)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_remove_vault_member(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.remove_vault_member(args.id, args.member)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_list_vault_members(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_vault_members(args.id))


async def cmd_add_vault_item(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    ok = await km.add_vault_item(args.id, Path(args.file).name, data)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_remove_vault_item(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.remove_vault_item(args.id, args.item)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_get_vault_item(km: Keymaster, args: argparse.Namespace) -> None:
    data = await km.get_vault_item(args.id, args.item)
    if data:
        Path(args.file).write_bytes(bytes(data))
        print(f"Data written to {args.file}")
    else:
        _error(f"Item {args.item} not found in vault")


# Dmail -----------------------------------------------------------------------

async def cmd_create_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    message = json.loads(Path(args.file).read_text(encoding="utf-8"))
    print(await km.create_dmail(message, _asset_opts(args)))


async def cmd_update_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    message = json.loads(Path(args.file).read_text(encoding="utf-8"))
    ok = await km.update_dmail(args.did, message)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_send_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    notice = await km.send_dmail(args.did)
    if notice:
        print(notice)
    else:
        _error("Send failed")


async def cmd_get_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    message = await km.get_dmail_message(args.did)
    if message:
        _print_json(message)
    else:
        _error("Dmail not found")


async def cmd_list_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_dmail())


async def cmd_file_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    tag_list = [t.strip() for t in args.tags.split(",")]
    ok = await km.file_dmail(args.did, tag_list)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_refresh_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.refresh_notices()
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_import_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.import_dmail(args.did)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_remove_dmail(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.remove_dmail(args.did)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_add_dmail_attachment(km: Keymaster, args: argparse.Namespace) -> None:
    data = Path(args.file).read_bytes()
    ok = await km.add_dmail_attachment(args.did, Path(args.file).name, data)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_remove_dmail_attachment(km: Keymaster, args: argparse.Namespace) -> None:
    ok = await km.remove_dmail_attachment(args.did, args.name)
    print(UPDATE_OK if ok else UPDATE_FAILED)


async def cmd_get_dmail_attachment(km: Keymaster, args: argparse.Namespace) -> None:
    data = await km.get_dmail_attachment(args.did, args.name)
    if data:
        Path(args.file).write_bytes(bytes(data))
        print(f"Data written to {args.file}")
    else:
        _error(f"Attachment {args.name} not found")


async def cmd_list_dmail_attachments(km: Keymaster, args: argparse.Namespace) -> None:
    _print_json(await km.list_dmail_attachments(args.did))


# ---------------------------------------------------------------------------
# Parser construction
# ---------------------------------------------------------------------------

def _add_alias_registry(p: argparse.ArgumentParser) -> None:
    p.add_argument("-a", "--alias", help="DID alias")
    p.add_argument("-r", "--registry", help="registry to use")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="keymaster",
        description="Keymaster CLI - Archon wallet management tool",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    def add(name: str, description: str, handler: Callable[..., Any]) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=description, description=description)
        sp.set_defaults(handler=handler)
        return sp

    # Wallet
    add("create-wallet", "Create a new wallet (or show existing wallet)", cmd_create_wallet)
    add("new-wallet", "Create a new wallet", cmd_new_wallet)
    sp = add("change-passphrase", "Re-encrypt wallet with a new passphrase", cmd_change_passphrase)
    sp.add_argument("new_passphrase")
    add("check-wallet", "Validate DIDs in wallet", cmd_check_wallet)
    add("fix-wallet", "Remove invalid DIDs from the wallet", cmd_fix_wallet)
    sp = add("import-wallet", "Create new wallet from a recovery phrase", cmd_import_wallet)
    sp.add_argument("recovery_phrase")
    add("show-wallet", "Show wallet", cmd_show_wallet)
    sp = add("backup-wallet-file", "Backup wallet to file", cmd_backup_wallet_file)
    sp.add_argument("file")
    sp = add("restore-wallet-file", "Restore wallet from backup file", cmd_restore_wallet_file)
    sp.add_argument("file")
    add("show-mnemonic", "Show recovery phrase for wallet", cmd_show_mnemonic)
    add("backup-wallet-did", "Backup wallet to encrypted DID and seed bank", cmd_backup_wallet_did)
    sp = add("recover-wallet-did", "Recover wallet from seed bank or encrypted DID", cmd_recover_wallet_did)
    sp.add_argument("did", nargs="?")

    # Identity
    sp = add("create-id", "Create a new decentralized ID", cmd_create_id)
    sp.add_argument("name")
    sp.add_argument("-r", "--registry", help="registry to use")
    add("resolve-id", "Resolves the current ID", cmd_resolve_id)
    add("backup-id", "Backup the current ID to its registry", cmd_backup_id)
    sp = add("recover-id", "Recovers the ID from the DID", cmd_recover_id)
    sp.add_argument("did")
    sp = add("remove-id", "Deletes named ID", cmd_remove_id)
    sp.add_argument("name")
    sp = add("rename-id", "Renames the ID", cmd_rename_id)
    sp.add_argument("old_name")
    sp.add_argument("new_name")
    add("list-ids", "List IDs and show current ID", cmd_list_ids)
    sp = add("use-id", "Set the current ID", cmd_use_id)
    sp.add_argument("name")
    add("rotate-keys", "Generates new set of keys for current ID", cmd_rotate_keys)

    # DID
    sp = add("resolve-did", "Return document associated with DID", cmd_resolve_did)
    sp.add_argument("did")
    sp.add_argument("confirm", nargs="?")
    sp = add("resolve-did-version", "Return specified version of document associated with DID", cmd_resolve_did_version)
    sp.add_argument("did")
    sp.add_argument("version")
    sp = add("revoke-did", "Permanently revoke a DID", cmd_revoke_did)
    sp.add_argument("did")
    sp = add("change-registry", "Changes the registry for an existing DID", cmd_change_registry)
    sp.add_argument("id")
    sp.add_argument("registry")

    # Encryption
    sp = add("encrypt-message", "Encrypt a message for a DID", cmd_encrypt_message)
    sp.add_argument("message")
    sp.add_argument("did")
    sp = add("encrypt-file", "Encrypt a file for a DID", cmd_encrypt_file)
    sp.add_argument("file")
    sp.add_argument("did")
    sp = add("decrypt-did", "Decrypt an encrypted message DID", cmd_decrypt_did)
    sp.add_argument("did")
    sp = add("decrypt-json", "Decrypt an encrypted JSON DID", cmd_decrypt_json)
    sp.add_argument("did")

    # Signing
    sp = add("sign-file", "Sign a JSON file", cmd_sign_file)
    sp.add_argument("file")
    sp = add("verify-file", "Verify the proof in a JSON file", cmd_verify_file)
    sp.add_argument("file")

    # Challenge / response
    sp = add("create-challenge", "Create a challenge (optionally from a file)", cmd_create_challenge)
    sp.add_argument("file", nargs="?")
    sp.add_argument("-a", "--alias", help="DID alias")
    sp = add("create-challenge-cc", "Create a challenge from a credential DID", cmd_create_challenge_cc)
    sp.add_argument("did")
    sp.add_argument("-a", "--alias", help="DID alias")
    sp = add("create-response", "Create a response to a challenge", cmd_create_response)
    sp.add_argument("challenge")
    sp = add("verify-response", "Decrypt and validate a response to a challenge", cmd_verify_response)
    sp.add_argument("response")

    # Credentials
    sp = add("bind-credential", "Create bound credential for a user", cmd_bind_credential)
    sp.add_argument("schema")
    sp.add_argument("subject")
    sp = add("issue-credential", "Sign and encrypt a bound credential file", cmd_issue_credential)
    sp.add_argument("file")
    _add_alias_registry(sp)
    add("list-issued", "List issued credentials", cmd_list_issued)
    sp = add("update-credential", "Update an issued credential", cmd_update_credential)
    sp.add_argument("did")
    sp.add_argument("file")
    sp = add("revoke-credential", "Revokes a verifiable credential", cmd_revoke_credential)
    sp.add_argument("did")
    sp = add("accept-credential", "Save verifiable credential for current ID", cmd_accept_credential)
    sp.add_argument("did")
    sp.add_argument("-a", "--alias", help="DID alias")
    add("list-credentials", "List credentials by current ID", cmd_list_credentials)
    sp = add("get-credential", "Get credential by DID", cmd_get_credential)
    sp.add_argument("did")
    sp = add("view-credential", "Decrypt and display a credential in human-readable format", cmd_view_credential)
    sp.add_argument("did")
    sp = add("publish-credential", "Publish the existence of a credential to the current user manifest", cmd_publish_credential)
    sp.add_argument("did")
    sp = add("reveal-credential", "Reveal a credential to the current user manifest", cmd_reveal_credential)
    sp.add_argument("did")
    sp = add("unpublish-credential", "Remove a credential from the current user manifest", cmd_unpublish_credential)
    sp.add_argument("did")

    # Aliases
    sp = add("add-alias", "Add an alias for a DID", cmd_add_alias)
    sp.add_argument("alias")
    sp.add_argument("did")
    sp = add("get-alias", "Get DID assigned to alias", cmd_get_alias)
    sp.add_argument("alias")
    sp = add("remove-alias", "Removes an alias for a DID", cmd_remove_alias)
    sp.add_argument("alias")
    add("list-aliases", "List DID aliases", cmd_list_aliases)

    # Addresses
    add("list-addresses", "List wallet addresses", cmd_list_addresses)
    sp = add("get-address", "Get the current address for a domain", cmd_get_address)
    sp.add_argument("domain")
    sp = add("import-address", "Import any existing address for the current ID from a domain", cmd_import_address)
    sp.add_argument("domain")
    sp = add("check-address", "Check whether an address is available", cmd_check_address)
    sp.add_argument("address")
    sp = add("add-address", "Claim an address for the current ID", cmd_add_address)
    sp.add_argument("address")
    sp = add("remove-address", "Remove an address for the current ID", cmd_remove_address)
    sp.add_argument("address")

    # Nostr
    sp = add("add-nostr", "Derive and add nostr keys to an agent DID", cmd_add_nostr)
    sp.add_argument("id", nargs="?")
    sp = add("import-nostr", "Import nostr keys for an agent DID from an nsec private key", cmd_import_nostr)
    sp.add_argument("nsec")
    sp.add_argument("id", nargs="?")
    sp = add("remove-nostr", "Remove nostr keys from an agent DID", cmd_remove_nostr)
    sp.add_argument("id", nargs="?")

    # Lightning
    sp = add("add-lightning", "Create a Lightning wallet for a DID", cmd_add_lightning)
    sp.add_argument("id", nargs="?")
    sp = add("remove-lightning", "Remove Lightning wallet from a DID", cmd_remove_lightning)
    sp.add_argument("id", nargs="?")
    sp = add("lightning-balance", "Check Lightning wallet balance", cmd_lightning_balance)
    sp.add_argument("id", nargs="?")
    sp = add("lightning-decode", "Decode a Lightning BOLT11 invoice", cmd_lightning_decode)
    sp.add_argument("bolt11")
    sp = add("lightning-invoice", "Create a Lightning invoice to receive sats", cmd_lightning_invoice)
    sp.add_argument("amount")
    sp.add_argument("memo")
    sp.add_argument("id", nargs="?")
    sp = add("lightning-pay", "Pay a Lightning invoice", cmd_lightning_pay)
    sp.add_argument("bolt11")
    sp.add_argument("id", nargs="?")
    sp = add("lightning-check", "Check status of a Lightning payment", cmd_lightning_check)
    sp.add_argument("payment_hash", metavar="paymentHash")
    sp.add_argument("id", nargs="?")
    sp = add("publish-lightning", "Publish Lightning service endpoint for a DID", cmd_publish_lightning)
    sp.add_argument("id", nargs="?")
    sp = add("unpublish-lightning", "Remove Lightning service endpoint from a DID", cmd_unpublish_lightning)
    sp.add_argument("id", nargs="?")
    sp = add("lightning-zap", "Send sats via Lightning (DID, alias, or Lightning Address)", cmd_lightning_zap)
    sp.add_argument("recipient")
    sp.add_argument("amount")
    sp.add_argument("memo", nargs="?")
    sp = add("lightning-payments", "Show Lightning payment history", cmd_lightning_payments)
    sp.add_argument("id", nargs="?")

    # Groups
    sp = add("create-group", "Create a new group", cmd_create_group)
    sp.add_argument("group_name", metavar="groupName")
    _add_alias_registry(sp)
    add("list-groups", "List groups owned by current ID", cmd_list_groups)
    sp = add("get-group", "Get group by DID", cmd_get_group)
    sp.add_argument("did")
    sp = add("add-group-member", "Add a member to a group", cmd_add_group_member)
    sp.add_argument("group")
    sp.add_argument("member")
    sp = add("remove-group-member", "Remove a member from a group", cmd_remove_group_member)
    sp.add_argument("group")
    sp.add_argument("member")
    sp = add("test-group", "Determine if a member is in a group", cmd_test_group)
    sp.add_argument("group")
    sp.add_argument("member", nargs="?")

    # Schemas
    sp = add("create-schema", "Create a schema from a file", cmd_create_schema)
    sp.add_argument("file")
    _add_alias_registry(sp)
    add("list-schemas", "List schemas owned by current ID", cmd_list_schemas)
    sp = add("get-schema", "Get schema by DID", cmd_get_schema)
    sp.add_argument("did")
    sp = add("create-schema-template", "Create a template from a schema", cmd_create_schema_template)
    sp.add_argument("schema")

    # Assets
    sp = add("create-asset", "Create an empty asset", cmd_create_asset)
    _add_alias_registry(sp)
    sp = add("create-asset-json", "Create an asset from a JSON file", cmd_create_asset_json)
    sp.add_argument("file")
    _add_alias_registry(sp)
    sp = add("create-asset-image", "Create an asset from an image file", cmd_create_asset_image)
    sp.add_argument("file")
    _add_alias_registry(sp)
    sp = add("create-asset-file", "Create an asset from a file", cmd_create_asset_file)
    sp.add_argument("file")
    _add_alias_registry(sp)
    sp = add("get-asset", "Get asset by name or DID", cmd_get_asset)
    sp.add_argument("id")
    sp = add("get-asset-json", "Save a JSON asset to a file", cmd_get_asset_json)
    sp.add_argument("id")
    sp.add_argument("file")
    sp = add("get-asset-image", "Save an image asset to a file", cmd_get_asset_image)
    sp.add_argument("id")
    sp.add_argument("file", nargs="?")
    sp = add("get-asset-file", "Save a file asset to a file", cmd_get_asset_file)
    sp.add_argument("id")
    sp.add_argument("file", nargs="?")
    sp = add("update-asset-json", "Update an asset from a JSON file", cmd_update_asset_json)
    sp.add_argument("id")
    sp.add_argument("file")
    sp = add("update-asset-image", "Update an asset from an image file", cmd_update_asset_image)
    sp.add_argument("id")
    sp.add_argument("file")
    sp = add("update-asset-file", "Update an asset from a file", cmd_update_asset_file)
    sp.add_argument("id")
    sp.add_argument("file")
    sp = add("transfer-asset", "Transfer asset to a new controller", cmd_transfer_asset)
    sp.add_argument("id")
    sp.add_argument("controller")
    sp = add("clone-asset", "Clone an asset", cmd_clone_asset)
    sp.add_argument("id")
    _add_alias_registry(sp)
    sp = add("get-property", "Get a property value from a DID", cmd_get_property)
    sp.add_argument("id")
    sp.add_argument("key")
    sp = add("set-property", "Assign a key-value pair to a DID", cmd_set_property)
    sp.add_argument("id")
    sp.add_argument("key")
    sp.add_argument("value", nargs="?")
    add("list-assets", "List assets owned by current ID", cmd_list_assets)

    # Polls
    add("create-poll-template", "Create a poll template", cmd_create_poll_template)
    sp = add("create-poll", "Create a poll", cmd_create_poll)
    sp.add_argument("file")
    _add_alias_registry(sp)
    sp = add("add-poll-voter", "Add a voter to the poll", cmd_add_poll_voter)
    sp.add_argument("poll")
    sp.add_argument("member")
    sp = add("remove-poll-voter", "Remove a voter from the poll", cmd_remove_poll_voter)
    sp.add_argument("poll")
    sp.add_argument("member")
    sp = add("list-poll-voters", "List eligible voters in the poll", cmd_list_poll_voters)
    sp.add_argument("poll")
    sp = add("view-poll", "View poll details", cmd_view_poll)
    sp.add_argument("poll")
    sp = add("vote-poll", "Vote in a poll (0 to spoil)", cmd_vote_poll)
    sp.add_argument("poll")
    sp.add_argument("vote")
    sp = add("send-poll", "Send a poll notice to all voters", cmd_send_poll)
    sp.add_argument("poll")
    sp = add("send-ballot", "Send a ballot to the poll owner", cmd_send_ballot)
    sp.add_argument("ballot")
    sp.add_argument("poll")
    sp = add("view-ballot", "View ballot details", cmd_view_ballot)
    sp.add_argument("ballot")
    sp = add("update-poll", "Add a ballot to the poll", cmd_update_poll)
    sp.add_argument("ballot")
    sp = add("publish-poll", "Publish results to poll, hiding ballots", cmd_publish_poll)
    sp.add_argument("poll")
    sp = add("reveal-poll", "Publish results to poll, revealing ballots", cmd_reveal_poll)
    sp.add_argument("poll")
    sp = add("unpublish-poll", "Remove results from poll", cmd_unpublish_poll)
    sp.add_argument("poll")

    # Vaults
    sp = add("create-vault", "Create a vault", cmd_create_vault)
    _add_alias_registry(sp)
    sp.add_argument("-s", "--secret-members", dest="secret_members", action="store_true",
                    help="keep member list secret from each other")
    sp = add("list-vault-items", "List items in the vault", cmd_list_vault_items)
    sp.add_argument("id")
    sp = add("add-vault-member", "Add a member to a vault", cmd_add_vault_member)
    sp.add_argument("id")
    sp.add_argument("member")
    sp = add("remove-vault-member", "Remove a member from a vault", cmd_remove_vault_member)
    sp.add_argument("id")
    sp.add_argument("member")
    sp = add("list-vault-members", "List members of a vault", cmd_list_vault_members)
    sp.add_argument("id")
    sp = add("add-vault-item", "Add an item (file) to a vault", cmd_add_vault_item)
    sp.add_argument("id")
    sp.add_argument("file")
    sp = add("remove-vault-item", "Remove an item from a vault", cmd_remove_vault_item)
    sp.add_argument("id")
    sp.add_argument("item")
    sp = add("get-vault-item", "Save an item from a vault to a file", cmd_get_vault_item)
    sp.add_argument("id")
    sp.add_argument("item")
    sp.add_argument("file")

    # Dmail
    sp = add("create-dmail", "Create a new dmail from a JSON file", cmd_create_dmail)
    sp.add_argument("file")
    _add_alias_registry(sp)
    sp = add("update-dmail", "Update an existing dmail from a JSON file", cmd_update_dmail)
    sp.add_argument("did")
    sp.add_argument("file")
    sp = add("send-dmail", "Send a dmail and return the notice DID", cmd_send_dmail)
    sp.add_argument("did")
    sp = add("get-dmail", "Get a dmail message by DID", cmd_get_dmail)
    sp.add_argument("did")
    add("list-dmail", "List dmails for current ID", cmd_list_dmail)
    sp = add("file-dmail", "Assign tags to a dmail (comma-separated, e.g. inbox,unread)", cmd_file_dmail)
    sp.add_argument("did")
    sp.add_argument("tags")
    add("refresh-dmail", "Check for new dmails and clean up expired notices", cmd_refresh_dmail)
    sp = add("import-dmail", "Import a dmail into inbox with unread tag", cmd_import_dmail)
    sp.add_argument("did")
    sp = add("remove-dmail", "Delete a dmail", cmd_remove_dmail)
    sp.add_argument("did")
    sp = add("add-dmail-attachment", "Add a file attachment to a dmail", cmd_add_dmail_attachment)
    sp.add_argument("did")
    sp.add_argument("file")
    sp = add("remove-dmail-attachment", "Remove an attachment from a dmail", cmd_remove_dmail_attachment)
    sp.add_argument("did")
    sp.add_argument("name")
    sp = add("get-dmail-attachment", "Save a dmail attachment to a file", cmd_get_dmail_attachment)
    sp.add_argument("did")
    sp.add_argument("name")
    sp.add_argument("file")
    sp = add("list-dmail-attachments", "List attachments of a dmail", cmd_list_dmail_attachments)
    sp.add_argument("did")

    return parser


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def _run(args: argparse.Namespace) -> int:
    gatekeeper_url = (
        os.environ.get("ARCHON_NODE_URL")
        or os.environ.get("ARCHON_GATEKEEPER_URL")
        or "http://localhost:4224"
    )
    wallet_path = os.environ.get("ARCHON_WALLET_PATH", "./wallet.json")
    passphrase = os.environ.get("ARCHON_PASSPHRASE")
    default_registry = os.environ.get("ARCHON_DEFAULT_REGISTRY")

    if not passphrase:
        print("Error: ARCHON_PASSPHRASE environment variable is required", file=sys.stderr)
        print("Set it with: export ARCHON_PASSPHRASE=your-passphrase", file=sys.stderr)
        return 1

    wallet_path_obj = Path(wallet_path)
    wallet_store = JsonWalletStore(
        wallet_file_name=wallet_path_obj.name,
        data_folder=str(wallet_path_obj.parent) if wallet_path_obj.parent.as_posix() else ".",
    )

    if args.command not in WALLET_CREATION_COMMANDS:
        existing = wallet_store.load_wallet()
        if not existing:
            print(f"Error: Wallet not found at {wallet_path}", file=sys.stderr)
            print(
                "Set ARCHON_WALLET_PATH or ensure wallet.json exists in the current directory.",
                file=sys.stderr,
            )
            print("To create a new wallet, run: keymaster create-wallet", file=sys.stderr)
            return 1

    gatekeeper = GatekeeperClient(gatekeeper_url)
    try:
        try:
            await gatekeeper.connect(wait_until_ready=True, interval_seconds=3)
        except Exception as exc:  # pragma: no cover - network failures are user-visible
            print(f"Failed to initialize: {exc}", file=sys.stderr)
            return 1

        km = Keymaster(
            gatekeeper=gatekeeper,
            wallet_store=wallet_store,
            passphrase=passphrase,
            default_registry=default_registry or "hyperswarm",
        )

        try:
            await args.handler(km, args)
        except Exception as exc:
            _error(getattr(exc, "error", None) or str(exc))
        return 0
    finally:
        await gatekeeper.close()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
