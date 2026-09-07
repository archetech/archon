"""Where a wallet lives when nothing says otherwise (#980).

A globally installed CLI resolving ./wallet.json ties the identity to whichever
directory it was created in, and the passphrase that unlocks it is kept under
the home directory — so the wallet belongs there too.
"""

from __future__ import annotations

from keymaster.cli import (
    default_wallet_file,
    directory_wallets,
    home_wallet_path,
    resolve_wallet_path,
    stored_at,
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


def test_a_sqlite_wallet_still_under_the_older_name_is_found() -> None:
    # Reporting no wallet here is what sends an existing SQLite user to a new
    # identity in the home directory.
    assert resolve({}, exists=lambda c: c == "./wallet.json", wallet_type="sqlite") == "./wallet.json"


def test_a_new_sqlite_wallet_gets_a_db_name() -> None:
    assert resolve({}, wallet_type="sqlite") == "/home/someone/.archon/wallet.db"


def test_sqlite_names_the_wallet_for_what_it_is() -> None:
    # The CLI passes one path for both backends, so without a name per
    # backend a SQLite database is written under a .json one.
    assert default_wallet_file("sqlite") == "wallet.db"
    assert default_wallet_file("json") == "wallet.json"
    assert directory_wallets("sqlite") == ["./wallet.json", "./wallet.db"]


def test_an_explicit_path_wins_over_both() -> None:
    assert resolve({"ARCHON_WALLET_PATH": "/srv/keys/wallet.json"}, exists=lambda _: True) == "/srv/keys/wallet.json"


def test_an_explicit_path_that_does_not_exist_is_still_obeyed() -> None:
    # An instruction, not a preference: pointing it at nothing has to fail
    # naming what was asked for, not fall back somewhere else.
    assert resolve({"ARCHON_WALLET_PATH": "/gone.json"}) == "/gone.json"


def test_message_says_a_wallet_elsewhere_is_still_there_before_offering_to_make_one() -> None:
    # Offering create-wallet as the only route leads a user whose identity
    # is in another directory to make a second one, leaving the first where
    # they are not looking.
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


def test_stored_at_is_the_path_itself_for_json() -> None:
    assert stored_at("json", "./wallet.json") == "./wallet.json"


def test_stored_at_is_under_the_data_folder_for_a_relative_sqlite_path() -> None:
    # Asking the name instead reports no wallet to a SQLite user who has one.
    assert stored_at("sqlite", "./wallet.json") == "data/wallet.json"


def test_stored_at_leaves_an_absolute_sqlite_path_alone() -> None:
    assert stored_at("sqlite", "/home/someone/.archon/wallet.json") == "/home/someone/.archon/wallet.json"
