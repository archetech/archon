from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .config import load_settings
from .gatekeeper_client import GatekeeperClient
from .service import KeymasterService, KeymasterServiceError
from .wallet_store import JsonWalletStore


logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)

settings = load_settings()
service = KeymasterService(settings, GatekeeperClient(settings.gatekeeper_url), JsonWalletStore(data_folder=settings.data_dir))


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


@public_api.get("/registries")
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


@protected_api.get("/export/wallet/encrypted")
async def export_wallet_encrypted() -> dict[str, Any]:
    return {"wallet": await service.encrypt_wallet_for_storage(await service.load_wallet())}


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


@protected_api.post("/ids/{identifier}/backup")
async def backup_id(identifier: str) -> dict[str, bool]:
    return {"ok": await service.backup_id(identifier)}


@protected_api.post("/ids/{identifier}/recover")
async def recover_id(identifier: str, body: dict[str, Any]) -> dict[str, str]:
    return {"recovered": await service.recover_id(body.get("did") or identifier)}


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


@protected_api.get("/did/{identifier}")
async def resolve_did(identifier: str, request: Request) -> dict[str, Any]:
    options = {key: value for key, value in request.query_params.items()}
    return {"docs": await service.resolve_did(identifier, options or None)}


@protected_api.put("/did/{identifier}")
async def update_did(identifier: str, body: dict[str, Any]) -> dict[str, bool]:
    return {"ok": await service.update_did(identifier, body["doc"])}


@protected_api.delete("/did/{identifier}")
async def revoke_did(identifier: str) -> dict[str, bool]:
    return {"ok": await service.revoke_did(identifier)}


@protected_api.post("/agents/{identifier}/test")
async def test_agent(identifier: str) -> dict[str, bool]:
    return {"test": await service.test_agent(identifier)}


@protected_api.get("/assets")
async def list_assets(owner: str | None = None) -> dict[str, Any]:
    return {"assets": await service.list_assets(owner)}


@protected_api.get("/assets/{identifier}")
async def get_asset(identifier: str) -> dict[str, Any]:
    return {"asset": await service.resolve_asset(identifier)}


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
