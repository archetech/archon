from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
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


class SqliteWalletStore:
    """SQLite-backed wallet store, matching WalletSQLite in packages/keymaster/src/db/sqlite.ts.

    The point of this backend is that one machine can hold one wallet: the
    TypeScript CLI and this one open the same file, so the schema and the row
    it writes are that CLI's, not a shape of our own.
    """

    def __init__(self, wallet_file_name: str = "wallet.db", data_folder: str = "data"):
        # An absolute path is a location, not a name to hang under data_folder.
        # Said outright rather than left to pathlib, which drops the left side
        # of a join when the right is absolute: the rule is the same one
        # WalletSQLite states, where joining really would give `data//home/...`.
        name = Path(wallet_file_name)
        self._wallet_path = name if name.is_absolute() else Path(data_folder) / name
        self._lock = threading.RLock()

    def _connect(self) -> sqlite3.Connection:
        # The JSON backend creates its folder; sqlite3 reports "unable to open
        # database file" rather than creating one.
        self._wallet_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self._wallet_path)
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS wallet (
                id INTEGER PRIMARY KEY,
                data TEXT NOT NULL
            )
            """
        )
        return connection

    def save_wallet(self, wallet: dict[str, Any], overwrite: bool = False) -> bool:
        with self._lock, closing(self._connect()) as connection:
            exists = connection.execute("SELECT 1 FROM wallet LIMIT 1").fetchone()
            if exists and not overwrite:
                return False

            connection.execute("DELETE FROM wallet")
            # Separators match JSON.stringify, so the two CLIs write the same
            # bytes for the same wallet.
            connection.execute(
                "INSERT INTO wallet (data) VALUES (?)",
                (json.dumps(wallet, separators=(",", ":")),),
            )
            connection.commit()
            return True

    def load_wallet(self) -> dict[str, Any] | None:
        with self._lock, closing(self._connect()) as connection:
            row = connection.execute("SELECT data FROM wallet LIMIT 1").fetchone()
            if row is None:
                return None
            return json.loads(row[0])


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
