import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from keymaster.core import Keymaster, KeymasterError

# What a new name may be (#1758). A name is given in the path of a request,
# where it is one segment. The TypeScript Keymaster runs the same names.

NAMES = json.loads((Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "keymaster-names.json").read_text())


def _validate(name, wallet=None, label="name", item=False):
    return Keymaster.validate_alias(SimpleNamespace(max_alias_length=32), name, wallet, label, item)


@pytest.mark.parametrize("name", NAMES["accepted"])
def test_accepts(name):
    assert _validate(name) == name.strip()


@pytest.mark.parametrize("refused", NAMES["refused"], ids=lambda refused: refused["name"])
def test_refuses(refused):
    for label in ("name", "alias"):
        with pytest.raises(KeymasterError, match=f"Invalid parameter: {label} {refused['error']}"):
            _validate(refused["name"], None, label)


@pytest.mark.parametrize("name", NAMES["items"]["accepted"])
def test_accepts_as_a_vault_items_name(name):
    assert _validate(name, item=True) == name.strip()


@pytest.mark.parametrize("refused", NAMES["items"]["refused"], ids=lambda refused: refused["name"])
def test_refuses_as_a_vault_items_name(refused):
    with pytest.raises(KeymasterError, match=f"Invalid parameter: name {refused['error']}"):
        _validate(refused["name"], item=True)


def test_an_asset_whose_alias_is_refused_is_not_made():
    import asyncio

    made = []

    class Gatekeeper:
        async def create_did(self, operation):
            made.append(operation)
            return "did:cid:made"

    async def wallet():
        return {"aliases": {"taken": "did:cid:x"}, "ids": {}}

    async def never(*args, **kwargs):
        raise AssertionError("nothing is looked up for an alias that is refused")

    keymaster = SimpleNamespace(
        max_alias_length=32, default_registry="hyperswarm", gatekeeper=Gatekeeper(),
        load_wallet=wallet, fetch_id_info=never,
    )
    keymaster.validate_alias = lambda *args, **kwargs: Keymaster.validate_alias(keymaster, *args, **kwargs)

    for alias, error in [("team/alice", "alias contains a slash"), ("..", "alias cannot be only dots"), ("taken", "alias already used")]:
        with pytest.raises(KeymasterError, match=error):
            asyncio.run(Keymaster.create_asset(keymaster, {"a": 1}, {"alias": alias}))
    assert made == []
