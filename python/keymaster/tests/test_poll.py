from __future__ import annotations

import copy
from dataclasses import dataclass
import json

import pytest

from keymaster import Keymaster, KeymasterError

from .helpers import FakeGatekeeper, FakeWalletStore, make_testbed, run


@dataclass
class PollClients:
    owner: Keymaster
    voter: Keymaster
    outsider: Keymaster


def make_poll_clients() -> PollClients:
    gatekeeper = FakeGatekeeper()
    return PollClients(
        owner=Keymaster(gatekeeper=gatekeeper, wallet_store=FakeWalletStore(), passphrase="owner-passphrase"),
        voter=Keymaster(gatekeeper=gatekeeper, wallet_store=FakeWalletStore(), passphrase="voter-passphrase"),
        outsider=Keymaster(gatekeeper=gatekeeper, wallet_store=FakeWalletStore(), passphrase="outsider-passphrase"),
    )


def test_poll_template_shape():
    testbed = make_testbed()
    template = run(testbed.keymaster.poll_template())

    assert template["version"] == 2
    assert template["name"] == "poll-name"
    assert template["description"] == "What is this poll about?"
    assert template["options"] == ["yes", "no", "abstain"]
    assert template["deadline"]


def test_create_get_test_and_list_polls():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    template = run(keymaster.poll_template())

    poll_1 = run(keymaster.create_poll(template))
    poll_2 = run(keymaster.create_poll(template))
    schema = run(keymaster.create_schema())

    assert run(keymaster.get_poll(poll_1)) == template
    assert run(keymaster.test_poll(poll_1)) is True
    assert run(keymaster.test_poll(schema)) is False
    assert run(keymaster.get_poll(schema)) is None

    polls = run(keymaster.list_polls())
    assert poll_1 in polls
    assert poll_2 in polls
    assert schema not in polls


@pytest.mark.parametrize(
    ("mutator", "message"),
    [
        (lambda poll: poll.update({"version": 0}), "Invalid parameter: poll.version"),
        (lambda poll: poll.pop("name"), "Invalid parameter: poll.name"),
        (lambda poll: poll.pop("description"), "Invalid parameter: poll.description"),
        (lambda poll: poll.pop("options"), "Invalid parameter: poll.options"),
        (lambda poll: poll.update({"options": ["one option"]}), "Invalid parameter: poll.options"),
        (lambda poll: poll.update({"options": list(range(12))}), "Invalid parameter: poll.options"),
        (lambda poll: poll.update({"options": "not a list"}), "Invalid parameter: poll.options"),
        (lambda poll: poll.pop("deadline"), "Invalid parameter: poll.deadline"),
        (lambda poll: poll.update({"deadline": "not a date"}), "Invalid parameter: poll.deadline"),
        (lambda poll: poll.update({"deadline": "2000-01-01T00:00:00Z"}), "Invalid parameter: poll.deadline"),
    ],
)
def test_create_poll_rejects_invalid_templates(mutator, message):
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    template = run(keymaster.poll_template())
    broken = copy.deepcopy(template)
    mutator(broken)

    with pytest.raises(KeymasterError, match=message):
        run(keymaster.create_poll(broken))


def test_poll_voter_management_uses_vault_membership():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    alice = run(keymaster.create_id("Alice"))
    run(keymaster.set_current_id("Bob"))
    template = run(keymaster.poll_template())
    poll_id = run(keymaster.create_poll(template))

    assert run(keymaster.add_poll_voter(poll_id, alice)) is True
    voters = run(keymaster.list_poll_voters(poll_id))
    assert alice in voters

    assert run(keymaster.remove_poll_voter(poll_id, alice)) is True
    assert run(keymaster.list_poll_voters(poll_id)) == {}


def test_poll_voter_management_rejects_non_poll_ids():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    bob = run(keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(keymaster.add_poll_voter(bob, bob))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(keymaster.remove_poll_voter(bob, bob))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(keymaster.list_poll_voters(bob))


def test_view_poll_for_owner_and_eligible_voter():
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    owner_view = run(clients.owner.view_poll(poll_id))
    assert owner_view["deadline"] == template["deadline"]
    assert owner_view["description"] == template["description"]
    assert owner_view["options"] == template["options"]
    assert owner_view["hasVoted"] is False
    assert owner_view["isEligible"] is True
    assert owner_view["isOwner"] is True
    assert owner_view["voteExpired"] is False
    assert owner_view["results"]["ballots"] == []
    assert owner_view["results"]["votes"] == {"eligible": 2, "received": 0, "pending": 2}
    assert owner_view["results"]["final"] is False

    owner_ballot = run(clients.owner.vote_poll(poll_id, 1))
    voter_ballot = run(clients.voter.vote_poll(poll_id, 2))
    run(clients.owner.update_poll(owner_ballot))
    run(clients.owner.update_poll(voter_ballot))
    run(clients.owner.publish_poll(poll_id))

    voter_view = run(clients.voter.view_poll(poll_id))
    assert voter_view["isEligible"] is True
    assert voter_view["isOwner"] is False
    assert voter_view["hasVoted"] is True
    assert voter_view["results"]["final"] is True
    assert voter_view["results"]["votes"]["received"] == 2
    assert voter_view["results"]["tally"][1]["count"] == 1
    assert voter_view["results"]["tally"][2]["count"] == 1


def test_view_poll_rejects_non_voter_and_handles_membership_lookup_failure(monkeypatch: pytest.MonkeyPatch):
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    run(clients.outsider.create_id("Mallory"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(clients.outsider.view_poll(poll_id))

    async def fail_list_members(identifier: str):
        _ = identifier
        raise RuntimeError("boom")

    monkeypatch.setattr(clients.voter, "list_vault_members", fail_list_members)
    degraded = run(clients.voter.view_poll(poll_id))
    assert degraded["isEligible"] is False
    assert degraded["hasVoted"] is False


def test_vote_poll_supports_owner_voter_and_spoiled_ballots():
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    owner_ballot = run(clients.owner.vote_poll(poll_id, 1))
    assert run(clients.owner.decrypt_json(owner_ballot)) == {"poll": poll_id, "vote": 1}

    voter_ballot = run(clients.voter.vote_poll(poll_id, 2))
    assert voter_ballot

    spoiled = run(clients.owner.vote_poll(poll_id, 0))
    assert run(clients.owner.decrypt_json(spoiled)) == {"poll": poll_id, "vote": 0}


def test_vote_poll_rejects_invalid_owner_expired_ineligible_and_unknown_poll(monkeypatch: pytest.MonkeyPatch):
    clients = make_poll_clients()

    bob = run(clients.owner.create_id("Bob"))
    run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))

    with pytest.raises(KeymasterError, match="Invalid parameter: vote"):
        run(clients.owner.vote_poll(poll_id, 99))

    expired = {**template, "deadline": "2000-01-01T00:00:00Z"}
    run(clients.owner.add_vault_item(poll_id, "poll", json_bytes(expired)))
    with pytest.raises(KeymasterError, match="Invalid parameter: poll has expired"):
        run(clients.owner.vote_poll(poll_id, 1))

    run(clients.owner.add_vault_item(poll_id, "poll", json_bytes(template)))
    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(clients.voter.vote_poll(poll_id, 1))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(clients.owner.vote_poll(bob, 1))

    resolve_did = clients.owner.resolve_did

    async def missing_owner(identifier: str, options=None):
        doc = await resolve_did(identifier, options)
        if identifier == poll_id:
            doc = copy.deepcopy(doc)
            doc["didDocument"]["controller"] = None
        return doc

    monkeypatch.setattr(clients.owner, "resolve_did", missing_owner)
    with pytest.raises(KeymasterError, match="Keymaster: owner missing from poll"):
        run(clients.owner.vote_poll(poll_id, 1))


def test_send_poll_and_send_ballot_create_notices_and_validate_inputs(monkeypatch: pytest.MonkeyPatch):
    clients = make_poll_clients()

    bob = run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    notice_id = run(clients.owner.send_poll(poll_id))
    assert run(clients.owner.resolve_asset(notice_id))["notice"] == {"to": [alice], "dids": [poll_id]}

    ballot_id = run(clients.voter.vote_poll(poll_id, 1))
    ballot_notice = run(clients.voter.send_ballot(ballot_id, poll_id))
    assert run(clients.voter.resolve_asset(ballot_notice))["notice"] == {"to": [bob], "dids": [ballot_id]}

    empty_poll = run(clients.owner.create_poll(template))
    with pytest.raises(KeymasterError, match="Keymaster: No poll voters found"):
        run(clients.owner.send_poll(empty_poll))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId"):
        run(clients.owner.send_poll(bob))

    with pytest.raises(KeymasterError, match="Invalid parameter: pollId is not a valid poll"):
        run(clients.owner.send_ballot("did:test:fake", bob))

    resolve_did = clients.voter.resolve_did

    async def missing_owner(identifier: str, options=None):
        doc = await resolve_did(identifier, options)
        if identifier == poll_id:
            doc = copy.deepcopy(doc)
            doc["didDocument"]["controller"] = None
        return doc

    monkeypatch.setattr(clients.voter, "resolve_did", missing_owner)
    with pytest.raises(KeymasterError, match="Keymaster: poll owner not found"):
        run(clients.voter.send_ballot(ballot_id, poll_id))


def test_view_ballot_exposes_owner_and_voter_views():
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    run(clients.outsider.create_id("Mallory"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    ballot_id = run(clients.voter.vote_poll(poll_id, 2))
    owner_view = run(clients.owner.view_ballot(ballot_id))
    assert owner_view == {"poll": poll_id, "voter": alice, "vote": 2, "option": "no"}

    voter_view = run(clients.voter.view_ballot(ballot_id))
    assert voter_view == {"poll": poll_id, "voter": alice, "vote": 2, "option": "no"}

    outsider_view = run(clients.outsider.view_ballot(ballot_id))
    assert outsider_view == {"poll": "", "voter": alice}

    spoiled = run(clients.owner.vote_poll(poll_id, 0))
    assert run(clients.owner.view_ballot(spoiled))["option"] == "spoil"


def test_update_poll_validates_ballots_membership_and_deadlines():
    clients = make_poll_clients()

    bob = run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    mallory = run(clients.outsider.create_id("Mallory"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))
    run(clients.owner.add_poll_voter(poll_id, mallory))

    owner_ballot = run(clients.owner.vote_poll(poll_id, 1))
    assert run(clients.owner.update_poll(owner_ballot)) is True

    voter_ballot = run(clients.voter.vote_poll(poll_id, 2))
    assert run(clients.owner.update_poll(voter_ballot)) is True

    with pytest.raises(KeymasterError, match="Invalid parameter: ballot"):
        run(clients.owner.update_poll(poll_id))

    invalid_ballot = run(clients.owner.encrypt_json({"key": "value"}, bob))
    with pytest.raises(KeymasterError, match="Invalid parameter: ballot"):
        run(clients.owner.update_poll(invalid_ballot))

    wrong_poll = run(clients.owner.encrypt_json({"poll": bob, "vote": 1}, bob))
    with pytest.raises(KeymasterError, match="Cannot find poll related to ballot"):
        run(clients.owner.update_poll(wrong_poll))

    with pytest.raises(KeymasterError, match="Invalid parameter: only owner can update a poll"):
        run(clients.voter.update_poll(voter_ballot))

    outsider_ballot = run(clients.outsider.vote_poll(poll_id, 1))
    run(clients.owner.remove_poll_voter(poll_id, mallory))
    with pytest.raises(KeymasterError, match="Invalid parameter: voter is not a poll member"):
        run(clients.owner.update_poll(outsider_ballot))

    fresh_ballot = run(clients.owner.encrypt_json({"poll": poll_id, "vote": 0}, bob))
    expired = {**template, "deadline": "2000-01-01T00:00:00Z"}
    run(clients.owner.add_vault_item(poll_id, "poll", json_bytes(expired)))
    with pytest.raises(KeymasterError, match="Invalid parameter: poll has expired"):
        run(clients.owner.update_poll(fresh_ballot))

    run(clients.owner.add_vault_item(poll_id, "poll", json_bytes(template)))
    bad_vote = run(clients.owner.encrypt_json({"poll": poll_id, "vote": 99}, bob))
    with pytest.raises(KeymasterError, match="Invalid parameter: ballot.vote"):
        run(clients.owner.update_poll(bad_vote))


def test_publish_and_unpublish_poll_results(monkeypatch: pytest.MonkeyPatch):
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    bob_ballot = run(clients.owner.vote_poll(poll_id, 1))
    alice_ballot = run(clients.voter.vote_poll(poll_id, 2))
    run(clients.owner.update_poll(bob_ballot))
    run(clients.owner.update_poll(alice_ballot))

    assert run(clients.owner.publish_poll(poll_id)) is True
    view = run(clients.owner.view_poll(poll_id))
    assert view["results"]["final"] is True
    assert view["results"]["votes"] == {"eligible": 2, "received": 2, "pending": 0}
    assert view["results"]["tally"][0] == {"vote": 0, "option": "spoil", "count": 0}
    assert view["results"]["tally"][1] == {"vote": 1, "option": "yes", "count": 1}
    assert view["results"]["tally"][2] == {"vote": 2, "option": "no", "count": 1}
    assert view["results"]["tally"][3] == {"vote": 3, "option": "abstain", "count": 0}

    reveal_poll = run(clients.owner.create_poll(template))
    reveal_ballot = run(clients.owner.vote_poll(reveal_poll, 1))
    run(clients.owner.update_poll(reveal_ballot))
    assert run(clients.owner.publish_poll(reveal_poll, {"reveal": True})) is True
    revealed = run(clients.owner.view_poll(reveal_poll))
    assert revealed["results"]["ballots"][0]["vote"] == 1

    pending_poll = run(clients.owner.create_poll(template))
    with pytest.raises(KeymasterError, match="Invalid parameter: poll not final"):
        run(clients.owner.publish_poll(pending_poll))

    with pytest.raises(KeymasterError, match="Invalid parameter: only owner can publish a poll"):
        run(clients.voter.publish_poll(poll_id))

    get_poll = clients.owner.get_poll

    async def missing_poll(identifier: str):
        if identifier == poll_id:
            return None
        return await get_poll(identifier)

    monkeypatch.setattr(clients.owner, "get_poll", missing_poll)
    with pytest.raises(KeymasterError, match=f"Invalid parameter: {poll_id}"):
        run(clients.owner.publish_poll(poll_id))


def test_unpublish_poll_validates_owner_and_missing_config(monkeypatch: pytest.MonkeyPatch):
    clients = make_poll_clients()

    run(clients.owner.create_id("Bob"))
    alice = run(clients.voter.create_id("Alice"))
    template = run(clients.owner.poll_template())
    poll_id = run(clients.owner.create_poll(template))
    run(clients.owner.add_poll_voter(poll_id, alice))

    owner_ballot = run(clients.owner.vote_poll(poll_id, 1))
    voter_ballot = run(clients.voter.vote_poll(poll_id, 2))
    run(clients.owner.update_poll(owner_ballot))
    run(clients.owner.update_poll(voter_ballot))
    run(clients.owner.publish_poll(poll_id))

    assert run(clients.owner.unpublish_poll(poll_id)) is True
    assert "results" not in run(clients.owner.list_vault_items(poll_id))

    run(clients.owner.publish_poll(poll_id))
    with pytest.raises(KeymasterError, match=f"Invalid parameter: {poll_id}"):
        run(clients.voter.unpublish_poll(poll_id))

    get_poll = clients.owner.get_poll

    async def missing_poll(identifier: str):
        if identifier == poll_id:
            return None
        return await get_poll(identifier)

    monkeypatch.setattr(clients.owner, "get_poll", missing_poll)
    with pytest.raises(KeymasterError, match=f"Invalid parameter: {poll_id}"):
        run(clients.owner.unpublish_poll(poll_id))


def json_bytes(value: dict[str, object]) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")