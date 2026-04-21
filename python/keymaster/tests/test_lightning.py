from __future__ import annotations

import pytest

from keymaster import Keymaster, KeymasterError, UnknownIDError

from .helpers import FakeWalletStore, run, make_testbed


COFFEE_INVOICE = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh"
DONATION_INVOICE = "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql"


def test_add_lightning_is_idempotent_and_stores_by_url(testbed):
    run(testbed.keymaster.create_id("Bob"))

    config1 = run(testbed.keymaster.add_lightning())
    config2 = run(testbed.keymaster.add_lightning())

    assert config1 == config2
    assert run(testbed.keymaster.load_wallet())["ids"]["Bob"]["lightning"] == {
        "http://test-drawbridge": config1,
    }


def test_add_lightning_supports_named_ids_and_unknown_ids(testbed):
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.create_id("Bob"))

    alice_config = run(testbed.keymaster.add_lightning("Alice"))

    assert run(testbed.keymaster.load_wallet())["ids"]["Alice"]["lightning"]["http://test-drawbridge"] == alice_config
    assert "lightning" not in run(testbed.keymaster.load_wallet())["ids"]["Bob"]

    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.add_lightning("Unknown"))


def test_add_and_remove_lightning_support_multiple_urls(testbed):
    run(testbed.keymaster.create_id("Bob"))
    config1 = run(testbed.keymaster.add_lightning())

    testbed.gatekeeper.url = "http://other-drawbridge"
    config2 = run(testbed.keymaster.add_lightning())

    assert config1 != config2
    assert run(testbed.keymaster.load_wallet())["ids"]["Bob"]["lightning"] == {
        "http://test-drawbridge": config1,
        "http://other-drawbridge": config2,
    }

    assert run(testbed.keymaster.remove_lightning()) is True
    assert run(testbed.keymaster.load_wallet())["ids"]["Bob"]["lightning"] == {
        "http://test-drawbridge": config1,
    }


def test_get_lightning_config_migrates_old_flat_format(testbed):
    run(testbed.keymaster.create_id("Bob"))
    wallet = run(testbed.keymaster.load_wallet())
    wallet["ids"]["Bob"]["lightning"] = {
        "walletId": "w1",
        "adminKey": "admin1",
        "invoiceKey": "invoice1",
    }
    assert run(testbed.keymaster.save_wallet(wallet, True)) is True

    assert run(testbed.keymaster.get_lightning_balance())["balance"] == 1000
    assert run(testbed.keymaster.load_wallet())["ids"]["Bob"]["lightning"] == {
        "http://test-drawbridge": {
            "walletId": "w1",
            "adminKey": "admin1",
            "invoiceKey": "invoice1",
        }
    }


def test_lightning_gateway_methods_and_publish_cycle(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.add_lightning())

    assert run(testbed.keymaster.get_lightning_balance())["balance"] == 1000
    assert run(testbed.keymaster.create_lightning_invoice(100, "coffee"))["paymentRequest"] == "lnbc100"
    assert run(testbed.keymaster.pay_lightning_invoice("lnbc100..."))["paymentHash"].startswith("paid-")
    assert run(testbed.keymaster.check_lightning_payment("hash123"))["paymentHash"] == "hash123"
    assert run(testbed.keymaster.get_lightning_payments())[0]["amount"] == 100

    assert run(testbed.keymaster.publish_lightning()) is True
    services = run(testbed.keymaster.resolve_did(did))["didDocument"]["service"]
    assert services == [
        {
            "id": f"{did}#lightning",
            "type": "Lightning",
            "serviceEndpoint": f"http://test-drawbridge/invoice/{did.split(':')[-1]}",
        }
    ]

    assert run(testbed.keymaster.unpublish_lightning()) is True
    assert "service" not in run(testbed.keymaster.resolve_did(did))["didDocument"]


def test_lightning_config_is_scoped_to_current_url(testbed):
    run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.add_lightning())

    testbed.gatekeeper.url = "http://other-drawbridge"

    with pytest.raises(KeymasterError, match="No Lightning wallet configured"):
        run(testbed.keymaster.get_lightning_balance())


def test_publish_lightning_uses_public_host_and_replaces_existing_service(testbed):
    async def publish_with_public_host(did: str, invoice_key: str):
        return {"ok": True, "publicHost": "http://abc123.onion:4222", "did": did, "invoiceKey": invoice_key}

    testbed.gatekeeper.publish_lightning = publish_with_public_host
    did = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.add_lightning())

    assert run(testbed.keymaster.publish_lightning()) is True
    assert run(testbed.keymaster.publish_lightning()) is True

    services = run(testbed.keymaster.resolve_did(did))["didDocument"]["service"]
    assert len(services) == 1
    assert services[0]["serviceEndpoint"] == f"http://abc123.onion:4222/invoice/{did.split(':')[-1]}"


def test_decode_lightning_invoice_vectors(testbed):
    coffee = run(testbed.keymaster.decode_lightning_invoice(COFFEE_INVOICE))
    donation = run(testbed.keymaster.decode_lightning_invoice(DONATION_INVOICE))

    assert coffee["amount"] == "250000 sats"
    assert coffee["description"] == "1 cup coffee"
    assert coffee["payment_hash"] == "0001020304050607080900010203040506070809000102030405060708090102"
    assert coffee["expiry"] == "60 seconds"
    assert coffee["network"] == "bc"
    assert coffee["expires"] == "2017-06-01T10:58:38Z"

    assert "amount" not in donation
    assert donation["description"] == "Please consider supporting this project"
    assert donation["payment_hash"] == "0001020304050607080900010203040506070809000102030405060708090102"
    assert donation["network"] == "bc"
    assert "expiry" not in donation
    assert "expires" not in donation

    with pytest.raises(KeymasterError, match="Invalid parameter: bolt11"):
        run(testbed.keymaster.decode_lightning_invoice(""))

    with pytest.raises(Exception):
        run(testbed.keymaster.decode_lightning_invoice("not-a-valid-invoice"))


def test_zap_lightning_resolves_alias_and_lud16(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.add_lightning())

    alias_payment = run(testbed.keymaster.zap_lightning("Alice", 21, "thanks"))
    lud16_payment = run(testbed.keymaster.zap_lightning("alice@example.com", 5))

    assert alias_payment["did"] == alice
    assert alias_payment["amount"] == 21
    assert alias_payment["memo"] == "thanks"
    assert alias_payment["paymentHash"].startswith("zap-")
    assert lud16_payment["did"] == "alice@example.com"


def test_lightning_validation_and_unavailable_gateway(testbed):
    run(testbed.keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="Invalid parameter: amount"):
        run(testbed.keymaster.create_lightning_invoice(0, "test"))

    with pytest.raises(KeymasterError, match="Invalid parameter: bolt11"):
        run(testbed.keymaster.pay_lightning_invoice(""))

    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.zap_lightning("", 100))

    with pytest.raises(KeymasterError, match="No Lightning wallet configured"):
        run(testbed.keymaster.get_lightning_payments())

    class PlainGatekeeper:
        def __init__(self, delegate):
            self._delegate = delegate
            self.url = delegate.url

        async def list_registries(self):
            return await self._delegate.list_registries()

        async def create_did(self, operation):
            return await self._delegate.create_did(operation)

        async def resolve_did(self, did, options=None):
            return await self._delegate.resolve_did(did, options)

        async def update_did(self, operation):
            return await self._delegate.update_did(operation)

        async def delete_did(self, operation):
            return await self._delegate.delete_did(operation)

        async def get_block(self, registry, block=None):
            return await self._delegate.get_block(registry, block)

        async def search(self, query):
            return await self._delegate.search(query)

        async def add_data(self, data):
            return await self._delegate.add_data(data)

        async def get_data(self, cid):
            return await self._delegate.get_data(cid)

        async def add_text(self, text):
            return await self._delegate.add_text(text)

        async def get_text(self, cid):
            return await self._delegate.get_text(cid)

    plain_gatekeeper = PlainGatekeeper(make_testbed().gatekeeper)
    plain_keymaster = Keymaster(gatekeeper=plain_gatekeeper, wallet_store=FakeWalletStore(), passphrase="passphrase")
    run(plain_keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="Gateway does not support Lightning"):
        run(plain_keymaster.add_lightning())
