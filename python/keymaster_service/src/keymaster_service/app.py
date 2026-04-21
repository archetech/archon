from __future__ import annotations

from contextlib import asynccontextmanager
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .runtime import KeymasterServiceError
from .service import service, settings


logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)


def parse_options_header(request: Request) -> dict[str, Any]:
    options_header = request.headers.get("x-options") or "{}"
    return json.loads(options_header) if options_header else {}


def apply_content_length(options: dict[str, Any], request: Request) -> dict[str, Any]:
    if options.get("bytes"):
        return options
    content_length = request.headers.get("content-length")
    if not isinstance(content_length, str):
        return options

    try:
        parsed_bytes = int(content_length)
    except ValueError:
        return options
    if parsed_bytes >= 0:
        options["bytes"] = parsed_bytes
    return options


def parse_resolve_options(request: Request) -> dict[str, Any]:
    options: dict[str, Any] = {}
    for key, value in request.query_params.items():
        if isinstance(value, str) and value:
            options[key] = value
    return options


@asynccontextmanager
async def lifespan(_: FastAPI):
    LOGGER.info("Keymaster server v%s (%s) running on %s:%s", settings.service_version, settings.git_commit, settings.bind_address, settings.keymaster_port)
    LOGGER.info("Keymaster server persisting to %s", settings.keymaster_db)
    if settings.admin_api_key:
        LOGGER.info("Admin API key protection is ENABLED")
    else:
        LOGGER.warning("ARCHON_ADMIN_API_KEY is not set — admin routes are unprotected")
    await service.startup()
    try:
        yield
    finally:
        await service.shutdown()


app = FastAPI(lifespan=lifespan)
public_api = APIRouter(prefix="/api/v1")


@app.exception_handler(KeymasterServiceError)
async def keymaster_error_handler(_: Request, exc: KeymasterServiceError):
    return JSONResponse(status_code=500, content={"error": str(exc)})


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def generic_error_handler(_: Request, exc: Exception):
    LOGGER.exception("Unhandled exception", exc_info=exc)
    return JSONResponse(status_code=500, content={"error": str(exc)})


async def require_admin_key(request: Request) -> None:
    if not settings.admin_api_key:
        return
    header_key = request.headers.get("x-archon-admin-key")
    auth_header = request.headers.get("authorization", "")
    bearer_key = auth_header[7:] if auth_header.lower().startswith("bearer ") else None
    if header_key != settings.admin_api_key and bearer_key != settings.admin_api_key:
        raise HTTPException(status_code=401, detail="Unauthorized — valid admin API key required")


protected_api = APIRouter(prefix="/api/v1", dependencies=[Depends(require_admin_key)])


@public_api.get("/ready")
async def ready() -> dict[str, bool]:
    return {"ready": service.server_ready}


@public_api.get("/version")
async def version() -> dict[str, str]:
    return {"version": settings.service_version, "commit": settings.git_commit}


@public_api.post("/login")
async def login(body: dict[str, Any]) -> dict[str, str]:
    passphrase = body.get("passphrase", "")
    if not settings.passphrase:
        return {"adminApiKey": settings.admin_api_key or ""}
    if passphrase != settings.passphrase:
        raise HTTPException(status_code=401, detail="Incorrect passphrase")
    return {"adminApiKey": settings.admin_api_key or ""}


@protected_api.get("/registries")
async def registries() -> dict[str, list[str]]:
    return {"registries": await service.list_registries()}


@protected_api.get("/wallet")
async def wallet() -> dict[str, Any]:
    return {"wallet": await service.load_wallet()}


@protected_api.put("/wallet")
async def save_wallet(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.save_wallet(body["wallet"], overwrite=True)}


@protected_api.post("/wallet/new")
async def new_wallet(body: dict[str, Any]) -> dict[str, Any]:
    return {"wallet": await service.new_wallet(body.get("mnemonic"), bool(body.get("overwrite", False)))}


@protected_api.post("/wallet/backup")
async def backup_wallet() -> dict[str, str]:
    return {"ok": await service.backup_wallet()}


@protected_api.post("/wallet/recover")
async def recover_wallet() -> dict[str, Any]:
    return {"wallet": await service.recover_wallet()}


@protected_api.post("/wallet/check")
async def check_wallet() -> dict[str, Any]:
    return {"check": await service.check_wallet()}


@protected_api.post("/wallet/fix")
async def fix_wallet() -> dict[str, Any]:
    return {"fix": await service.fix_wallet()}


@protected_api.get("/wallet/mnemonic")
async def wallet_mnemonic() -> dict[str, str]:
    return {"mnemonic": await service.decrypt_mnemonic()}


@protected_api.post("/wallet/passphrase")
async def wallet_passphrase(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.change_passphrase(body["passphrase"])}


@protected_api.get("/export/wallet/encrypted")
async def export_wallet_encrypted() -> dict[str, Any]:
    return {"wallet": await service.export_encrypted_wallet()}


@protected_api.get("/ids/current")
async def ids_current() -> dict[str, Any]:
    return {"current": await service.get_current_id()}


@protected_api.put("/ids/current")
async def set_ids_current(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.set_current_id(body["name"])}


@protected_api.get("/ids")
async def list_ids() -> dict[str, list[str]]:
    return {"ids": await service.list_ids()}


@protected_api.post("/ids")
async def create_id(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_id(body["name"], body.get("options") or {})}


@protected_api.get("/ids/{identifier}")
async def get_id(identifier: str) -> dict[str, Any]:
    return {"docs": await service.resolve_did(identifier)}


@protected_api.delete("/ids/{identifier}")
async def delete_id(identifier: str) -> dict[str, bool]:
    return {"ok": await service.remove_id(identifier)}


@protected_api.post("/ids/{identifier}/rename")
async def rename_id(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.rename_id(identifier, body["name"])}


@protected_api.post("/ids/{identifier}/change-registry")
async def change_registry(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.change_registry(identifier, body["registry"])}


@protected_api.post("/ids/{identifier}/backup")
async def backup_id(identifier: str) -> dict[str, bool]:
    return {"ok": await service.backup_id(identifier)}


@protected_api.post("/ids/{identifier}/recover")
async def recover_id(identifier: str, body: dict[str, Any] | None = None) -> dict[str, str]:
    return {"recovered": await service.recover_id((body or {}).get("did") or identifier)}


@protected_api.get("/aliases")
async def aliases() -> dict[str, Any]:
    return {"aliases": await service.list_aliases()}


@protected_api.post("/aliases")
async def add_alias(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.add_alias(body["alias"], body["did"])}


@protected_api.get("/aliases/{alias}")
async def get_alias(alias: str) -> dict[str, Any]:
    return {"did": await service.get_alias(alias)}


@protected_api.delete("/aliases/{alias}")
async def remove_alias(alias: str) -> dict[str, bool]:
    return {"ok": await service.remove_alias(alias)}


@protected_api.get("/addresses")
async def list_addresses() -> dict[str, Any]:
    return {"addresses": await service.list_addresses()}


@protected_api.get("/addresses/{domain}")
async def get_address(domain: str) -> dict[str, Any]:
    return {"address": await service.get_address(domain)}


@protected_api.post("/addresses/import")
async def import_address(body: dict[str, Any]) -> dict[str, Any]:
    return {"addresses": await service.import_address(body["domain"])}


@protected_api.get("/addresses/check/{address}")
async def check_address(address: str) -> dict[str, Any]:
    return await service.check_address(address)


@protected_api.post("/addresses")
async def add_address(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.add_address(body["address"])}


@protected_api.delete("/addresses/{address}")
async def remove_address(address: str) -> dict[str, bool]:
    return {"ok": await service.remove_address(address)}


@protected_api.post("/nostr")
async def add_nostr(body: dict[str, Any]) -> dict[str, Any]:
    return await service.add_nostr(body.get("id"))


@protected_api.delete("/nostr")
async def remove_nostr(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.remove_nostr(body.get("id"))}


@protected_api.post("/nostr/import")
async def import_nostr(body: dict[str, Any]) -> dict[str, Any]:
    return await service.import_nostr(body["nsec"], body.get("id"))


@protected_api.post("/nostr/nsec")
async def export_nsec(body: dict[str, Any]) -> dict[str, str]:
    return {"nsec": await service.export_nsec(body.get("id"))}


@protected_api.post("/nostr/sign")
async def sign_nostr_event(body: dict[str, Any]) -> dict[str, Any]:
    return await service.sign_nostr_event(body["event"])


@protected_api.post("/lightning")
async def add_lightning(body: dict[str, Any]) -> dict[str, Any]:
    return await service.add_lightning(body.get("id"))


@protected_api.delete("/lightning")
async def remove_lightning(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.remove_lightning(body.get("id"))}


@protected_api.post("/lightning/balance")
async def get_lightning_balance(body: dict[str, Any]) -> dict[str, Any]:
    return await service.get_lightning_balance(body.get("id"))


@protected_api.post("/lightning/invoice")
async def create_lightning_invoice(body: dict[str, Any]) -> dict[str, Any]:
    return await service.create_lightning_invoice(body["amount"], body.get("memo", ""), body.get("id"))


@protected_api.post("/lightning/pay")
async def pay_lightning_invoice(body: dict[str, Any]) -> dict[str, Any]:
    return await service.pay_lightning_invoice(body["bolt11"], body.get("id"))


@protected_api.post("/lightning/payment")
async def check_lightning_payment(body: dict[str, Any]) -> dict[str, Any]:
    return await service.check_lightning_payment(body["paymentHash"], body.get("id"))


@protected_api.post("/lightning/decode")
async def decode_lightning_invoice(body: dict[str, Any]) -> dict[str, Any]:
    return await service.decode_lightning_invoice(body["bolt11"])


@protected_api.post("/lightning/publish")
async def publish_lightning(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.publish_lightning(body.get("id"))}


@protected_api.post("/lightning/unpublish")
async def unpublish_lightning(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.unpublish_lightning(body.get("id"))}


@protected_api.post("/lightning/zap")
async def zap_lightning(body: dict[str, Any]) -> dict[str, Any]:
    return await service.zap_lightning(body["did"], body["amount"], body.get("memo"), body.get("id"))


@protected_api.post("/lightning/payments")
async def get_lightning_payments(body: dict[str, Any]) -> dict[str, Any]:
    return {"payments": await service.get_lightning_payments(body.get("id"))}


@protected_api.get("/did/{identifier}")
async def resolve_did(identifier: str, request: Request) -> dict[str, Any]:
    return {"docs": await service.resolve_did(identifier, parse_resolve_options(request) or None)}


@protected_api.put("/did/{identifier}")
async def update_did(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_did(identifier, body["doc"])}


@protected_api.delete("/did/{identifier}")
async def revoke_did(identifier: str) -> dict[str, bool]:
    return {"ok": await service.revoke_did(identifier)}


@protected_api.post("/agents/{identifier}/test")
async def test_agent(identifier: str) -> dict[str, bool]:
    return {"test": await service.test_agent(identifier)}


@protected_api.post("/credentials/bind")
async def bind_credential(body: dict[str, Any]) -> dict[str, Any]:
    return {"credential": await service.bind_credential(body["subject"], body.get("options") or {})}


@protected_api.get("/credentials/held")
async def list_credentials() -> dict[str, Any]:
    return {"held": await service.list_credentials()}


@protected_api.post("/credentials/held")
async def accept_credential(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.accept_credential(body["did"])}


@protected_api.get("/credentials/held/{identifier}")
async def get_credential(identifier: str) -> dict[str, Any]:
    return {"credential": await service.get_credential(identifier)}


@protected_api.delete("/credentials/held/{identifier}")
async def remove_credential(identifier: str) -> dict[str, bool]:
    return {"ok": await service.remove_credential(identifier)}


@protected_api.post("/credentials/held/{identifier}/publish")
async def publish_credential(identifier: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"ok": await service.publish_credential(identifier, body.get("options") or {})}


@protected_api.post("/credentials/held/{identifier}/unpublish")
async def unpublish_credential(identifier: str) -> dict[str, Any]:
    return {"ok": await service.unpublish_credential(identifier)}


@protected_api.get("/credentials/issued")
async def list_issued() -> dict[str, Any]:
    return {"issued": await service.list_issued()}


@protected_api.post("/credentials/issued")
async def issue_credential(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.issue_credential(body.get("credential"), body.get("options") or {})}


@protected_api.get("/credentials/issued/{identifier}")
async def get_issued_credential(identifier: str) -> dict[str, Any]:
    return {"credential": await service.get_credential(identifier)}


@protected_api.post("/credentials/issued/{identifier}/send")
async def send_credential(identifier: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"did": await service.send_credential(identifier, body.get("options") or {})}


@protected_api.post("/credentials/issued/{identifier}")
async def update_credential(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_credential(identifier, body["credential"])}


@protected_api.delete("/credentials/issued/{identifier}")
async def revoke_credential(identifier: str) -> dict[str, bool]:
    return {"ok": await service.revoke_credential(identifier)}


@protected_api.get("/assets")
async def list_assets(owner: str | None = None) -> dict[str, Any]:
    return {"assets": await service.list_assets(owner)}


@protected_api.post("/assets")
async def create_asset(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_asset(body["data"], body.get("options") or {})}


@protected_api.get("/assets/{identifier}")
async def get_asset(identifier: str, request: Request) -> dict[str, Any]:
    return {"asset": await service.resolve_asset(identifier, parse_resolve_options(request))}


@protected_api.put("/assets/{identifier}")
async def update_asset(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.merge_data(identifier, body["data"])}


@protected_api.post("/assets/{identifier}/transfer")
async def transfer_asset(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.transfer_asset(identifier, body["controller"])}


@protected_api.post("/assets/{identifier}/clone")
async def clone_asset(identifier: str, body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.clone_asset(identifier, body.get("options") or {})}


@protected_api.post("/images")
async def create_image(request: Request) -> dict[str, str]:
    return {"did": await service.create_image(await request.body(), parse_options_header(request))}


@protected_api.put("/images/{identifier}")
async def update_image(identifier: str, request: Request) -> dict[str, bool]:
    return {"ok": await service.update_image(identifier, await request.body(), parse_options_header(request))}


@protected_api.get("/images/{identifier}")
async def get_image(identifier: str, request: Request) -> Any:
    image_asset = await service.get_image(identifier)
    accept = request.headers.get("accept")
    if accept == "application/octet-stream":
        if not image_asset or not image_asset.get("file", {}).get("data"):
            return JSONResponse(status_code=404, content={"error": "Image not found"})
        file_asset = dict(image_asset["file"])
        data = file_asset.pop("data")
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"X-Metadata": json.dumps({"file": file_asset, "image": image_asset["image"]})},
        )
    return {"image": image_asset}


@protected_api.post("/images/{identifier}/test")
async def test_image(identifier: str) -> dict[str, bool]:
    return {"test": await service.test_image(identifier)}


@protected_api.post("/files")
async def create_file(request: Request) -> dict[str, str]:
    options = apply_content_length(parse_options_header(request), request)
    return {"did": await service.create_file_stream(await request.body(), options)}


@protected_api.put("/files/{identifier}")
async def update_file(identifier: str, request: Request) -> dict[str, bool]:
    options = apply_content_length(parse_options_header(request), request)
    return {"ok": await service.update_file_stream(identifier, await request.body(), options)}


@protected_api.get("/files/{identifier}")
async def get_file(identifier: str, request: Request) -> Any:
    file_asset = await service.get_file(identifier)
    accept = request.headers.get("accept")
    if accept == "application/octet-stream":
        if not file_asset or file_asset.get("data") is None:
            return JSONResponse(status_code=404, content={"error": "File not found"})
        file_response = dict(file_asset)
        data = file_response.pop("data")
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"X-Metadata": json.dumps(file_response)},
        )
    return {"file": file_asset}


@protected_api.post("/files/{identifier}/test")
async def test_file(identifier: str) -> dict[str, bool]:
    return {"test": await service.test_file(identifier)}


@protected_api.get("/ipfs/data/{cid}")
async def get_ipfs_data(cid: str) -> Response:
    try:
        data = await service.get_data(cid)
        if data is None:
            raise FileNotFoundError("Not Found")
        return Response(content=data, media_type="application/octet-stream")
    except Exception as exc:
        return PlainTextResponse(str(exc), media_type="text/plain", status_code=404)


@protected_api.post("/vaults")
async def create_vault(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_vault(body.get("options") or {})}


@protected_api.get("/vaults/{identifier}")
async def get_vault(identifier: str, request: Request) -> dict[str, Any]:
    return {"vault": await service.get_vault(identifier, parse_resolve_options(request))}


@protected_api.post("/vaults/{identifier}/test")
async def test_vault(identifier: str, body: dict[str, Any] | None = None) -> dict[str, bool]:
    return {"test": await service.test_vault(identifier, (body or {}).get("options") or {})}


@protected_api.post("/vaults/{identifier}/members")
async def add_vault_member(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.add_vault_member(identifier, body["memberId"])}


@protected_api.delete("/vaults/{identifier}/members/{member}")
async def remove_vault_member(identifier: str, member: str) -> dict[str, bool]:
    return {"ok": await service.remove_vault_member(identifier, member)}


@protected_api.get("/vaults/{identifier}/members")
async def list_vault_members(identifier: str) -> dict[str, Any]:
    return {"members": await service.list_vault_members(identifier)}


@protected_api.post("/vaults/{identifier}/items")
async def add_vault_item(identifier: str, request: Request, body: bytes) -> dict[str, bool]:
    options = parse_options_header(request)
    return {"ok": await service.add_vault_item(identifier, options["name"], body)}


@protected_api.delete("/vaults/{identifier}/items/{name}")
async def remove_vault_item(identifier: str, name: str) -> dict[str, bool]:
    return {"ok": await service.remove_vault_item(identifier, name)}


@protected_api.get("/vaults/{identifier}/items")
async def list_vault_items(identifier: str, request: Request) -> dict[str, Any]:
    return {"items": await service.list_vault_items(identifier, parse_resolve_options(request))}


@protected_api.get("/vaults/{identifier}/items/{name}")
async def get_vault_item(identifier: str, name: str, request: Request) -> Response:
    item = await service.get_vault_item(identifier, name, parse_resolve_options(request))
    return Response(content=item or b"", media_type="application/octet-stream")


@protected_api.post("/notices")
async def create_notice(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_notice(body["message"], body.get("options") or {})}


@protected_api.post("/notices/refresh")
async def refresh_notices() -> dict[str, bool]:
    return {"ok": await service.refresh_notices()}


@protected_api.put("/notices/{identifier}")
async def update_notice(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_notice(identifier, body["message"])}


@protected_api.get("/dmail")
async def list_dmail() -> dict[str, Any]:
    return {"dmail": await service.list_dmail()}


@protected_api.post("/dmail")
async def create_dmail(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_dmail(body["message"], body.get("options") or {})}


@protected_api.post("/dmail/import")
async def import_dmail(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.import_dmail(body["did"])}


@protected_api.get("/dmail/{identifier}")
async def get_dmail(identifier: str, request: Request) -> dict[str, Any]:
    return {"message": await service.get_dmail_message(identifier, parse_resolve_options(request))}


@protected_api.put("/dmail/{identifier}")
async def update_dmail(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_dmail(identifier, body["message"])}


@protected_api.delete("/dmail/{identifier}")
async def remove_dmail(identifier: str) -> dict[str, bool]:
    return {"ok": await service.remove_dmail(identifier)}


@protected_api.post("/dmail/{identifier}/send")
async def send_dmail(identifier: str) -> dict[str, str | None]:
    return {"did": await service.send_dmail(identifier)}


@protected_api.post("/dmail/{identifier}/file")
async def file_dmail(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.file_dmail(identifier, body["tags"])}


@protected_api.get("/dmail/{identifier}/attachments")
async def list_dmail_attachments(identifier: str, request: Request) -> dict[str, Any]:
    return {"attachments": await service.list_dmail_attachments(identifier, parse_resolve_options(request))}


@protected_api.post("/dmail/{identifier}/attachments")
async def add_dmail_attachment(identifier: str, request: Request) -> dict[str, bool]:
    options = parse_options_header(request)
    return {"ok": await service.add_dmail_attachment(identifier, options["name"], await request.body())}


@protected_api.delete("/dmail/{identifier}/attachments/{name}")
async def remove_dmail_attachment(identifier: str, name: str) -> dict[str, bool]:
    return {"ok": await service.remove_dmail_attachment(identifier, name)}


@protected_api.get("/dmail/{identifier}/attachments/{name}")
async def get_dmail_attachment(identifier: str, name: str) -> Response:
    return Response(content=await service.get_dmail_attachment(identifier, name), media_type="application/octet-stream")


@protected_api.post("/keys/encrypt/message")
async def keys_encrypt_message(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.encrypt_message(body["msg"], body["receiver"], body.get("options") or {})}


@protected_api.post("/keys/decrypt/message")
async def keys_decrypt_message(body: dict[str, Any]) -> dict[str, str]:
    return {"message": await service.decrypt_message(body["did"])}


@protected_api.post("/keys/encrypt/json")
async def keys_encrypt_json(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.encrypt_json(body["json"], body["receiver"], body.get("options") or {})}


@protected_api.post("/keys/decrypt/json")
async def keys_decrypt_json(body: dict[str, Any]) -> dict[str, Any]:
    return {"json": await service.decrypt_json(body["did"])}


@protected_api.post("/keys/sign")
async def keys_sign(body: dict[str, Any]) -> dict[str, Any]:
    return {"signed": await service.add_proof(__import__("json").loads(body["contents"]))}


@protected_api.post("/keys/verify")
async def keys_verify(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.verify_proof(body["json"])}


@protected_api.post("/keys/rotate")
async def keys_rotate() -> dict[str, bool]:
    return {"ok": await service.rotate_keys()}


@protected_api.post("/schemas")
async def create_schema(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_schema(body.get("schema"), body.get("options") or {})}


@protected_api.get("/schemas")
async def list_schemas(owner: str | None = None) -> dict[str, Any]:
    return {"schemas": await service.list_schemas(owner)}


@protected_api.get("/schemas/{identifier}")
async def get_schema(identifier: str) -> dict[str, Any]:
    return {"schema": await service.get_schema(identifier)}


@protected_api.put("/schemas/{identifier}")
async def set_schema(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.set_schema(identifier, body["schema"])}


@protected_api.post("/schemas/{identifier}/test")
async def test_schema(identifier: str) -> dict[str, bool]:
    return {"test": await service.test_schema(identifier)}


@protected_api.post("/schemas/{identifier}/template")
async def create_template(identifier: str) -> dict[str, Any]:
    return {"template": await service.create_template(identifier)}


@protected_api.post("/groups")
async def create_group(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_group(body["name"], body.get("options") or {})}


@protected_api.get("/templates/poll")
async def poll_template() -> dict[str, Any]:
    return {"template": await service.poll_template()}


@protected_api.get("/polls")
async def list_polls(owner: str | None = None) -> dict[str, Any]:
    return {"polls": await service.list_polls(owner)}


@protected_api.post("/polls")
async def create_poll(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_poll(body["poll"], body.get("options") or {})}


@protected_api.get("/polls/{poll}")
async def get_poll(poll: str) -> dict[str, Any]:
    return {"poll": await service.get_poll(poll)}


@protected_api.get("/polls/{poll}/test")
async def test_poll(poll: str) -> dict[str, bool]:
    return {"test": await service.test_poll(poll)}


@protected_api.get("/polls/{poll}/view")
async def view_poll(poll: str) -> dict[str, Any]:
    return {"poll": await service.view_poll(poll)}


@protected_api.post("/polls/{poll}/send")
async def send_poll(poll: str) -> dict[str, str]:
    return {"did": await service.send_poll(poll)}


@protected_api.post("/polls/{poll}/vote")
async def vote_poll(poll: str, body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.vote_poll(poll, body["vote"], body.get("options") or {})}


@protected_api.put("/polls/update")
async def update_poll(body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_poll(body["ballot"])}


@protected_api.post("/polls/{poll}/publish")
async def publish_poll(poll: str, body: dict[str, Any] | None = None) -> dict[str, bool]:
    return {"ok": await service.publish_poll(poll, (body or {}).get("options") or {})}


@protected_api.post("/polls/{poll}/unpublish")
async def unpublish_poll(poll: str) -> dict[str, bool]:
    return {"ok": await service.unpublish_poll(poll)}


@protected_api.post("/polls/ballot/send")
async def send_ballot(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.send_ballot(body["ballot"], body["poll"])}


@protected_api.get("/polls/ballot/{did}")
async def view_ballot(did: str) -> dict[str, Any]:
    return {"ballot": await service.view_ballot(did)}


@protected_api.post("/polls/{poll}/voters")
async def add_poll_voter(poll: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.add_poll_voter(poll, body["memberId"])}


@protected_api.delete("/polls/{poll}/voters/{voter}")
async def remove_poll_voter(poll: str, voter: str) -> dict[str, bool]:
    return {"ok": await service.remove_poll_voter(poll, voter)}


@protected_api.get("/polls/{poll}/voters")
async def list_poll_voters(poll: str) -> dict[str, Any]:
    return {"voters": await service.list_poll_voters(poll)}


@protected_api.get("/groups")
async def list_groups(owner: str | None = None) -> dict[str, Any]:
    return {"groups": await service.list_groups(owner)}


@protected_api.get("/groups/{identifier}")
async def get_group(identifier: str) -> dict[str, Any]:
    return {"group": await service.get_group(identifier)}


@protected_api.post("/groups/{identifier}/add")
async def add_group_member(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.add_group_member(identifier, body["member"])}


@protected_api.post("/groups/{identifier}/remove")
async def remove_group_member(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.remove_group_member(identifier, body["member"])}


@protected_api.post("/groups/{identifier}/test")
async def test_group(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"test": await service.test_group(identifier, body.get("member"))}


@protected_api.get("/challenge")
async def challenge_get() -> dict[str, str]:
    return {"did": await service.create_challenge({})}


@protected_api.post("/challenge")
async def challenge_post(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_challenge(body.get("challenge") or {}, body.get("options") or {})}


@protected_api.post("/response")
async def response_post(body: dict[str, Any]) -> dict[str, str]:
    return {"did": await service.create_response(body["challenge"], body.get("options") or {})}


@protected_api.post("/response/verify")
async def response_verify(body: dict[str, Any]) -> dict[str, Any]:
    return {"verify": await service.verify_response(body["response"], body.get("options") or {})}


@app.get("/metrics")
async def metrics() -> Response:
    return PlainTextResponse(generate_latest().decode("utf-8"), media_type=CONTENT_TYPE_LATEST)


app.include_router(public_api)
app.include_router(protected_api)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def unknown_api(path: str) -> JSONResponse:
    _ = path
    return JSONResponse(status_code=404, content={"message": "Endpoint not found"})
