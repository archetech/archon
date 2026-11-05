from __future__ import annotations

import time

import pytest

from keymaster import (
    CashuMintNotAddedError,
    CashuMintUnsupportedError,
    CashuNotConfiguredError,
    CashuTokenLockedError,
    CashuTokenSpentError,
    KeymasterError,
    core,
)
from keymaster.didcomm_protocols import CASHU_TOKEN_TYPE, is_cashu_token_message

from .cashu_fake_mint import FakeMint, FakeRelay
from .helpers import make_testbed, run

PUBLIC_URL = "https://mint.example/cashu"
OTHER_URL = "https://other.example/cashu"
NODE = "http://test-node"
DAY = 24 * 60 * 60


class Bed:
    def __init__(self, monkeypatch, **options) -> None:
        self.monkeypatch = monkeypatch
        self.mint = FakeMint(**options)
        self.relay = FakeRelay()
        monkeypatch.setattr(core.httpx, "AsyncClient", self.relay.client)
        self.testbed = make_testbed()
        self.km = self.testbed.keymaster
        gatekeeper = self.testbed.gatekeeper
        gatekeeper.url = NODE

        async def get_cashu_mint() -> str:
            return PUBLIC_URL

        async def get_didcomm_endpoint() -> str:
            return f"{NODE}/didcomm"

        gatekeeper.get_cashu_mint = get_cashu_mint
        gatekeeper.get_didcomm_endpoint = get_didcomm_endpoint
        self.km._node_capabilities = None
        self.km.cashu.node_fetch = self.mint.fetch
        self.km.cashu.public_fetch = self.mint.fetch
        self.alice = run(self.km.create_id("Alice"))
        self.bob = run(self.km.create_id("Bob"))
        run(self.km.create_id("Carol"))
        for name in ("Alice", "Bob", "Carol"):
            run(self.km.publish_didcomm(f"{NODE}/didcomm", name))
        run(self.km.add_cashu("Alice"))
        run(self.km.add_cashu("Bob"))
        run(self.km.publish_cashu("Bob"))
        self.fund(100)

    def fund(self, amount: int, name: str = "Alice") -> None:
        quote = run(self.km.create_cashu_mint_quote(amount, None, name))
        self.mint.pay_mint_quote(quote["quote"])
        run(self.km.claim_cashu_mint_quote(quote["quote"], None, name))

    def balance(self, name: str) -> dict:
        return run(self.km.get_cashu_balance(None, name))

    def send(self, amount: int = 30, **options) -> dict:
        return run(self.km.send_cashu_to("Bob", amount, {"name": "Alice", **options}))

    def accept(self, name: str = "Bob") -> dict:
        return run(self.km.receive_cashu_messages(name))

    def after(self, seconds: int) -> None:
        later = time.time() + seconds
        self.monkeypatch.setattr(time, "time", lambda: later)


@pytest.fixture
def bed(monkeypatch):
    monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
    return Bed(monkeypatch)


class TestSend:
    def test_locks_delivers_and_keeps_outstanding(self, bed):
        result = bed.send(30, memo="lunch")

        assert result["delivered"] is True
        assert (result["amount"], result["fee"], result["mint"], result["recipient"]) == (30, 0, PUBLIC_URL, bed.bob)
        assert "error" not in result
        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["inFlight"], balance["outstanding"]) == (70, 0, 30)
        assert [item["to"] for item in bed.relay.mailbox] == [bed.bob]
        listed = run(bed.km.list_cashu_sends(None, "Alice"))[0]
        assert listed["recipient"] == bed.bob
        assert listed["delivered"] is True
        assert listed["memo"] == "lunch"
        assert listed["locktime"] == result["locktime"]

    def test_takes_a_did(self, bed):
        assert run(bed.km.send_cashu_to(bed.bob, 5, {"name": "Alice"}))["recipient"] == bed.bob

    def test_default_locktime_and_limit(self, bed):
        before = int(time.time())
        assert before + 3 * DAY <= bed.send(1)["locktime"] <= before + 3 * DAY + 5
        for locktime in (7 * DAY + 1, 0, 1.5, True):
            with pytest.raises(KeymasterError, match="locktime"):
                bed.send(1, locktime=locktime)

    @pytest.mark.parametrize("amount", [0, -1, 1.5, "10", True])
    def test_refuses_bad_amounts(self, bed, amount):
        with pytest.raises(KeymasterError, match="amount"):
            bed.send(amount)

    def test_charges_the_fee_the_recipient_will_pay(self, monkeypatch):
        monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
        bed = Bed(monkeypatch, input_fee_ppk=1000)

        result = bed.send(30)

        assert result["fee"] > 0
        # The smallest gross that nets enough can net a little more.
        assert bed.accept()["redeemed"][0]["amount"] >= 30

    def test_reports_a_recipient_publishing_no_mints(self, bed):
        run(bed.km.unpublish_cashu("Bob"))

        with pytest.raises(CashuNotConfiguredError, match=bed.bob):
            bed.send()

    def test_names_the_mints_the_recipient_accepts(self, bed):
        doc = run(bed.km.resolve_did(bed.bob))
        services = [item for item in doc["didDocument"]["service"] if item["type"] != "Cashu"]
        doc["didDocument"]["service"] = [*services, {"id": f"{bed.bob}#cashu", "type": "Cashu", "serviceEndpoint": [OTHER_URL]}]
        run(bed.km.update_did(bed.bob, doc))

        with pytest.raises(CashuMintNotAddedError, match=OTHER_URL):
            bed.send()
        assert bed.balance("Alice")["spendable"] == 100

    def test_uses_the_mint_given(self, bed):
        run(bed.km.unpublish_cashu("Bob"))

        assert bed.send(5, mint=PUBLIC_URL)["mint"] == PUBLIC_URL

    def test_refuses_a_mint_without_nut_11_before_moving_anything(self, monkeypatch):
        monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
        bed = Bed(monkeypatch, nuts=[4, 5, 7, 8, 9, 12])

        with pytest.raises(CashuMintUnsupportedError, match="NUT-11"):
            bed.send()
        assert bed.balance("Alice")["outstanding"] == 0
        assert bed.balance("Alice")["spendable"] == 100

    def test_refuses_a_recipient_without_an_endpoint_before_moving_anything(self, bed):
        run(bed.km.unpublish_didcomm("Bob"))

        with pytest.raises(KeymasterError, match="DIDComm"):
            bed.send()
        assert bed.balance("Alice")["spendable"] == 100

    def test_refuses_a_sender_who_cannot_authenticate_before_moving_anything(self, bed):
        run(bed.km.unpublish_didcomm("Alice"))

        with pytest.raises(KeymasterError, match="keyAgreement"):
            bed.send()
        assert bed.balance("Alice")["spendable"] == 100

    def test_cannot_be_spent_by_anyone_else(self, bed):
        token = bed.send()["token"]
        run(bed.km.add_cashu("Carol"))

        with pytest.raises(CashuTokenLockedError):
            run(bed.km.receive_cashu(token, "Carol"))
        assert bed.balance("Carol")["spendable"] == 0


class TestDelivery:
    def test_keeps_a_token_the_relay_refused_and_says_so(self, bed):
        bed.relay.down = True

        result = bed.send()

        assert result["delivered"] is False
        assert result["error"]
        assert result["token"].startswith("cashuB")
        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["outstanding"]) == (70, 30)
        assert run(bed.km.list_cashu_sends(None, "Alice"))[0]["delivered"] is False

    def test_delivers_on_the_next_check_with_the_same_id(self, bed):
        bed.relay.down = True
        message_id = bed.send()["messageId"]
        bed.relay.down = False

        run(bed.km.check_cashu(None, "Alice"))

        assert len(bed.relay.mailbox) == 1
        message = run(bed.km.receive_didcomm({"name": "Bob", "ack": False}))[0]
        assert message["message"]["id"] == message_id
        assert run(bed.km.list_cashu_sends(None, "Alice"))[0]["delivered"] is True

    def test_does_not_resend_what_was_delivered(self, bed):
        bed.send()

        run(bed.km.check_cashu(None, "Alice"))
        run(bed.km.check_cashu(None, "Alice"))

        assert len(bed.relay.mailbox) == 1

    def test_recovers_a_lost_swap_response_and_still_delivers(self, bed):
        bed.mint.lose_response("/v1/swap")

        with pytest.raises(KeymasterError):
            bed.send()
        assert bed.balance("Alice")["inFlight"] == 64
        assert bed.relay.mailbox == []

        run(bed.km.check_cashu(None, "Alice"))

        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["inFlight"], balance["outstanding"]) == (70, 0, 30)
        assert len(bed.relay.mailbox) == 1
        assert bed.accept()["redeemed"][0]["amount"] == 30

    def test_returns_the_inputs_when_the_mint_refuses(self, bed):
        bed.mint.refuse_next("/v1/swap", 11001, "nope")

        with pytest.raises(KeymasterError, match="nope"):
            bed.send()

        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["inFlight"], balance["outstanding"]) == (100, 0, 0)
        assert bed.relay.mailbox == []


class TestGeneralInbox:
    def test_returns_a_token_message_without_consuming_it(self, bed):
        bed.send()

        received = run(bed.km.receive_didcomm({"name": "Bob"}))

        assert received[0]["message"]["type"] == CASHU_TOKEN_TYPE
        assert len(bed.relay.mailbox) == 1

    def test_still_consumes_other_messages(self, bed):
        bed.send()
        run(bed.km.send_didcomm({"type": "https://didcomm.org/basicmessage/2.0/message", "body": {"content": "hi"}}, "Bob", {"name": "Alice"}))

        run(bed.km.receive_didcomm({"name": "Bob"}))

        left = run(bed.km.receive_didcomm({"name": "Bob", "ack": False}))
        assert [item["message"]["type"] for item in left] == [CASHU_TOKEN_TYPE]

    def test_an_explicit_ack_removes_one(self, bed):
        bed.send()
        message_id = run(bed.km.receive_didcomm({"name": "Bob", "ack": False}))[0]["id"]

        assert run(bed.km.ack_didcomm([message_id], {"name": "Bob"})) == 1
        assert bed.relay.mailbox == []

    @pytest.mark.parametrize("kind,expected", [
        ("https://archetech.com/didcomm/cashu/1.0/token", True),
        ("https://archetech.com/didcomm/cashu/1.7/token", True),
        ("https://archetech.com/didcomm/cashu/2.0/token", False),
        ("https://archetech.com/didcomm/cashu/1.0/other", False),
        (None, False),
    ])
    def test_recognizes_token_messages(self, kind, expected):
        assert is_cashu_token_message({"type": kind}) is expected


class TestAccept:
    def test_redeems_credits_and_clears(self, bed):
        bed.send(30, memo="lunch")

        result = bed.accept()

        assert result["failed"] == []
        record = result["redeemed"][0]
        assert (record["sender"], record["amount"], record["mint"], record["memo"]) == (bed.alice, 30, PUBLIC_URL, "lunch")
        assert bed.balance("Bob")["spendable"] == 30
        assert bed.relay.mailbox == []

        run(bed.km.check_cashu(None, "Alice"))
        assert bed.balance("Alice")["outstanding"] == 0

    def test_credits_a_resend_once(self, bed):
        bed.send()
        delivered = bed.relay.mailbox[0]
        bed.accept()

        bed.relay.mailbox.append({**delivered, "id": "resend"})

        assert bed.accept() == {"redeemed": [], "failed": []}
        assert bed.balance("Bob")["spendable"] == 30
        assert bed.relay.mailbox == []

    def test_leaves_a_message_from_a_mint_not_added(self, bed):
        bed.send()
        run(bed.km.remove_cashu_mint(PUBLIC_URL, False, "Bob"))
        bed.mint.requests.clear()

        first = bed.accept()

        assert bed.mint.requests == []
        assert first["redeemed"] == []
        assert first["failed"][0]["mint"] == PUBLIC_URL
        assert first["failed"][0]["acknowledged"] is False
        assert len(bed.relay.mailbox) == 1

        run(bed.km.add_cashu("Bob"))

        assert bed.accept()["redeemed"][0]["amount"] == 30
        assert bed.relay.mailbox == []

    def test_reports_a_spent_token_and_clears_it(self, bed):
        token = bed.send()["token"]
        run(bed.km.receive_cashu(token, "Bob"))

        failed = bed.accept()["failed"][0]

        assert failed["acknowledged"] is True
        assert bed.relay.mailbox == []

    def test_leaves_the_message_when_the_mint_is_unreachable(self, bed):
        bed.send()

        async def unreachable(*_args, **_kwargs):
            raise OSError("connection refused")

        bed.km.cashu.node_fetch = unreachable

        result = bed.accept()

        assert result["redeemed"] == []
        assert result["failed"][0]["acknowledged"] is False
        assert len(bed.relay.mailbox) == 1
        assert bed.balance("Bob")["inFlight"] == 0

    def test_leaves_the_message_when_refused_and_can_try_again(self, bed):
        bed.send()
        bed.mint.refuse_next("/v1/swap", 12345, "temporarily refused")

        first = bed.accept()

        assert "temporarily refused" in first["failed"][0]["reason"]
        assert first["failed"][0]["acknowledged"] is False
        assert len(bed.relay.mailbox) == 1
        assert bed.balance("Bob")["inFlight"] == 0

        assert bed.accept()["redeemed"][0]["amount"] == 30
        assert bed.relay.mailbox == []

    def test_keeps_the_message_through_a_lost_response_and_credits_once(self, bed):
        bed.send()
        bed.mint.lose_response("/v1/swap")

        first = bed.accept()

        assert first["redeemed"] == []
        assert first["failed"][0]["acknowledged"] is False
        assert len(bed.relay.mailbox) == 1

        assert bed.accept() == {"redeemed": [], "failed": []}
        assert bed.balance("Bob")["spendable"] == 30
        assert bed.relay.mailbox == []

    def test_leaves_a_message_it_cannot_read(self, bed):
        run(bed.km.send_didcomm({"type": CASHU_TOKEN_TYPE, "body": {"token": "not a token"}}, "Bob", {"name": "Alice"}))

        result = bed.accept()

        assert result["redeemed"] == []
        assert result["failed"][0]["acknowledged"] is False
        assert len(bed.relay.mailbox) == 1

    def test_redeems_with_a_key_since_rotated_away(self, bed):
        bed.send()
        run(bed.km.set_current_id("Bob"))
        run(bed.km.rotate_keys())

        result = bed.accept()

        assert result["failed"] == []
        assert result["redeemed"][0]["amount"] == 30

    def test_does_not_touch_another_identitys_messages(self, bed):
        bed.send()

        assert bed.accept("Alice") == {"redeemed": [], "failed": []}
        assert len(bed.relay.mailbox) == 1


class TestListMessages:
    def test_describes_a_waiting_token_and_changes_nothing(self, bed):
        bed.send(30, memo="lunch")
        bed.mint.requests.clear()

        messages = run(bed.km.list_cashu_messages("Bob"))

        assert len(messages) == 1
        message = messages[0]
        assert (message["sender"], message["amount"], message["mint"], message["memo"], message["redeemable"]) == (bed.alice, 30, PUBLIC_URL, "lunch", True)
        assert bed.mint.requests == []
        assert len(bed.relay.mailbox) == 1
        assert bed.balance("Bob")["spendable"] == 0

    def test_says_why_a_token_cannot_be_redeemed(self, bed):
        bed.send()
        run(bed.km.remove_cashu_mint(PUBLIC_URL, False, "Bob"))

        message = run(bed.km.list_cashu_messages("Bob"))[0]

        assert message["redeemable"] is False
        assert PUBLIC_URL in message["reason"]

    def test_does_not_list_what_was_redeemed(self, bed):
        bed.send()
        bed.accept()

        assert run(bed.km.list_cashu_messages("Bob")) == []


class TestReclaim:
    def test_refused_while_the_lock_is_in_force(self, bed):
        operation = bed.send()["operationId"]

        with pytest.raises(CashuTokenLockedError):
            run(bed.km.reclaim_cashu(operation, "Alice"))

        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["inFlight"], balance["outstanding"]) == (70, 0, 30)
        assert len(run(bed.km.list_cashu_sends(None, "Alice"))) == 1

    def test_takes_the_value_back_once_the_lock_has_passed(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        bed.after(120)

        assert run(bed.km.reclaim_cashu(operation, "Alice")) == {"amount": 30, "mint": PUBLIC_URL}

        balance = bed.balance("Alice")
        assert (balance["spendable"], balance["inFlight"], balance["outstanding"]) == (100, 0, 0)

    def test_still_works_after_the_sender_rotates(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        run(bed.km.set_current_id("Alice"))
        run(bed.km.rotate_keys())
        bed.after(120)

        assert run(bed.km.reclaim_cashu(operation, "Alice"))["amount"] == 30

    def test_reclaims_a_token_never_delivered(self, bed):
        bed.relay.down = True
        operation = bed.send(locktime=60)["operationId"]
        bed.after(120)

        assert run(bed.km.reclaim_cashu(operation, "Alice"))["amount"] == 30

        bed.relay.down = False
        run(bed.km.check_cashu(None, "Alice"))
        assert bed.relay.mailbox == []

    def test_reports_a_token_already_redeemed(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        bed.accept()
        bed.after(120)

        with pytest.raises(CashuTokenSpentError):
            run(bed.km.reclaim_cashu(operation, "Alice"))
        assert bed.balance("Bob")["spendable"] == 30

    def test_recipient_can_redeem_past_the_locktime(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        bed.after(120)

        assert bed.accept()["redeemed"][0]["amount"] == 30

        with pytest.raises(CashuTokenSpentError):
            run(bed.km.reclaim_cashu(operation, "Alice"))

    def test_recipient_finds_it_spent_if_the_sender_reclaims_first(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        bed.after(120)
        run(bed.km.reclaim_cashu(operation, "Alice"))

        result = bed.accept()

        assert result["redeemed"] == []
        assert result["failed"][0]["acknowledged"] is True
        assert bed.relay.mailbox == []

    def test_a_refused_reclaim_can_be_tried_again(self, bed):
        operation = bed.send(locktime=60)["operationId"]
        bed.after(120)
        bed.mint.refuse_next("/v1/swap", 12345, "temporarily refused")

        with pytest.raises(KeymasterError, match="temporarily refused"):
            run(bed.km.reclaim_cashu(operation, "Alice"))
        assert bed.balance("Alice")["outstanding"] == 30

        assert run(bed.km.reclaim_cashu(operation, "Alice"))["amount"] == 30


def test_receive_cashu_redeems_a_token_locked_to_this_identity(bed):
    token = bed.send()["token"]

    assert run(bed.km.receive_cashu(token, "Bob"))["amount"] == 30
