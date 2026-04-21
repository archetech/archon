from __future__ import annotations

import pytest

from keymaster import DmailTags, NoticeTags

from .helpers import MOCK_SCHEMA, run


def test_create_and_update_notice(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    asset = run(testbed.keymaster.create_asset({"name": "asset"}))

    notice_did = run(testbed.keymaster.create_notice({"to": [alice], "dids": [asset]}))
    notice_asset = run(testbed.keymaster.resolve_asset(notice_did))
    assert notice_asset["notice"] == {"to": [alice], "dids": [asset]}

    updated = run(testbed.keymaster.update_notice(notice_did, {"to": [alice, bob], "dids": [asset]}))
    assert updated is True

    notice_asset = run(testbed.keymaster.resolve_asset(notice_did))
    assert notice_asset["notice"] == {"to": [alice, bob], "dids": [asset]}


def test_import_notice_accepts_credential_and_tags_wallet(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    schema = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(alice, {"schema": schema}))
    credential = run(testbed.keymaster.issue_credential(bound))
    notice_did = run(testbed.keymaster.create_notice({"to": [alice], "dids": [credential]}))

    assert run(testbed.keymaster.import_notice(notice_did)) is True

    wallet = run(testbed.keymaster.load_wallet())
    notices = wallet["ids"]["Alice"]["notices"]
    assert notices[notice_did]["tags"] == [NoticeTags.CREDENTIAL]
    assert credential in wallet["ids"]["Alice"]["held"]


def test_import_notice_handles_dmail_poll_and_ballot_flows(testbed):
    keymaster = testbed.keymaster
    alice = run(keymaster.create_id("Alice"))
    bob = run(keymaster.create_id("Bob"))

    dmail_did = run(
        keymaster.create_dmail(
            {
                "to": [alice],
                "cc": [bob],
                "subject": "Test Dmail",
                "body": "This is a test dmail.",
            }
        )
    )
    dmail_notice = run(keymaster.create_notice({"to": [alice], "dids": [dmail_did]}))

    assert run(keymaster.set_current_id("Alice")) is True
    assert run(keymaster.import_notice(dmail_notice)) is True

    wallet = run(keymaster.load_wallet())
    assert wallet["ids"]["Alice"]["notices"][dmail_notice]["tags"] == [NoticeTags.DMAIL]
    assert wallet["ids"]["Alice"]["dmail"][dmail_did]["tags"] == [DmailTags.INBOX, DmailTags.UNREAD]

    assert run(keymaster.set_current_id("Bob")) is True
    poll_id = run(keymaster.create_poll(run(keymaster.poll_template())))
    assert run(keymaster.add_poll_voter(poll_id, alice)) is True
    poll_notice = run(keymaster.create_notice({"to": [alice], "dids": [poll_id]}))

    assert run(keymaster.set_current_id("Alice")) is True
    assert run(keymaster.import_notice(poll_notice)) is True

    wallet = run(keymaster.load_wallet())
    assert wallet["ids"]["Alice"]["notices"][poll_notice]["tags"] == [NoticeTags.POLL]

    ballot_did = run(keymaster.vote_poll(poll_id, 1))
    ballot_notice = run(keymaster.create_notice({"to": [bob], "dids": [ballot_did]}))

    assert run(keymaster.set_current_id("Bob")) is True
    assert run(keymaster.import_notice(ballot_notice)) is True

    wallet = run(keymaster.load_wallet())
    assert wallet["ids"]["Bob"]["notices"][ballot_notice]["tags"] == [NoticeTags.BALLOT]
    poll_items = run(keymaster.list_vault_items(poll_id))
    assert any(name not in {"poll", "results"} for name in poll_items)


def test_search_refresh_and_cleanup_notices(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    schema = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(alice, {"schema": schema}))
    credential = run(testbed.keymaster.issue_credential(bound))
    notice_did = run(testbed.keymaster.create_notice({"to": [alice], "dids": [credential]}))

    assert run(testbed.keymaster.search_notices()) is True

    wallet = run(testbed.keymaster.load_wallet())
    assert notice_did in wallet["ids"]["Alice"]["notices"]

    del testbed.gatekeeper.docs[notice_did]

    assert run(testbed.keymaster.refresh_notices()) is True

    wallet = run(testbed.keymaster.load_wallet())
    assert notice_did not in wallet["ids"]["Alice"].get("notices", {})


def test_search_notices_wraps_gatekeeper_failures(testbed, monkeypatch: pytest.MonkeyPatch):
    run(testbed.keymaster.create_id("Alice"))

    async def fail_search(query):
        _ = query
        raise RuntimeError("search failed")

    monkeypatch.setattr(testbed.gatekeeper, "search", fail_search)

    with pytest.raises(Exception, match="Failed to search for notices"):
        run(testbed.keymaster.search_notices())