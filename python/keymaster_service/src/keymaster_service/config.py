from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
import os


def _package_version() -> str:
    try:
        return metadata.version("keymaster-service")
    except metadata.PackageNotFoundError:
        return "0.1.0"


@dataclass(slots=True)
class Settings:
    bind_address: str = os.environ.get("ARCHON_BIND_ADDRESS", "0.0.0.0")
    keymaster_port: int = int(os.environ.get("ARCHON_KEYMASTER_PORT", "4226"))
    gatekeeper_url: str = os.environ.get("ARCHON_GATEKEEPER_URL", "http://localhost:4224")
    keymaster_db: str = os.environ.get("ARCHON_KEYMASTER_DB", "json") or "json"
    passphrase: str = os.environ.get("ARCHON_ENCRYPTED_PASSPHRASE", "")
    wallet_cache: bool = os.environ.get("ARCHON_WALLET_CACHE", "false").lower() == "true"
    default_registry: str = os.environ.get("ARCHON_DEFAULT_REGISTRY", "hyperswarm") or "hyperswarm"
    upload_limit: str = os.environ.get("ARCHON_KEYMASTER_UPLOAD_LIMIT", "10mb")
    admin_api_key: str = os.environ.get("ARCHON_ADMIN_API_KEY", "")
    node_id: str = os.environ.get("ARCHON_NODE_ID", "")
    data_dir: str = os.environ.get("ARCHON_DATA_DIR", "data")
    redis_url: str = os.environ.get("ARCHON_REDIS_URL", "redis://localhost:6379") or "redis://localhost:6379"
    git_commit: str = (os.environ.get("GIT_COMMIT", "unknown") or "unknown")[:7]
    service_version: str = _package_version()


def load_settings() -> Settings:
    return Settings()
