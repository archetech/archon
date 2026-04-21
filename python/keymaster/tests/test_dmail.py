from __future__ import annotations

import pytest

from keymaster import DmailTags, KeymasterError

from .helpers import run


def test_verify_tag_list_and_recipients(testbed, monkeypatch: pytest.MonkeyPatch):
    keymaster = testbed.keymaster
    alice = run(keymaster.create_id("Alice"))
    bob = run(keymaster.create_id("Bob"))
    asset = run(keymaster.create_asset({"mock": True}, {"alias": "Asset"}))

    assert keymaster.verify_tag_list(["tag1", "tag2", "tag2", "tag3"]) == ["tag1", "tag2", "tag3"]

    with pytest.raises(KeymasterError, match="Invalid parameter: tags"):
        keymaster.verify_tag_list(123)  # type: ignore[arg-type]

    with pytest.raises(KeymasterError, match="Invalid parameter: Invalid tag: 'tag 2'"):
        keymaster.verify_tag_list(["tag1", "tag 2"])

    async def fake_check_address(address: str):
        assert address == "atlas@archon.social"
        return {"address": address, "status": "claimed", "available": False, "did": bob}

    monkeypatch.setattr(keymaster, "check_address", fake_check_address)

    verified = run(keymaster.verify_recipient_list([alice, "atlas@archon.social"]))
    assert verified == [alice, bob]
    assert "atlas@archon.social" not in run(keymaster.list_aliases())

    with pytest.raises(KeymasterError, match="Invalid parameter: Invalid recipient type: int"):
        run(keymaster.verify_recipient_list([1]))  # type: ignore[list-item]

    with pytest.raises(KeymasterError, match="Invalid parameter: Invalid recipient: Asset"):
        run(keymaster.verify_recipient_list(["Asset"]))

    assert asset.startswith("did:")


def test_create_list_send_and_import_dmail(testbed):
    keymaster = testbed.keymaster
    alice = run(keymaster.create_id("Alice"))
    bob = run(keymaster.create_id("Bob"))

    message = {
        "to": ["Alice"],
        "cc": ["Bob"],
        "subject": "Test Dmail",
        "body": "Hello from dmail.",
    }

    did = run(keymaster.create_dmail(message))
    attachment = b"This is a mock binary document."
    assert run(keymaster.add_dmail_attachment(did, "doc.txt", attachment)) is True

    dmail = run(keymaster.list_dmail())
    assert dmail[did]["sender"] == "Bob"
    assert dmail[did]["message"] == {"to": [alice], "cc": [bob], "subject": "Test Dmail", "body": "Hello from dmail."}
    assert dmail[did]["to"] == ["Alice"]
    assert dmail[did]["cc"] == ["Bob"]
    assert dmail[did]["tags"] == [DmailTags.DRAFT]
    assert dmail[did]["attachments"]["doc.txt"]["bytes"] == len(attachment)
    assert dmail[did]["attachments"]["doc.txt"]["type"] == "text/plain"

    notice = run(keymaster.send_dmail(did))
    notice_doc = run(keymaster.resolve_did(notice))
    assert notice_doc["didDocumentRegistration"]["registry"] == "hyperswarm"
    assert notice_doc["didDocumentRegistration"]["validUntil"]
    assert notice_doc["didDocumentData"]["notice"] == {"to": [alice, bob], "dids": [did]}
    assert run(keymaster.list_dmail())[did]["tags"] == [DmailTags.SENT]

    assert run(keymaster.set_current_id("Alice")) is True
    assert run(keymaster.import_dmail(did)) is True
    imported = run(keymaster.list_dmail())
    assert imported[did]["tags"] == [DmailTags.INBOX, DmailTags.UNREAD]


def test_list_dmail_preserves_unknown_dids_after_import(testbed):
    keymaster = testbed.keymaster
    alice = run(keymaster.create_id("Alice"))
    bob = run(keymaster.create_id("Bob"))

    did = run(
        keymaster.create_dmail(
            {
                "to": [alice],
                "cc": [bob],
                "subject": "Unknown DID handling",
                "body": "Keep unknown DIDs intact.",
            }
        )
    )

    assert run(keymaster.set_current_id("Alice")) is True
    assert run(keymaster.import_dmail(did)) is True
    assert run(keymaster.remove_id("Bob")) is True

    dmail = run(keymaster.list_dmail())
    assert dmail[did]["sender"] == bob
    assert dmail[did]["to"] == ["Alice"]
    assert dmail[did]["cc"] == [bob]
    assert dmail[did]["tags"] == [DmailTags.INBOX, DmailTags.UNREAD]


def test_dmail_message_and_attachment_helpers(testbed):
    keymaster = testbed.keymaster
    alice = run(keymaster.create_id("Alice"))

    message = {
        "to": [alice],
        "cc": [],
        "subject": "Attachment helper test",
        "body": "Attachments round-trip through vault items.",
    }

    did = run(keymaster.create_dmail(message))
    assert run(keymaster.get_dmail_message(did)) == message

    buffer = b"abc"
    assert run(keymaster.add_dmail_attachment(did, "doc.txt", buffer)) is True
    attachments = run(keymaster.list_dmail_attachments(did))
    assert set(attachments) == {"doc.txt"}
    assert attachments["doc.txt"]["bytes"] == 3
    assert attachments["doc.txt"]["type"] == "text/plain"
    assert run(keymaster.get_dmail_attachment(did, "doc.txt")) == buffer
    assert run(keymaster.remove_dmail_attachment(did, "doc.txt")) is True

    with pytest.raises(KeymasterError, match='Invalid parameter: Cannot add attachment with reserved name "dmail"'):
        run(keymaster.add_dmail_attachment(did, "dmail", buffer))

    with pytest.raises(KeymasterError, match='Invalid parameter: Cannot remove attachment with reserved name "dmail"'):
        run(keymaster.remove_dmail_attachment(did, "dmail"))

    assert run(keymaster.get_dmail_message(alice)) is None
    vault = run(keymaster.create_vault())
    assert run(keymaster.add_vault_item(vault, DmailTags.DMAIL, b"not json")) is True
    assert run(keymaster.get_dmail_message(vault)) is None
    assert run(keymaster.send_dmail(alice)) is None

    assert run(keymaster.remove_dmail(did)) is True
    assert did not in run(keymaster.list_dmail())