from __future__ import annotations

import asyncio
import json

import pytest

from keymaster import (
    CashuInsufficientFundsError,
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuNotConfiguredError,
    CashuQuoteUnpaidError,
    CashuStateError,
    CashuTokenSpentError,
    CashuUnavailableError,
    Keymaster,
    KeymasterError,
)
from keymaster.cashu import normalize_mint_url, split_amount
from keymaster.cashu_crypto import decode_token, encode_token, proof_y, resolve_keyset_ids

from .cashu_fake_mint import FakeMint
from .helpers import FakeWalletStore, make_testbed, run

PUBLIC_URL = "https://mint.example/cashu"


class Bed:
    def __init__(self, **options) -> None:
        self.mint = FakeMint(**options)
        self.testbed = make_testbed()
        self.keymaster = self.testbed.keymaster
        self.gatekeeper = self.testbed.gatekeeper
        self.gatekeeper.url = "http://test-node"

        async def get_cashu_mint() -> str:
            return PUBLIC_URL

        self.gatekeeper.get_cashu_mint = get_cashu_mint
        self.keymaster._node_capabilities = None
        self.wire(self.keymaster)
        run(self.keymaster.create_id("Alice"))

    def wire(self, keymaster: Keymaster) -> None:
        keymaster.cashu.node_fetch = self.mint.fetch
        keymaster.cashu.public_fetch = self.mint.fetch

    def fund(self, amount: int, name: str | None = None, keymaster: Keymaster | None = None) -> None:
        km = keymaster or self.keymaster
        quote = run(km.create_cashu_mint_quote(amount, None, name))
        self.mint.pay_mint_quote(quote["quote"])
        run(km.claim_cashu_mint_quote(quote["quote"], None, name))

    def balance(self, name: str | None = None) -> dict:
        return run(self.keymaster.get_cashu_balance(None, name))

    def entry(self, name: str = "Alice") -> dict:
        return run(self.keymaster.load_wallet())["ids"][name]["cashu"][PUBLIC_URL]

    def counters(self) -> dict:
        return run(self.keymaster.load_wallet())["cashu"]["counters"][self.mint.keyset_id]


@pytest.fixture
def bed(monkeypatch):
    monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
    return Bed()


@pytest.fixture
def funded(bed):
    run(bed.keymaster.add_cashu())
    bed.fund(100)
    run(bed.keymaster.create_id("Bob"))
    run(bed.keymaster.add_cashu("Bob"))
    run(bed.keymaster.set_current_id("Alice"))
    return bed


@pytest.mark.parametrize("given,expected", [
    ("HTTPS://Mint.Example:443/Cashu/", "https://mint.example/Cashu"),
    ("https://mint.example/?a=1#frag", "https://mint.example"),
    ("http://mint.example:80", "http://mint.example"),
    ("https://mint.example:8443/", "https://mint.example:8443"),
])
def test_normalizes_mint_urls(given, expected):
    assert normalize_mint_url(given) == expected


@pytest.mark.parametrize("given", ["not a url", "ftp://mint.example", "https://", None])
def test_rejects_invalid_mint_urls(given):
    with pytest.raises(KeymasterError, match="Invalid parameter"):
        normalize_mint_url(given)


@pytest.mark.parametrize("amount,parts", [(1, [1]), (13, [1, 4, 8]), (64, [64]), (0, [])])
def test_splits_amounts(amount, parts):
    assert split_amount(amount) == parts


class TestEnabling:
    def test_adds_the_node_mint_idempotently(self, bed):
        info = run(bed.keymaster.add_cashu())
        assert info["url"] == PUBLIC_URL and info["isNodeMint"] and info["name"] == "Fake mint"
        run(bed.keymaster.add_cashu())
        assert bed.entry()["node"] == "http://test-node"
        assert len(run(bed.keymaster.list_cashu_mints())) == 1

    def test_points_to_add_cashu_mint_on_a_node_without_one(self, bed):
        async def none() -> None:
            return None

        bed.gatekeeper.get_cashu_mint = none
        with pytest.raises(CashuUnavailableError, match="addCashuMint"):
            run(bed.keymaster.add_cashu())

    def test_respects_the_node_capability(self, bed):
        bed.keymaster._node_capabilities = {"cashu": False}
        with pytest.raises(CashuUnavailableError):
            run(bed.keymaster.add_cashu())

    def test_refuses_a_mint_without_required_nuts(self, monkeypatch):
        monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
        bed = Bed(nuts=[4, 5, 7, 8])
        with pytest.raises(CashuMintUnsupportedError, match="NUT-9"):
            run(bed.keymaster.add_cashu())

    def test_adds_an_outside_mint_through_the_public_fetch(self, bed):
        requested: list[str] = []
        fetch = bed.mint.fetch

        async def public(method, url, *args):
            requested.append(url)
            return await fetch(method, url.replace("https://outside.example", "http://x"), *args)

        bed.keymaster.cashu.public_fetch = public
        info = run(bed.keymaster.add_cashu_mint("https://outside.example/"))
        assert info["url"] == "https://outside.example" and not info["isNodeMint"]
        assert all(url.startswith("https://outside.example/v1/") for url in requested)

    def test_the_real_public_fetch_refuses_http_and_private_addresses(self, bed):
        from keymaster.net import fetch_public_https

        bed.keymaster.cashu.public_fetch = fetch_public_https
        for url in ("http://mint.example", "https://127.0.0.1:3338"):
            with pytest.raises(CashuUnavailableError):
                run(bed.keymaster.add_cashu_mint(url))

    def test_requires_a_mint_before_anything_else(self, bed):
        with pytest.raises(CashuNotConfiguredError):
            run(bed.keymaster.get_cashu_balance())
        with pytest.raises(CashuNotConfiguredError):
            run(bed.keymaster.send_cashu(1))

    def test_publishes_and_unpublishes(self, bed):
        run(bed.keymaster.add_cashu())
        did = run(bed.keymaster.fetch_id_info())["did"]

        run(bed.keymaster.publish_cashu())
        service = run(bed.keymaster.resolve_did(did))["didDocument"]["service"]
        assert service == [{"id": f"{did}#cashu", "type": "Cashu", "serviceEndpoint": [PUBLIC_URL]}]

        run(bed.keymaster.unpublish_cashu())
        assert "service" not in run(bed.keymaster.resolve_did(did))["didDocument"]


class TestMinting:
    @pytest.fixture(autouse=True)
    def enabled(self, bed):
        run(bed.keymaster.add_cashu())

    def test_claims_with_a_nut20_signature_and_credits(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(100))
        assert quote["amount"] == 100 and quote["state"] == "UNPAID"
        assert bed.mint.mint_quotes[quote["quote"]]["pubkey"]
        listed = run(bed.keymaster.list_cashu_quotes())
        assert listed[0]["kind"] == "mint" and listed[0]["quote"] == quote["quote"] and listed[0]["mint"] == PUBLIC_URL

        bed.mint.pay_mint_quote(quote["quote"])
        assert run(bed.keymaster.claim_cashu_mint_quote(quote["quote"])) == {"amount": 100, "mint": PUBLIC_URL}

        assert bed.balance() == {"spendable": 100, "inFlight": 0, "outstanding": 0}
        assert run(bed.keymaster.list_cashu_quotes()) == []
        assert [proof["amount"] for proof in bed.entry()["proofs"]] == [4, 32, 64]

    def test_refuses_an_unpaid_quote_and_keeps_it(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(10))
        with pytest.raises(CashuQuoteUnpaidError):
            run(bed.keymaster.claim_cashu_mint_quote(quote["quote"]))
        assert len(run(bed.keymaster.list_cashu_quotes())) == 1

    def test_reports_an_expired_unpaid_quote_as_unpaid_and_drops_it(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(10))
        bed.mint.mint_quotes[quote["quote"]]["expiry"] = 1

        with pytest.raises(CashuQuoteUnpaidError):
            run(bed.keymaster.claim_cashu_mint_quote(quote["quote"]))

        assert run(bed.keymaster.list_cashu_quotes()) == []
        assert bed.balance()["spendable"] == 0

    def test_recovers_a_claim_whose_response_was_lost(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(21))
        bed.mint.pay_mint_quote(quote["quote"])
        bed.mint.lose_response("/v1/mint/bolt11")

        with pytest.raises(CashuUnavailableError):
            run(bed.keymaster.claim_cashu_mint_quote(quote["quote"]))
        assert bed.balance()["spendable"] == 0

        assert run(bed.keymaster.check_cashu()) == {"settled": 1, "open": 0}
        assert bed.balance()["spendable"] == 21

    def test_drops_an_expired_unpaid_quote(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(5))
        bed.mint.mint_quotes[quote["quote"]]["expiry"] = 1

        assert run(bed.keymaster.check_cashu()) == {"settled": 1, "open": 0}
        assert run(bed.keymaster.list_cashu_quotes()) == []

    def test_survives_a_restart_with_the_journal_intact(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(9))
        bed.mint.pay_mint_quote(quote["quote"])

        restarted = Keymaster(gatekeeper=bed.gatekeeper, wallet_store=bed.testbed.wallet_store, passphrase="passphrase")
        restarted._node_capabilities = None
        bed.wire(restarted)
        run(restarted.claim_cashu_mint_quote(quote["quote"]))

        assert run(restarted.get_cashu_balance())["spendable"] == 9

    def test_read_methods_do_not_touch_the_network(self, bed):
        run(bed.keymaster.create_cashu_mint_quote(5))
        bed.mint.requests.clear()

        bed.balance()
        run(bed.keymaster.list_cashu_quotes())
        run(bed.keymaster.list_cashu_sends())

        assert bed.mint.requests == []


class TestSendingAndReceiving:
    def test_moves_value_between_identities(self, funded):
        km = funded.keymaster
        sent = run(km.send_cashu(30))
        assert sent["amount"] == 30 and sent["fee"] == 0 and sent["token"].startswith("cashuB")
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 30}
        assert run(km.list_cashu_sends())[0]["operationId"] == sent["operationId"]

        assert run(km.receive_cashu(sent["token"], "Bob")) == {"amount": 30, "mint": PUBLIC_URL}

        assert funded.balance("Bob")["spendable"] == 30
        run(km.check_cashu())
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 0}
        assert run(km.list_cashu_sends()) == []

    def test_rejects_a_token_already_redeemed(self, funded):
        km = funded.keymaster
        token = run(km.send_cashu(10))["token"]
        run(km.receive_cashu(token, "Bob"))
        run(km.create_id("Carol"))
        run(km.add_cashu("Carol"))

        with pytest.raises(CashuTokenSpentError):
            run(km.receive_cashu(token, "Carol"))

        assert funded.balance("Carol")["spendable"] == 0
        assert "operations" not in funded.entry("Carol")

    def test_rejects_a_token_from_an_unadded_mint_before_any_request(self, funded):
        token = encode_token("https://other.example", "sat", [{"id": funded.mint.keyset_id, "amount": 1, "secret": "aa", "C": "02" + "ab" * 32}])
        funded.mint.requests.clear()

        with pytest.raises(CashuMintNotAddedError):
            run(funded.keymaster.receive_cashu(token))
        assert funded.mint.requests == []

    def test_stays_with_the_identity_it_started_on_when_the_current_one_changes(self, funded):
        async def switch(path):
            if path == "/v1/swap":
                funded.mint.on_request = None
                await funded.keymaster.set_current_id("Bob")

        funded.mint.on_request = switch

        assert run(funded.keymaster.send_cashu(30))["amount"] == 30

        assert funded.balance("Alice") == {"spendable": 70, "inFlight": 0, "outstanding": 30}
        assert funded.balance("Bob") == {"spendable": 0, "inFlight": 0, "outstanding": 0}

    def test_rejects_an_oversized_dleq_as_an_invalid_token(self, funded):
        import base64

        token = run(funded.keymaster.send_cashu(8))["token"]
        proofs = resolve_keyset_ids(decode_token(token)["proofs"], [funded.mint.keyset_id])
        forged = [{**proof, "dleq": {**proof["dleq"], "e": "ff" * 33}} for proof in proofs]
        payload = json.dumps({"token": [{"mint": PUBLIC_URL, "proofs": forged}], "unit": "sat"}).encode()
        v3 = "cashuA" + base64.urlsafe_b64encode(payload).decode().rstrip("=")

        with pytest.raises(KeymasterError, match="Invalid parameter: token"):
            run(funded.keymaster.receive_cashu(v3, "Bob"))

    def test_another_identity_cannot_restore_the_outputs_of_an_unfinished_send(self, funded):
        funded.mint.lose_response("/v1/swap")
        with pytest.raises(CashuUnavailableError):
            run(funded.keymaster.send_cashu(30))

        assert run(funded.keymaster.restore_cashu(None, "Bob")) == {"restored": 0, "amount": 0}
        run(funded.keymaster.check_cashu())

        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 30}
        assert funded.balance("Bob")["spendable"] == 0

    def test_re_swaps_the_unspent_part_of_a_partly_redeemed_reclaim(self, funded):
        sent = run(funded.keymaster.send_cashu(6))
        record = next(op for op in funded.entry()["operations"] if op["id"] == sent["operationId"])
        two = next(proof for proof in record["sent"] if proof["amount"] == 2)
        four = next(proof for proof in record["sent"] if proof["amount"] == 4)
        funded.mint.spent.add(proof_y(two["secret"]))

        with pytest.raises(CashuTokenSpentError):
            run(funded.keymaster.reclaim_cashu(sent["operationId"]))

        assert funded.balance() == {"spendable": 98, "inFlight": 0, "outstanding": 0}
        # The recipient still holds the original, so it must not come back as is.
        assert four["secret"] not in [proof["secret"] for proof in funded.entry()["proofs"]]
        assert proof_y(four["secret"]) in funded.mint.spent

    def test_keeps_nothing_of_a_partly_spent_token_it_was_receiving(self, funded):
        sent = run(funded.keymaster.send_cashu(6))
        record = next(op for op in funded.entry()["operations"] if op["id"] == sent["operationId"])
        funded.mint.spent.add(proof_y(record["sent"][0]["secret"]))

        with pytest.raises(CashuTokenSpentError):
            run(funded.keymaster.receive_cashu(sent["token"], "Bob"))

        assert funded.balance("Bob") == {"spendable": 0, "inFlight": 0, "outstanding": 0}

    def test_settlement_does_not_submit_a_record_still_being_journaled(self, funded):
        km = funded.keymaster
        save = km._save_loaded_wallet
        checks = []

        async def saving(wallet, overwrite=True):
            result = await save(wallet, overwrite)
            operations = wallet["ids"]["Alice"]["cashu"][PUBLIC_URL].get("operations") or []
            if not checks and any(op["kind"] == "send" and not op.get("sent") for op in operations):
                checks.append(asyncio.create_task(km.check_cashu()))
                await asyncio.sleep(0.05)
            return result

        km._save_loaded_wallet = saving
        funded.mint.requests.clear()

        async def go():
            await km.send_cashu(30)
            await checks[0]

        run(go())

        assert funded.mint.requests.count("POST /v1/swap") == 1
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 30}

    def test_rejects_a_malformed_token(self, funded):
        with pytest.raises(KeymasterError, match="Invalid parameter: token"):
            run(funded.keymaster.receive_cashu("cashuBnot-a-token"))

    def test_accepts_a_v3_token(self, funded):
        import base64

        token = run(funded.keymaster.send_cashu(8))["token"]
        proofs = resolve_keyset_ids(decode_token(token)["proofs"], [funded.mint.keyset_id])
        payload = json.dumps({"token": [{"mint": PUBLIC_URL, "proofs": proofs}], "unit": "sat"}).encode()
        v3 = "cashuA" + base64.urlsafe_b64encode(payload).decode().rstrip("=")

        assert run(funded.keymaster.receive_cashu(v3, "Bob"))["amount"] == 8

    def test_rejects_a_token_whose_dleq_does_not_verify(self, funded):
        token = run(funded.keymaster.send_cashu(8))["token"]
        decoded = decode_token(token)
        forged_proofs = [{**proof, "dleq": {**proof["dleq"], "s": "ab" * 32}} for proof in decoded["proofs"]]
        forged = encode_token(PUBLIC_URL, "sat", forged_proofs)
        funded.mint.requests.clear()

        with pytest.raises(KeymasterError, match="Invalid parameter: token"):
            run(funded.keymaster.receive_cashu(forged, "Bob"))
        assert "POST /v1/swap" not in funded.mint.requests

    def test_fails_a_send_beyond_the_balance_taking_nothing(self, funded):
        with pytest.raises(CashuInsufficientFundsError):
            run(funded.keymaster.send_cashu(101))
        assert funded.balance() == {"spendable": 100, "inFlight": 0, "outstanding": 0}

    def test_finishes_a_send_whose_response_was_lost(self, funded):
        funded.mint.lose_response("/v1/swap")

        with pytest.raises(CashuUnavailableError):
            run(funded.keymaster.send_cashu(30))
        # The 64 proof covers it; the rest of the funding (4 + 32) stays spendable.
        assert funded.balance()["spendable"] == 36 and funded.balance()["inFlight"] == 64

        run(funded.keymaster.check_cashu())
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 30}

    def test_finishes_a_receive_whose_response_was_lost_without_double_counting(self, funded):
        token = run(funded.keymaster.send_cashu(30))["token"]
        funded.mint.lose_response("/v1/swap")

        with pytest.raises(CashuUnavailableError):
            run(funded.keymaster.receive_cashu(token, "Bob"))
        run(funded.keymaster.check_cashu(None, "Bob"))
        run(funded.keymaster.check_cashu(None, "Bob"))

        assert funded.balance("Bob")["spendable"] == 30

    def test_returns_inputs_when_the_mint_rejects_a_swap_and_frees_counters(self, funded):
        before = funded.counters()["next"]
        funded.mint.refuse_next("/v1/swap", 11002, "transaction unbalanced")

        with pytest.raises(KeymasterError, match="transaction unbalanced"):
            run(funded.keymaster.send_cashu(30))

        assert funded.balance() == {"spendable": 100, "inFlight": 0, "outstanding": 0}
        counters = funded.counters()
        assert counters["next"] > before and counters["free"]

        run(funded.keymaster.send_cashu(30))
        assert funded.counters()["free"] == []

    def test_takes_back_an_unredeemed_send(self, funded):
        sent = run(funded.keymaster.send_cashu(30))
        assert run(funded.keymaster.reclaim_cashu(sent["operationId"])) == {"amount": 30, "mint": PUBLIC_URL}
        assert funded.balance() == {"spendable": 100, "inFlight": 0, "outstanding": 0}

    def test_cannot_take_back_a_redeemed_send(self, funded):
        sent = run(funded.keymaster.send_cashu(30))
        run(funded.keymaster.receive_cashu(sent["token"], "Bob"))

        with pytest.raises(CashuTokenSpentError):
            run(funded.keymaster.reclaim_cashu(sent["operationId"]))
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 0}

    def test_keeps_concurrent_operations_from_spending_the_same_proofs(self, funded):
        async def go():
            return await asyncio.gather(*(funded.keymaster.send_cashu(4) for _ in range(3)))

        sends = run(go())
        assert len({send["token"] for send in sends}) == 3
        assert funded.balance() == {"spendable": 88, "inFlight": 0, "outstanding": 12}

    def test_leaves_a_swap_open_when_outputs_are_pending(self, funded):
        funded.mint.refuse_next("/v1/swap", 11004, "outputs pending")

        with pytest.raises(CashuUnavailableError):
            run(funded.keymaster.send_cashu(30))
        assert funded.balance()["inFlight"] == 64

        run(funded.keymaster.check_cashu())
        assert funded.balance() == {"spendable": 70, "inFlight": 0, "outstanding": 30}

    def test_settlement_failures_do_not_block_the_operation(self, funded):
        quote = run(funded.keymaster.create_cashu_mint_quote(5))
        funded.mint.pay_mint_quote(quote["quote"])
        funded.mint.refuse_next("/v1/mint/bolt11", 20000, "try later")

        assert run(funded.keymaster.send_cashu(4))["amount"] == 4
        assert run(funded.keymaster.check_cashu())["open"] == 1
        assert funded.balance()["spendable"] == 101


class TestFees:
    @pytest.fixture
    def charged(self, monkeypatch):
        monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
        bed = Bed(input_fee_ppk=500)
        run(bed.keymaster.add_cashu())
        bed.fund(100)
        run(bed.keymaster.create_id("Bob"))
        run(bed.keymaster.add_cashu("Bob"))
        run(bed.keymaster.set_current_id("Alice"))
        return bed

    def test_recipient_nets_at_least_the_amount(self, charged):
        # 30 is a case with no exact gross: 31 nets 28 after a five-part fee, 32 nets 31.
        sent = run(charged.keymaster.send_cashu(30))
        assert sent["fee"] == 2
        assert run(charged.keymaster.receive_cashu(sent["token"], "Bob"))["amount"] == 31

    def test_recipient_nets_exactly_when_a_gross_allows_it(self, charged):
        sent = run(charged.keymaster.send_cashu(31))
        assert sent["fee"] == 1
        assert run(charged.keymaster.receive_cashu(sent["token"], "Bob"))["amount"] == 31


class TestMelting:
    @pytest.fixture(autouse=True)
    def enabled(self, bed):
        run(bed.keymaster.add_cashu())
        bed.fund(200)

    def test_pays_and_keeps_the_change(self, bed):
        result = run(bed.keymaster.melt_cashu("lnbc-amount=100"))
        assert result["paid"] and result["fee"] == 1 and result["preimage"] == "ab" * 32 and result["change"] > 0
        assert bed.balance()["spendable"] == 99

    def test_frees_counters_of_unsigned_change(self, bed):
        run(bed.keymaster.melt_cashu("lnbc-amount=100"))
        assert bed.counters()["free"]

    def test_leaves_a_pending_melt_open_then_settles_it(self, bed):
        bed.mint.melt_outcome = "PENDING"
        result = run(bed.keymaster.melt_cashu("lnbc-amount=100"))
        assert not result["paid"] and result["pending"] and result["change"] == 0
        assert bed.balance()["inFlight"] > 0

        assert run(bed.keymaster.check_cashu()) == {"settled": 0, "open": 1}

        next(iter(bed.mint.melt_quotes.values()))["state"] = "PAID"
        assert run(bed.keymaster.check_cashu()) == {"settled": 1, "open": 0}
        assert bed.balance()["inFlight"] == 0

    def test_returns_the_inputs_of_an_unpaid_melt(self, bed):
        bed.mint.melt_outcome = "UNPAID"
        result = run(bed.keymaster.melt_cashu("lnbc-amount=100"))
        assert not result["paid"]
        assert bed.balance() == {"spendable": 200, "inFlight": 0, "outstanding": 0}

    def test_keeps_the_change_when_the_response_was_lost(self, bed):
        bed.mint.lose_response("/v1/melt/bolt11")
        with pytest.raises(CashuUnavailableError):
            run(bed.keymaster.melt_cashu("lnbc-amount=100"))

        run(bed.keymaster.check_cashu())
        assert bed.balance() == {"spendable": 99, "inFlight": 0, "outstanding": 0}

    def test_requires_an_invoice(self, bed):
        with pytest.raises(KeymasterError, match="Invalid parameter: bolt11"):
            run(bed.keymaster.melt_cashu(None))

    def test_fails_a_melt_it_cannot_cover(self, bed):
        with pytest.raises(CashuInsufficientFundsError):
            run(bed.keymaster.melt_cashu("lnbc-amount=500"))


class TestRecovery:
    @pytest.fixture(autouse=True)
    def enabled(self, bed):
        run(bed.keymaster.add_cashu())
        bed.fund(100)

    def recovered(self, bed) -> Keymaster:
        mnemonic = run(bed.keymaster.decrypt_mnemonic())
        other = Keymaster(gatekeeper=bed.gatekeeper, wallet_store=FakeWalletStore(), passphrase="passphrase")
        run(other.new_wallet(mnemonic))
        other._node_capabilities = None
        bed.wire(other)
        run(other.create_id("Alice"))
        run(other.add_cashu())
        return other

    def test_restores_unspent_proofs_once(self, bed):
        other = self.recovered(bed)

        first = run(other.restore_cashu())
        assert first["amount"] == 100 and first["restored"] > 0
        assert run(other.restore_cashu())["amount"] == 0
        assert run(other.get_cashu_balance())["spendable"] == 100
        assert run(other.load_wallet())["cashu"]["counters"][bed.mint.keyset_id]["next"] > 0

    def test_does_not_restore_spent_proofs(self, bed):
        run(bed.keymaster.melt_cashu("lnbc-amount=90"))
        balance = bed.balance()["spendable"]
        other = self.recovered(bed)

        run(other.restore_cashu())
        assert run(other.get_cashu_balance())["spendable"] == balance

    # cdk-mintd answers a mint request with 20006 where NUT-00 lists 11003.
    @pytest.mark.parametrize("code", [11003, 20006])
    def test_repairs_stale_counters_on_a_refused_mint_request(self, bed, code):
        bed.mint.already_signed_code = code
        other = self.recovered(bed)

        bed.fund(40, keymaster=other)

        assert run(other.get_cashu_balance())["spendable"] == 140

    def with_stale_counters(self, bed) -> Keymaster:
        other = self.recovered(bed)
        run(other.restore_cashu())

        async def reset(wallet):
            wallet["cashu"]["counters"][bed.mint.keyset_id] = {"next": 0, "free": []}

        run(other.cashu._mutate(reset))
        return other

    def test_repairs_stale_counters_on_a_swap(self, bed):
        other = self.with_stale_counters(bed)

        assert run(other.send_cashu(10))["amount"] == 10
        assert run(other.get_cashu_balance())["spendable"] == 90

    def test_repairs_stale_counters_on_a_melt(self, bed):
        other = self.with_stale_counters(bed)

        assert run(other.melt_cashu("lnbc-amount=50"))["paid"]
        assert run(other.get_cashu_balance())["spendable"] == 49

    def test_fails_a_refused_request_whose_outputs_were_not_signed(self, bed):
        quote = run(bed.keymaster.create_cashu_mint_quote(5))
        bed.mint.pay_mint_quote(quote["quote"])
        bed.mint.refuse_next("/v1/mint/bolt11", 20000, "try later")

        with pytest.raises(KeymasterError, match="try later"):
            run(bed.keymaster.claim_cashu_mint_quote(quote["quote"]))

        assert bed.mint.requests.count("POST /v1/restore") == 1
        assert len(run(bed.keymaster.list_cashu_quotes())) == 1

    def test_stops_after_three_empty_batches(self, monkeypatch):
        monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
        bed = Bed()
        run(bed.keymaster.add_cashu())
        bed.mint.requests.clear()

        assert run(bed.keymaster.restore_cashu()) == {"restored": 0, "amount": 0}
        assert bed.mint.requests.count("POST /v1/restore") == 3


class TestRemovalGuards:
    @pytest.fixture(autouse=True)
    def enabled(self, bed):
        run(bed.keymaster.add_cashu())

    def test_removes_an_empty_mint(self, bed):
        run(bed.keymaster.remove_cashu_mint(PUBLIC_URL))
        assert "cashu" not in run(bed.keymaster.load_wallet())["ids"]["Alice"]

    def test_refuses_to_discard_state_unless_forced(self, bed):
        run(bed.keymaster.create_cashu_mint_quote(5))

        with pytest.raises(CashuStateError):
            run(bed.keymaster.remove_cashu_mint(PUBLIC_URL))
        with pytest.raises(CashuStateError):
            run(bed.keymaster.remove_cashu())

        run(bed.keymaster.remove_cashu(True))
        assert "cashu" not in run(bed.keymaster.load_wallet())["ids"]["Alice"]

    @pytest.mark.parametrize("force", ["false", "true", 1, {}])
    def test_does_not_take_a_non_boolean_as_force(self, bed, force):
        run(bed.keymaster.create_cashu_mint_quote(5))

        with pytest.raises(CashuStateError):
            run(bed.keymaster.remove_cashu(force))
        with pytest.raises(CashuStateError):
            run(bed.keymaster.remove_cashu_mint(PUBLIC_URL, force))

    def test_refuses_to_remove_an_identity_holding_state(self, bed):
        bed.fund(5)
        with pytest.raises(CashuStateError):
            run(bed.keymaster.remove_id("Alice"))

    def test_fix_wallet_keeps_an_identity_holding_state_and_reports_it(self, bed):
        bed.fund(5)
        run(bed.keymaster.revoke_did(run(bed.keymaster.fetch_id_info())["did"]))

        result = run(bed.keymaster.fix_wallet())

        assert result["idsRemoved"] == 0 and result["idsKept"] == ["Alice"]
        assert "Alice" in run(bed.keymaster.load_wallet())["ids"]

    def test_fix_wallet_omits_ids_kept_when_there_are_none(self, bed):
        assert "idsKept" not in run(bed.keymaster.fix_wallet())


class TestSeveralMints:
    @pytest.fixture(autouse=True)
    def enabled(self, bed):
        run(bed.keymaster.add_cashu())

    def add_outside(self, bed, url):
        async def go():
            async def mutator(wallet):
                wallet["ids"]["Alice"]["cashu"][url] = {"added": "now", "proofs": [{"id": "x", "amount": 7, "secret": url, "C": "b"}]}

            await bed.keymaster.cashu._mutate(mutator)

        run(go())

    def test_totals_the_balance_across_mints(self, bed):
        self.add_outside(bed, "https://outside.example")
        bed.fund(10)

        balance = bed.balance()

        assert balance["spendable"] == 17
        assert balance["mints"][PUBLIC_URL]["spendable"] == 10
        assert run(bed.keymaster.get_cashu_balance("https://outside.example"))["spendable"] == 7

    def test_requires_a_mint_when_there_are_several_and_no_node_mint(self, bed):
        self.add_outside(bed, "https://outside.example")
        self.add_outside(bed, "https://other.example")
        run(bed.keymaster.remove_cashu_mint(PUBLIC_URL))

        with pytest.raises(KeymasterError, match="mint is required"):
            run(bed.keymaster.send_cashu(1))

    def test_refuses_an_unadded_mint(self, bed):
        with pytest.raises(CashuMintNotAddedError):
            run(bed.keymaster.send_cashu(1, "https://nope.example"))
