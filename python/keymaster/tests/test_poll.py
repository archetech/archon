from __future__ import annotations

import copy

import pytest

from keymaster import KeymasterError

from .helpers import make_testbed, run


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