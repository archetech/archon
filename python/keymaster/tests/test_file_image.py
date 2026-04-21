from __future__ import annotations

import base64
import hashlib
import json

import pytest

from keymaster import KeymasterError

from .helpers import make_testbed, run


PNG_1X1 = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII="
)
PNG_2X1 = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAD4c0wSAAAADUlEQVR4nGNgYGBgAAAABQABVqg3tQAAAABJRU5ErkJggg=="
)


def test_get_mime_type_detects_text_json_and_binary():
    testbed = make_testbed()

    assert testbed.keymaster.get_mime_type(b"plain text") == "text/plain"
    assert testbed.keymaster.get_mime_type(json.dumps({"ok": True}).encode("utf-8")) == "application/json"
    assert testbed.keymaster.get_mime_type(b"\x00\xff\xab\xcd") == "application/octet-stream"
    assert testbed.keymaster.get_mime_type(PNG_1X1) == "image/png"


def test_create_get_update_and_test_file_assets():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))

    text_data = b"This is a mock text document."
    did = run(keymaster.create_file(text_data, {"filename": "mockFile.txt"}))
    doc = run(keymaster.resolve_did(did))
    file_asset = run(keymaster.get_file(did))

    assert doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(text_data).hexdigest(),
            "filename": "mockFile.txt",
            "bytes": len(text_data),
            "type": "text/plain",
        }
    }
    assert file_asset == {
        "cid": hashlib.sha256(text_data).hexdigest(),
        "filename": "mockFile.txt",
        "bytes": len(text_data),
        "type": "text/plain",
        "data": text_data,
    }
    assert run(keymaster.test_file(did)) is True

    aliased = run(keymaster.create_file(b"seed", {"alias": "mockFile"}))
    assert aliased.startswith("did:")
    updated_data = b"This is the second version."
    assert run(keymaster.update_file("mockFile", updated_data, {"filename": "file"})) is True
    updated_doc = run(keymaster.resolve_did("mockFile"))
    assert updated_doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(updated_data).hexdigest(),
            "filename": "file",
            "bytes": len(updated_data),
            "type": "text/plain",
        }
    }
    assert updated_doc["didDocumentMetadata"]["versionSequence"] == 2


def test_create_and_update_file_stream_assets():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))

    streamed = b"This is streamed text data."
    did = run(
        keymaster.create_file_stream(
            streamed,
            {"filename": "streamed.txt", "contentType": "text/plain", "bytes": len(streamed)},
        )
    )
    doc = run(keymaster.resolve_did(did))
    assert doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(streamed).hexdigest(),
            "filename": "streamed.txt",
            "bytes": len(streamed),
            "type": "text/plain",
        }
    }

    default_stream = b"default options test"
    default_did = run(keymaster.create_file_stream(default_stream, {"bytes": len(default_stream)}))
    default_doc = run(keymaster.resolve_did(default_did))
    assert default_doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(default_stream).hexdigest(),
            "filename": "file",
            "bytes": len(default_stream),
            "type": "application/octet-stream",
        }
    }

    run(keymaster.create_file(b"v1", {"alias": "streamFile", "filename": "stream.txt"}))
    updated = b"Stream version two."
    assert run(
        keymaster.update_file_stream(
            "streamFile",
            updated,
            {"filename": "stream.txt", "contentType": "text/plain", "bytes": len(updated)},
        )
    ) is True
    updated_doc = run(keymaster.resolve_did("streamFile"))
    assert updated_doc["didDocumentData"]["file"] == {
        "cid": hashlib.sha256(updated).hexdigest(),
        "filename": "stream.txt",
        "bytes": len(updated),
        "type": "text/plain",
    }
    assert updated_doc["didDocumentMetadata"]["versionSequence"] == 2


def test_file_helpers_handle_missing_and_invalid_assets():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    asset_did = run(keymaster.create_asset({"name": "mockAnchor"}))

    assert run(keymaster.get_file(asset_did)) is None
    assert run(keymaster.test_file(asset_did)) is False
    assert run(keymaster.test_file("bogus")) is False

    with pytest.raises(KeymasterError, match="Unknown ID"):
        run(keymaster.get_file("bogus"))


def test_create_get_update_and_test_image_assets():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))

    did = run(keymaster.create_image(PNG_1X1))
    doc = run(keymaster.resolve_did(did))
    image_asset = run(keymaster.get_image(did))

    assert doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(PNG_1X1).hexdigest(),
            "filename": "image",
            "bytes": len(PNG_1X1),
            "type": "image/png",
        },
        "image": {
            "width": 1,
            "height": 1,
        },
    }
    assert image_asset == {
        "file": {
            "cid": hashlib.sha256(PNG_1X1).hexdigest(),
            "filename": "image",
            "bytes": len(PNG_1X1),
            "type": "image/png",
            "data": PNG_1X1,
        },
        "image": {
            "width": 1,
            "height": 1,
        },
    }
    assert run(keymaster.test_image(did)) is True

    assert run(keymaster.create_image(PNG_1X1, {"alias": "mockImage"})).startswith("did:")
    assert run(keymaster.test_image("mockImage")) is True
    assert run(keymaster.update_image(did, PNG_2X1)) is True
    updated_doc = run(keymaster.resolve_did(did))
    assert updated_doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(PNG_2X1).hexdigest(),
            "filename": "image",
            "bytes": len(PNG_2X1),
            "type": "image/png",
        },
        "image": {
            "width": 2,
            "height": 1,
        },
    }
    assert updated_doc["didDocumentMetadata"]["versionSequence"] == 2

    empty_asset = run(keymaster.create_asset({}))
    assert run(keymaster.update_image(empty_asset, PNG_1X1)) is True
    empty_asset_doc = run(keymaster.resolve_did(empty_asset))
    assert empty_asset_doc["didDocumentData"] == {
        "file": {
            "cid": hashlib.sha256(PNG_1X1).hexdigest(),
            "filename": "image",
            "bytes": len(PNG_1X1),
            "type": "image/png",
        },
        "image": {
            "width": 1,
            "height": 1,
        },
    }
    assert empty_asset_doc["didDocumentMetadata"]["versionSequence"] == 2


def test_image_helpers_handle_invalid_buffers_and_non_image_assets():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    did = run(keymaster.create_asset({"name": "mockAnchor"}))

    assert run(keymaster.get_image(did)) is None
    assert run(keymaster.test_image(did)) is False
    assert run(keymaster.test_image("bogus")) is False

    with pytest.raises(KeymasterError, match="Invalid parameter: buffer"):
        run(keymaster.create_image(b"mock"))

    created = run(keymaster.create_image(PNG_1X1))
    with pytest.raises(KeymasterError, match="Invalid parameter: buffer"):
        run(keymaster.update_image(created, b"mock"))

    with pytest.raises(KeymasterError, match="Unknown ID"):
        run(keymaster.get_image("bogus"))