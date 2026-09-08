"""The SQLite wallet store, and the file it has to share with the TypeScript CLI (#1075).

The point of this backend is that one machine holds one wallet: `keymaster` and
this CLI open the same file. So the tests that matter are about the file's
shape, not about round-tripping through our own code.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from keymaster.cli import WalletLocationError, open_wallet_store
from keymaster.wallet_store import SqliteWalletStore

WALLET = {"version": 2, "seed": {}, "counter": 1, "current": "Alice", "ids": {"Alice": {"account": 0, "index": 0}}}

# Issued verbatim by WalletSQLite.connect and saveWallet in
# packages/keymaster/src/db/sqlite.ts. A database built from these is what this
# store is handed on a machine where the TypeScript CLI got there first.
JS_SCHEMA = """
    CREATE TABLE IF NOT EXISTS wallet (
        id INTEGER PRIMARY KEY,
        data TEXT NOT NULL
    )
"""
JS_INSERT = "INSERT INTO wallet (data) VALUES (?)"


def test_reads_a_wallet_written_by_the_typescript_store(tmp_path) -> None:
    database = tmp_path / "wallet.db"
    with sqlite3.connect(database) as connection:
        connection.execute(JS_SCHEMA)
        connection.execute(JS_INSERT, (json.dumps(WALLET, separators=(",", ":")),))

    assert SqliteWalletStore("wallet.db", str(tmp_path)).load_wallet() == WALLET


def test_writes_the_table_the_typescript_store_reads(tmp_path) -> None:
    # WalletSQLite selects `data` from a table named `wallet`; a store that
    # agreed on nothing but the filename would leave each CLI a wallet the
    # other cannot see.
    SqliteWalletStore("wallet.db", str(tmp_path)).save_wallet(WALLET)

    with sqlite3.connect(tmp_path / "wallet.db") as connection:
        columns = [row[1] for row in connection.execute("PRAGMA table_info(wallet)")]
        rows = connection.execute("SELECT data FROM wallet").fetchall()

    assert columns == ["id", "data"]
    assert len(rows) == 1
    assert json.loads(rows[0][0]) == WALLET


def test_loads_none_when_the_table_is_empty(tmp_path) -> None:
    assert SqliteWalletStore("wallet.db", str(tmp_path)).load_wallet() is None


def test_preserves_an_existing_wallet_unless_overwrite_is_set(tmp_path) -> None:
    store = SqliteWalletStore("wallet.db", str(tmp_path))
    other = {"version": 2, "seed": {}, "counter": 2, "ids": {}}

    assert store.save_wallet(WALLET) is True
    assert store.save_wallet(other) is False
    assert store.load_wallet() == WALLET
    assert store.save_wallet(other, overwrite=True) is True
    assert store.load_wallet() == other


def test_replaces_rather_than_accumulating_rows(tmp_path) -> None:
    # WalletSQLite reads `LIMIT 1`, so a second row would be a wallet nobody
    # can reach and a save that silently did nothing.
    store = SqliteWalletStore("wallet.db", str(tmp_path))
    store.save_wallet(WALLET)
    store.save_wallet({"version": 2, "seed": {}, "counter": 9, "ids": {}}, overwrite=True)

    with sqlite3.connect(tmp_path / "wallet.db") as connection:
        assert connection.execute("SELECT count(*) FROM wallet").fetchone()[0] == 1


def test_creates_the_directory_it_was_pointed_at(tmp_path) -> None:
    # The JSON backend creates its folder; sqlite3 reports "unable to open
    # database file" rather than creating one.
    store = SqliteWalletStore("wallet.db", str(tmp_path / "missing" / "deeper"))

    assert store.load_wallet() is None


def test_treats_an_absolute_path_as_the_location(tmp_path) -> None:
    database = tmp_path / "absolute" / "wallet.db"
    SqliteWalletStore(str(database), "data").save_wallet(WALLET)

    assert database.exists()


def test_open_wallet_store_picks_the_backend_and_splits_the_path(tmp_path) -> None:
    sqlite_store = open_wallet_store("sqlite", str(tmp_path / "wallet.db"))
    json_store = open_wallet_store("json", str(tmp_path / "wallet.json"))

    assert isinstance(sqlite_store, SqliteWalletStore)
    sqlite_store.save_wallet(WALLET)
    json_store.save_wallet(WALLET)

    assert (tmp_path / "wallet.db").exists()
    assert (tmp_path / "wallet.json").exists()
    assert not (tmp_path / "data").exists()


def test_open_wallet_store_refuses_an_empty_path_while_a_wallet_is_stranded(tmp_path, monkeypatch) -> None:
    # create-wallet and create-id provision without consulting the "no wallet"
    # message, so the only place that can stop them is before the store opens.
    monkeypatch.chdir(tmp_path)
    SqliteWalletStore("wallet.json", "data").save_wallet(WALLET)

    with pytest.raises(WalletLocationError, match="data/wallet.json"):
        open_wallet_store("sqlite", "./wallet.json")

    assert not (tmp_path / "wallet.json").exists()
