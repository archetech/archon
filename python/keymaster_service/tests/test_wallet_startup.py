"""An empty wallet store and a lost one read the same from every backend.

The operator's setting decides between them. The three conditions that reach
this — store not reachable, wallet unusable, store empty — have three different
remedies, and a startup path that conflates any two of them gives advice that
replaces the identity it exists to protect (#1051).
"""

from __future__ import annotations

import asyncio

from keymaster.core import KeymasterError, WalletNotFoundError

from keymaster_service.admin import decide_wallet_startup

OPTIONS = {
    "store": "redis",
    "require_existing": False,
    "require_setting": "ARCHON_KEYMASTER_REQUIRE_WALLET",
    "attempts": 4,
    "delay_seconds": 1.0,
}


def reader(*outcomes: object):
    calls: list[int] = []

    async def load() -> object:
        outcome = outcomes[len(calls)] if len(calls) < len(outcomes) else outcomes[-1]
        calls.append(1)

        if isinstance(outcome, BaseException):
            raise outcome

        return outcome

    return load, calls


def recorder() -> tuple[list[float], object]:
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    return slept, sleep


def test_carries_on_when_the_store_holds_a_wallet() -> None:
    slept, sleep = recorder()
    load, calls = reader({})

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "use"
    assert len(calls) == 1


def test_provisions_an_empty_store_by_default() -> None:
    slept, sleep = recorder()
    load, _ = reader(WalletNotFoundError("no wallet"))

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "provision"
    assert "redis" in (decision.warning or "")


def test_refuses_an_empty_store_when_the_node_has_an_identity() -> None:
    slept, sleep = recorder()
    load, calls = reader(WalletNotFoundError("no wallet"))

    decision = asyncio.run(decide_wallet_startup(load, **{**OPTIONS, "require_existing": True}, sleep=sleep))

    assert decision.action == "refuse"
    assert "ARCHON_KEYMASTER_REQUIRE_WALLET" in (decision.fatal or "")
    # Nothing to wait for: the store answered.
    assert len(calls) == 1
    assert slept == []


def test_stops_at_once_on_a_wallet_that_cannot_be_used() -> None:
    slept, sleep = recorder()
    # A wrong passphrase does not become right by asking again.
    load, calls = reader(KeymasterError("Incorrect passphrase."))

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "refuse"
    assert "Incorrect passphrase." in (decision.fatal or "")
    assert len(calls) == 1


def test_waits_for_a_store_that_is_still_starting() -> None:
    slept, sleep = recorder()
    load, calls = reader(OSError("ECONNREFUSED"), OSError("ECONNREFUSED"), {})

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "use"
    assert len(calls) == 3
    assert slept == [1.0, 1.0]


def test_reads_again_rather_than_deciding_from_the_first_answer() -> None:
    slept, sleep = recorder()
    # A wallet that appears or disappears while the store comes up is seen.
    load, _ = reader(OSError("ECONNREFUSED"), WalletNotFoundError("no wallet"))

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "provision"


def test_gives_up_without_calling_the_store_empty() -> None:
    slept, sleep = recorder()
    load, calls = reader(OSError("ECONNREFUSED"))

    decision = asyncio.run(decide_wallet_startup(load, **OPTIONS, sleep=sleep))

    assert decision.action == "refuse"
    assert len(calls) == 4
    assert slept == [1.0, 1.0, 1.0]

    # Acting on either would replace the identity this path protects.
    fatal = decision.fatal or ""
    assert "Could not read the wallet store" in fatal
    assert "empty" not in fatal.lower()
    assert "unset" not in fatal.lower()
