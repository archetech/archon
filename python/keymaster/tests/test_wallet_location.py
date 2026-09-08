"""Where a wallet lives when nothing says otherwise (#980, #1073, #1075).

A globally installed CLI resolving ./wallet.json ties the identity to whichever
directory it was created in, and the passphrase that unlocks it is kept under
the home directory — so the wallet belongs there too. Mirrors
tests/keymaster/wallet-location.test.ts, because the point of the SQLite
backend is that both CLIs open one wallet on one machine.
"""

from __future__ import annotations

from keymaster.cli import (
    default_wallet_file,
    directory_wallets,
    home_wallet_path,
    legacy_wallet_path,
    resolve_wallet_path,
    stranded_wallet,
    stranded_wallet_message,
    wallet_not_found_message,
)

HOME_WALLET = home_wallet_path("/home/someone", "json")


def resolve(env, exists=lambda _: False, wallet_type="json"):
    return resolve_wallet_path(
        env,
        directory_wallets=directory_wallets(wallet_type),
        home_wallet=home_wallet_path("/home/someone", wallet_type),
        exists=exists,
    )


def test_a_new_wallet_goes_under_the_home_directory() -> None:
    assert resolve({}) == "/home/someone/.archon/wallet.json"


def test_a_wallet_already_in_the_working_directory_keeps_being_used() -> None:
    # A setup built that way goes on working without being touched.
    assert resolve({}, exists=lambda candidate: candidate == "./wallet.json") == "./wallet.json"


def test_finds_a_sqlite_wallet_still_under_the_older_name() -> None:
    # Reporting no wallet here is what sends an existing SQLite user to a new
    # identity in the home directory.
    assert resolve({}, exists=lambda c: c == "./wallet.json", wallet_type="sqlite") == "./wallet.json"


def test_puts_a_new_sqlite_wallet_under_a_db_name() -> None:
    assert resolve({}, wallet_type="sqlite") == "/home/someone/.archon/wallet.db"


def test_finds_a_sqlite_wallet_left_under_the_data_folder() -> None:
    # A SQLite wallet written by either CLI before a path meant a path is under
    # data/, and the working directory holds nothing.
    assert resolve({}, exists=lambda c: c == "data/wallet.json", wallet_type="sqlite") == "data/wallet.json"


def test_an_explicit_path_wins_over_both() -> None:
    assert resolve({"ARCHON_WALLET_PATH": "/srv/keys/wallet.json"}, exists=lambda _: True) == "/srv/keys/wallet.json"


def test_an_explicit_path_that_does_not_exist_is_still_obeyed() -> None:
    # An instruction, not a preference: pointing it at nothing has to fail
    # naming what was asked for, not fall back somewhere else.
    assert resolve({"ARCHON_WALLET_PATH": "/gone.json"}) == "/gone.json"


def test_default_wallet_file_names_a_sqlite_wallet_for_what_it_is() -> None:
    # The CLI passes one path for both backends, so without a name per backend
    # a SQLite database is written under a .json one.
    assert default_wallet_file("sqlite") == "wallet.db"
    assert default_wallet_file("json") == "wallet.json"


def test_directory_wallets_looks_under_data_too_for_sqlite() -> None:
    assert directory_wallets("sqlite") == [
        "./wallet.json",
        "./wallet.db",
        "data/wallet.json",
        "data/wallet.db",
    ]


def test_directory_wallets_has_one_name_for_json() -> None:
    assert directory_wallets("json") == ["./wallet.json"]


def test_legacy_wallet_path_names_where_a_relative_sqlite_path_used_to_be_written() -> None:
    assert legacy_wallet_path("sqlite", "./wallet.json") == "data/wallet.json"


def test_legacy_wallet_path_has_nowhere_older_for_json_or_an_absolute_path() -> None:
    # Nothing moved for these, so pointing at a second location would send their
    # owners looking for a wallet that was never there.
    assert legacy_wallet_path("json", "./wallet.json") is None
    assert legacy_wallet_path("sqlite", "/home/someone/.archon/wallet.db") is None


def at(*found: str):
    return lambda candidate: candidate in found


def test_stranded_wallet_reports_one_left_where_an_earlier_release_put_it() -> None:
    # create-wallet and create-id never reach the "no wallet" message, so
    # nothing downstream of opening the store can stop them minting a second
    # identity while the funded one sits under data/.
    assert stranded_wallet("sqlite", "./wallet.json", at("data/wallet.json")) == "data/wallet.json"


def test_stranded_wallet_says_nothing_when_the_path_in_hand_holds_a_wallet() -> None:
    assert stranded_wallet("sqlite", "./wallet.json", at("./wallet.json", "data/wallet.json")) is None


def test_stranded_wallet_says_nothing_when_there_is_no_older_wallet_either() -> None:
    # A first wallet has to be creatable.
    assert stranded_wallet("sqlite", "./wallet.json", at()) is None


def test_stranded_wallet_says_nothing_for_a_backend_that_never_moved_a_wallet() -> None:
    assert stranded_wallet("json", "./wallet.json", at("data/wallet.json")) is None


def test_stranded_message_names_both_paths_and_how_to_reconcile_them() -> None:
    message = stranded_wallet_message("./wallet.json", "data/wallet.json")

    assert "./wallet.json" in message
    assert "data/wallet.json" in message
    assert "ARCHON_WALLET_PATH" in message


def test_message_says_a_wallet_elsewhere_is_still_there_before_offering_to_make_one() -> None:
    # Offering create-wallet as the only route leads a user whose identity is in
    # another directory to make a second one, leaving the first where they are
    # not looking.
    lines = " ".join(wallet_not_found_message("./wallet.json", HOME_WALLET))

    assert "another directory" in lines
    assert "ARCHON_WALLET_PATH" in lines
    assert lines.index("another directory") < lines.index("create-wallet")


def test_message_names_the_home_location_when_that_is_not_where_it_looked() -> None:
    assert HOME_WALLET in " ".join(wallet_not_found_message("./wallet.json", HOME_WALLET))


def test_message_does_not_point_at_the_home_location_when_that_is_where_it_looked() -> None:
    lines = wallet_not_found_message(HOME_WALLET, HOME_WALLET)

    assert HOME_WALLET in " ".join(lines)
    assert not [line for line in lines if "unless ARCHON_WALLET_PATH" in line]
