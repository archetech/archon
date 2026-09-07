from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from keymaster.core import KeymasterError, WalletNotFoundError

# Minimum length we accept for ARCHON_ADMIN_API_KEY. Below this we warn but
# still start -- an existing deployment with a short key should not be bricked
# by an upgrade. `openssl rand -hex 32` (the documented generator) yields 64.
MIN_ADMIN_API_KEY_LENGTH = 32


@dataclass
class StartupCheck:
    # Set when the key is unusable and the process must not start.
    fatal: str | None = None
    # Set when the key works but is weak enough to be worth flagging.
    warning: str | None = None


def check_admin_api_key(admin_api_key: str) -> StartupCheck:
    """Validate ARCHON_ADMIN_API_KEY at startup.

    Fail closed: the guard covers the entire v1 router, not an admin subset, so
    an unset key leaves wallet, identity, credential and Lightning operations
    reachable by anyone who can open the port. Mirrors the TypeScript service's
    checkAdminApiKey, and gatekeeper's, so the two flavors refuse the same
    configurations.
    """
    if not admin_api_key:
        return StartupCheck(
            fatal=(
                "ARCHON_ADMIN_API_KEY must be set — the API would otherwise be "
                "unauthenticated. Generate one with: openssl rand -hex 32"
            )
        )

    if len(admin_api_key) < MIN_ADMIN_API_KEY_LENGTH:
        return StartupCheck(
            warning=(
                f"Warning: ARCHON_ADMIN_API_KEY is shorter than {MIN_ADMIN_API_KEY_LENGTH} "
                "characters — regenerate it with: openssl rand -hex 32"
            )
        )

    return StartupCheck()


def check_passphrase(passphrase: str) -> StartupCheck:
    """Validate ARCHON_ENCRYPTED_PASSPHRASE at startup.

    Fail closed: the passphrase is both the wallet's encryption secret and the
    credential POST /login checks before handing back the admin API key. An
    empty one made /login return that key to any caller, and /login sits ahead
    of the admin guard because it is how a client obtains the key.
    """
    if not passphrase:
        return StartupCheck(
            fatal=(
                "ARCHON_ENCRYPTED_PASSPHRASE must be set — POST /login would "
                "otherwise return the admin API key without checking it."
            )
        )

    return StartupCheck()


# Deciding what an empty wallet store means at startup.
#
# Empty and lost look identical from every backend: an unmounted volume, a
# wiped database and a first run all read back as nothing. Only the operator
# knows which their node is, so the difference is a setting rather than a
# heuristic (#1037, #1051).
#
# Three conditions arrive here and each has its own remedy, so none of the
# messages below may be reached by another's path:
#
#   the store is not reachable yet -- retried, then fatal
#   the wallet was read and cannot be used -- fatal at once
#   the store is empty -- the operator's setting decides
#
# Mirrors the TypeScript decideWalletStartup so the two flavors refuse the
# same conditions with the same wording.

DEFAULT_WALLET_ATTEMPTS = 10
DEFAULT_WALLET_DELAY_SECONDS = 3.0


@dataclass
class WalletStartup:
    # One of "use", "provision", "refuse".
    action: str
    fatal: str | None = None
    warning: str | None = None


async def decide_wallet_startup(
    load: Callable[[], Awaitable[object]],
    *,
    store: str,
    require_existing: bool,
    require_setting: str,
    attempts: int = DEFAULT_WALLET_ATTEMPTS,
    delay_seconds: float = DEFAULT_WALLET_DELAY_SECONDS,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> WalletStartup:
    """Decide whether to carry on, provision, or stop, given a wallet read.

    ``load`` is expected to raise ``WalletNotFoundError`` for an empty store,
    any other ``KeymasterError`` for a wallet that was read and cannot be used,
    and anything else for a store that could not be read at all. That last kind
    is the only one retried: a wrong passphrase will not become right by asking
    again, while a database that is still starting will.
    """
    waiter = sleep or asyncio.sleep
    attempts = max(1, attempts)
    unreachable: BaseException | None = None

    for attempt in range(1, attempts + 1):
        try:
            await load()
            return WalletStartup(action="use")
        except WalletNotFoundError:
            if require_existing:
                return WalletStartup(
                    action="refuse",
                    fatal=(
                        f"No wallet in {store} and {require_setting} is set. Refusing to "
                        f"start rather than replace this node's identity: check the store is "
                        f"the one this node has been using. Unset {require_setting} only to "
                        f"let it create a new identity."
                    ),
                )

            return WalletStartup(
                action="provision",
                warning=(
                    f"No wallet found in {store} — creating one. If this node has run "
                    f"before, its store is missing and its identity has been replaced."
                ),
            )
        except KeymasterError as exc:
            return WalletStartup(
                action="refuse",
                fatal=f"The wallet in {store} could not be opened: {exc}",
            )
        except BaseException as exc:  # noqa: BLE001 - the store, not the wallet
            unreachable = exc

            if attempt < attempts:
                await waiter(delay_seconds)

    # Deliberately says nothing about the store being empty, and asks for
    # nothing to be unset: an operator acting on either would replace the
    # identity this path exists to protect.
    return WalletStartup(
        action="refuse",
        fatal=(
            f"Could not read the wallet store ({store}) after {attempts} attempts over "
            f"{round(attempts * delay_seconds)}s: {unreachable}. It may not be running or "
            f"reachable yet."
        ),
    )
