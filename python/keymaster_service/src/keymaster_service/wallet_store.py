from __future__ import annotations

import json
import os
from pathlib import Path
import threading
from typing import Any

import redis as redis_lib


class JsonWalletStore:
    def __init__(self, wallet_file_name: str = "wallet.json", data_folder: str = "data"):
        self._data_dir = Path(data_folder)
        self._wallet_path = self._data_dir / wallet_file_name
        self._lock = threading.RLock()

    def save_wallet(self, wallet: dict[str, Any], overwrite: bool = False) -> bool:
        with self._lock:
            if self._wallet_path.exists() and not overwrite:
                return False
            self._data_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = self._wallet_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(wallet, indent=4), encoding="utf-8")
            os.replace(tmp_path, self._wallet_path)
            return True

    def load_wallet(self) -> dict[str, Any] | None:
        with self._lock:
            if not self._wallet_path.exists():
                return None
            return json.loads(self._wallet_path.read_text(encoding="utf-8"))


class RedisWalletStore:
    """Redis-backed wallet store, matching the behaviour of WalletRedis in the TypeScript service."""

    def __init__(self, redis_url: str = "redis://localhost:6379", wallet_key: str = "wallet"):
        self._wallet_key = wallet_key
        self._client = redis_lib.from_url(redis_url, decode_responses=True)

    def save_wallet(self, wallet: dict[str, Any], overwrite: bool = False) -> bool:
        exists = self._client.exists(self._wallet_key)
        if exists and not overwrite:
            return False
        self._client.set(self._wallet_key, json.dumps(wallet))
        return True

    def load_wallet(self) -> dict[str, Any] | None:
        data = self._client.get(self._wallet_key)
        if data is None:
            return None
        return json.loads(data)
