"""Grants from a Keymaster: docs/plans/memeplex-reference-1436.md, "Grant
request flow" and "Wallet".

tests/keymaster/grant.test.ts is this file for the TypeScript port. Both ports
run the fixtures read here, which is what holds their link decoding and grant
validation to one answer, and both state every refusal in the same words.
"""

from __future__ import annotations

import base64
from copy import deepcopy
import json
from pathlib import Path

import pytest

from keymaster import KeymasterError, UnknownIDError
from keymaster import grant as grants

from .helpers import run

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
LINK_CASES = json.loads((FIXTURES / "memeplex-grant-link-vectors.json").read_text(encoding="utf-8"))["cases"]
VALIDITY_CASES = [
    case
    for case in json.loads((FIXTURES / "memeplex-v1-vectors.json").read_text(encoding="utf-8"))["cases"]
    if case["member"] != "memeplex"
]

BTC = "BTC:mainnet"
ETH = "ETH:mainnet"
NONCE = "Qm9vdHN0cmFwIG5vbmNlMTIz"
EXTENSION = f"did:cid:bagaaieraschemaschemaschemaschemaschemaschemaschemaschemasch?versionId=b{'a' * 58}"
OTHER_EXTENSION = f"did:cid:bagaaieraotherotherotherotherotherotherotherotherotherotherot?versionId=b{'c' * 58}"
BLOCK = {"height": 100, "timeISO": "2026-11-02T01:40:00.000Z"}
CORE = ["memeplex:post", "memeplex:reply", "memeplex:rate", "memeplex:tag"]
PERMITTED = "BTC:mainnet, ZEC:mainnet, ETH:mainnet, SOL:mainnet-beta"


def named(cases):
    return [pytest.param(case, id=case["name"]) for case in cases]


# The rules Keymaster states -------------------------------------------------


def test_the_constants_are_those_of_the_typescript_port():
    assert list(grants.PERMITTED_GRANT_REGISTRIES) == ["BTC:mainnet", "ZEC:mainnet", "ETH:mainnet", "SOL:mainnet-beta"]
    assert list(grants.CORE_GRANT_ACTIONS) == CORE
    assert grants.GRANT_LINK_PREFIX == "archon://grant?request="
    assert grants.MAX_GRANT_LINK_LENGTH == 2048


def test_there_are_vectors_for_grants_and_for_grant_requests():
    assert len([case for case in VALIDITY_CASES if case["member"] == "memeplexGrant"]) > 20
    assert len([case for case in VALIDITY_CASES if case["member"] == "memeplexGrantRequest"]) > 5
    assert sorted({case["expect"] for case in VALIDITY_CASES}) == [
        "expiry-instant", "schema", "unsupported", "valid", "version",
    ]


def expected(case):
    """What Keymaster makes of a vector. A request needs ``registries``, so one
    without them that would otherwise reach the schema fails it."""
    unlisted = case["member"] == "memeplexGrantRequest" and "registries" not in case["request"]
    return "schema" if unlisted and case["expect"] in ("valid", "expiry-instant") else case["expect"]


@pytest.mark.parametrize("case", named(VALIDITY_CASES))
def test_a_grant_or_a_request_is_judged_as_its_vector_states(case):
    if case["member"] == "memeplexGrant":
        assert grants.validate_grant(case["operation"]["data"]["memeplexGrant"]) == case["expect"]
    else:
        assert grants.validate_grant_request(case["request"]) == expected(case)


@pytest.mark.parametrize("case", named(LINK_CASES))
def test_a_link_is_decoded_as_its_vector_states(case):
    assert grants.decode_grant_link(case["link"]) == case["expect"]


def test_every_refusal_of_a_link_is_shown():
    assert sorted({case["expect"].get("error", "accepted") for case in LINK_CASES}) == [
        "accepted", "invalid-request", "not-a-grant-link", "too-long", "undecodable",
    ]


def test_a_link_that_is_not_a_string_is_refused():
    assert grants.decode_grant_link(5) == {"error": "not-a-grant-link"}
    assert grants.decode_grant_link(None) == {"error": "not-a-grant-link"}


def test_the_white_space_trimmed_is_what_javascript_trims():
    # Python's own strip also removes the separators U+001C to U+001F, and
    # keeps the byte order mark.
    assert "\x1c link﻿ ".strip(grants.JS_WHITESPACE) == "\x1c link"


# Against a Gatekeeper --------------------------------------------------------


@pytest.fixture
def node(testbed):
    testbed.gatekeeper.registries = ["local", "hyperswarm", BTC, ETH]
    testbed.client = run(testbed.keymaster.create_id("Memepool", {"registry": "hyperswarm"}))
    testbed.alice = run(testbed.keymaster.create_id("Alice", {"registry": "hyperswarm"}))
    return testbed


def link_of(text: str) -> str:
    return grants.GRANT_LINK_PREFIX + base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def link_for(node, **request) -> str:
    """A link for a request that lists every permitted registry, unless it says otherwise."""
    carried = {
        "v": 1,
        "client": node.client,
        "name": "Memepool",
        "nonce": NONCE,
        "registries": list(grants.PERMITTED_GRANT_REGISTRIES),
        **request,
    }
    return link_of(json.dumps({"memeplexGrantRequest": carried}))


def grant_of(node, did):
    return run(node.keymaster.resolve_did(did))["didDocumentData"]["memeplexGrant"]


def sequence_of(node, did):
    return run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["versionSequence"]


def anchor(node, did, registry=BTC):
    node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"] = {"chain": registry, "upperBound": dict(BLOCK)}


def refuses(message: str):
    return pytest.raises(KeymasterError, match=f"^Invalid parameter: {message}")


# create_grant


def test_create_grant_creates_the_grant_a_link_asks_for_on_the_first_permitted_registry(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    doc = run(node.keymaster.resolve_did(did))

    assert doc["didDocumentData"] == {"memeplexGrant": {"v": 1, "client": node.client, "nonce": NONCE}}
    assert doc["didDocumentRegistration"]["type"] == "asset"
    assert doc["didDocumentRegistration"]["registry"] == BTC
    assert doc["didDocument"]["controller"] == node.alice
    assert run(node.keymaster.list_assets()) == [did]


def test_create_grant_grants_the_actions_and_the_expiry_the_link_asks_for(node):
    actions = ["memeplex:tag", "memeplex:post", EXTENSION]
    did = run(node.keymaster.create_grant(link_for(node, actions=actions, expiresAt="2028-02-29T23:59:59.5Z")))

    assert grant_of(node, did) == {
        "v": 1, "client": node.client, "actions": actions, "nonce": NONCE, "expiresAt": "2028-02-29T23:59:59.5Z",
    }
    assert list(grant_of(node, did)) == ["v", "client", "actions", "nonce", "expiresAt"]


def test_create_grant_accepts_a_link_with_white_space_around_it(node):
    did = run(node.keymaster.create_grant(f"  {link_for(node)}\n"))

    assert grant_of(node, did) == {"v": 1, "client": node.client, "nonce": NONCE}


def test_create_grant_narrows_the_actions_in_the_order_they_were_asked_for(node):
    link = link_for(node, actions=["memeplex:tag", "memeplex:post", EXTENSION])

    did = run(node.keymaster.create_grant(link, {"actions": [EXTENSION, "memeplex:tag"]}))
    assert grant_of(node, did)["actions"] == ["memeplex:tag", EXTENSION]
    did = run(node.keymaster.create_grant(link, {"actions": ["memeplex:post", "memeplex:post"]}))
    assert grant_of(node, did)["actions"] == ["memeplex:post"]
    did = run(node.keymaster.create_grant(link_for(node), {"actions": ["memeplex:rate", "memeplex:reply"]}))
    assert grant_of(node, did)["actions"] == ["memeplex:reply", "memeplex:rate"]


def test_create_grant_leaves_actions_out_for_exactly_the_core_actions(node):
    core = ["memeplex:tag", "memeplex:rate", "memeplex:reply", "memeplex:post"]
    plain = {"v": 1, "client": node.client, "nonce": NONCE}

    assert grant_of(node, run(node.keymaster.create_grant(link_for(node, actions=core)))) == plain
    assert grant_of(node, run(node.keymaster.create_grant(link_for(node), {"actions": core}))) == plain
    did = run(node.keymaster.create_grant(link_for(node, actions=[*core, EXTENSION])))
    assert grant_of(node, did)["actions"] == [*core, EXTENSION]


@pytest.mark.parametrize(
    ("asked", "actions", "message"),
    [
        pytest.param({"actions": ["memeplex:tag"]}, ["memeplex:post"], "every action must be one of memeplex:tag$", id="an action the link does not ask for"),
        pytest.param({}, [EXTENSION], f"every action must be one of {', '.join(CORE)}$", id="an extension kind when the link lists no actions"),
        pytest.param({}, [], "at least one action is needed$", id="no actions"),
        pytest.param({}, "memeplex:post", "at least one action is needed$", id="actions that are not a list"),
        pytest.param({}, [1], "every action must be one of", id="an action that is not a string"),
    ],
)
def test_create_grant_refuses_a_scope_the_link_does_not_ask_for(node, asked, actions, message):
    with refuses(f"options.actions: {message}"):
        run(node.keymaster.create_grant(link_for(node, **asked), {"actions": actions}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_changes_or_removes_the_expiry(node):
    link = link_for(node, expiresAt="2027-01-01T00:00:00Z")
    plain = {"v": 1, "client": node.client, "nonce": NONCE}

    did = run(node.keymaster.create_grant(link, {"expiresAt": "2027-06-30T12:00:00.000Z"}))
    assert grant_of(node, did) == {**plain, "expiresAt": "2027-06-30T12:00:00.000Z"}
    assert grant_of(node, run(node.keymaster.create_grant(link, {"expiresAt": None}))) == plain
    did = run(node.keymaster.create_grant(link_for(node), {"expiresAt": "2027-06-30T12:00:00Z"}))
    assert grant_of(node, did)["expiresAt"] == "2027-06-30T12:00:00Z"


@pytest.mark.parametrize(
    "expires_at",
    ["2027-02-30T00:00:00Z", "2027-06-30", "2027-06-30T12:00:00+00:00", "2027-06-30T12:00:00Z\n", "", 1798675200],
)
def test_create_grant_refuses_an_expiry_that_is_not_an_instant(node, expires_at):
    with refuses("options.expiresAt: not an instant such as 2027-01-31T00:00:00Z$"):
        run(node.keymaster.create_grant(link_for(node), {"expiresAt": expires_at}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_creates_the_grant_on_the_registry_asked_for(node):
    did = run(node.keymaster.create_grant(link_for(node), {"registry": ETH}))

    assert run(node.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == ETH


@pytest.mark.parametrize("registry", ["hyperswarm", "local", "BTC:signet", "pin"])
def test_create_grant_refuses_a_registry_where_a_grant_would_be_void(node, registry):
    with refuses(f"options.registry: a grant may be created on {PERMITTED}$"):
        run(node.keymaster.create_grant(link_for(node), {"registry": registry}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_refuses_a_permitted_registry_the_node_does_not_support(node):
    with refuses("options.registry: this node does not support ZEC:mainnet$"):
        run(node.keymaster.create_grant(link_for(node), {"registry": "ZEC:mainnet"}))


def test_create_grant_refuses_when_the_node_supports_no_permitted_registry(node):
    node.gatekeeper.registries = ["local", "hyperswarm", "BTC:signet"]

    with refuses(f"options.registry: the request lists {PERMITTED} and this node supports local, hyperswarm, BTC:signet$"):
        run(node.keymaster.create_grant(link_for(node)))


def test_create_grant_refuses_a_request_that_lists_no_registries(node):
    request = {"v": 1, "client": node.client, "name": "Memepool", "nonce": NONCE}
    link = link_of(json.dumps({"memeplexGrantRequest": request}))

    assert grants.validate_grant_request(request) == "schema"
    with refuses(r"link: invalid-request \(schema\)$"):
        run(node.keymaster.create_grant(link))
    with refuses(r"link: invalid-request \(schema\)$"):
        run(node.keymaster.create_grant(link, {"registry": BTC}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_takes_the_next_permitted_registry_when_the_node_lacks_the_first(node):
    node.gatekeeper.registries = ["hyperswarm", ETH]

    did = run(node.keymaster.create_grant(link_for(node)))

    assert run(node.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == ETH


def test_create_grant_uses_a_registry_the_request_lists_and_leaves_the_list_out_of_the_grant(node):
    did = run(node.keymaster.create_grant(link_for(node, registries=[ETH])))

    assert run(node.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == ETH
    assert grant_of(node, did) == {"v": 1, "client": node.client, "nonce": NONCE}

    # The order of the permitted registries, not the order the request lists them in.
    first = run(node.keymaster.create_grant(link_for(node, registries=[ETH, BTC])))
    assert run(node.keymaster.resolve_did(first))["didDocumentRegistration"]["registry"] == BTC

    named = run(node.keymaster.create_grant(link_for(node, registries=[ETH, BTC]), {"registry": ETH}))
    assert run(node.keymaster.resolve_did(named))["didDocumentRegistration"]["registry"] == ETH


def test_create_grant_refuses_a_registry_the_request_does_not_list(node):
    with refuses("options.registry: the request lists ETH:mainnet, SOL:mainnet-beta, not BTC:mainnet$"):
        run(node.keymaster.create_grant(link_for(node, registries=[ETH, "SOL:mainnet-beta"]), {"registry": BTC}))
    with refuses("options.registry: this node does not support ZEC:mainnet$"):
        run(node.keymaster.create_grant(link_for(node, registries=["ZEC:mainnet"]), {"registry": "ZEC:mainnet"}))
    with refuses("options.registry: a grant may be created on"):
        run(node.keymaster.create_grant(link_for(node, registries=[ETH]), {"registry": "hyperswarm"}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_refuses_when_the_node_supports_none_of_the_registries_the_request_lists(node):
    message = (
        "options.registry: the request lists ZEC:mainnet, SOL:mainnet-beta"
        " and this node supports local, hyperswarm, BTC:mainnet, ETH:mainnet$"
    )
    with refuses(message):
        run(node.keymaster.create_grant(link_for(node, registries=["ZEC:mainnet", "SOL:mainnet-beta"])))
    assert run(node.keymaster.list_assets()) == []


def test_a_grant_may_have_a_registries_member_which_is_no_field_of_a_grant():
    assert grants.validate_grant({"v": 1, "client": "did:cid:bagaaieraclient", "registries": "anything"}) == "valid"


def test_create_grant_creates_and_signs_as_the_identity_it_checked_whatever_the_current_id_becomes(node):
    resolve = node.gatekeeper.resolve_did
    switched = []

    # The current ID changes to the client while the grantor is being checked.
    async def switching(did, options=None):
        if did == node.alice and (options or {}).get("confirm") and not switched:
            switched.append(True)
            await node.keymaster.set_current_id("Memepool")
        return await resolve(did, options)

    node.gatekeeper.resolve_did = switching

    did = run(node.keymaster.create_grant(link_for(node)))

    assert switched == [True]
    assert run(node.keymaster.get_current_id()) == "Memepool"
    assert run(node.keymaster.resolve_did(did))["didDocument"]["controller"] == node.alice
    assert run(node.keymaster.list_assets("Alice")) == [did]
    assert run(node.keymaster.list_assets("Memepool")) == []
    # Signed with a key of the identity checked.
    assert node.gatekeeper.operations[-1]["proof"]["verificationMethod"].startswith(node.alice)


def test_create_grant_refuses_a_local_identity_whose_assets_are_created_on_local(node):
    run(node.keymaster.create_id("Larry", {"registry": "local"}))

    with refuses("options.controller: a local identity cannot make a grant$"):
        run(node.keymaster.create_grant(link_for(node)))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_refuses_a_request_that_names_the_granting_identity_as_the_client(node):
    with refuses("link: the request names the granting identity as the client$"):
        run(node.keymaster.create_grant(link_for(node, client=node.alice)))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_grants_from_the_identity_named_as_controller_under_an_alias(node):
    bob = run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    run(node.keymaster.set_current_id("Alice"))

    did = run(node.keymaster.create_grant(link_for(node), {"controller": "Bob", "alias": "memepool-grant"}))
    doc = run(node.keymaster.resolve_did("memepool-grant"))

    assert doc["didDocument"]["id"] == did
    assert doc["didDocument"]["controller"] == bob
    assert run(node.keymaster.list_assets()) == []
    assert run(node.keymaster.list_assets("Bob")) == [did]
    with refuses("link: the request names the granting identity as the client$"):
        run(node.keymaster.create_grant(link_for(node), {"controller": "Memepool"}))


def test_create_grant_says_why_it_refuses_a_link(node):
    with refuses("link: not-a-grant-link$"):
        run(node.keymaster.create_grant("archon://auth?challenge=did:cid:abc"))
    with refuses("link: undecodable$"):
        run(node.keymaster.create_grant(f"{grants.GRANT_LINK_PREFIX}not base64!"))
    with refuses("link: too-long$"):
        run(node.keymaster.create_grant(link_for(node) + "A" * 2048))
    with refuses(r"link: invalid-request \(unsupported\)$"):
        run(node.keymaster.create_grant(link_of('{"memeplexGrantRequest":{"v":2}}')))
    with refuses("link: not-a-grant-link$"):
        run(node.keymaster.create_grant(None))
    assert run(node.keymaster.list_assets()) == []


# A link is read without the white space around it, so a vector refused only
# for that white space is accepted.
@pytest.mark.parametrize("case", named(LINK_CASES))
def test_create_grant_reads_a_link_as_its_vector_states(node, case):
    trimmed = case["link"].strip(grants.JS_WHITESPACE)
    decoded = grants.decode_grant_link(trimmed)

    if trimmed == case["link"]:
        assert decoded == case["expect"]

    if "error" in decoded:
        validity = f" ({decoded['validity']})" if "validity" in decoded else ""
        with pytest.raises(KeymasterError) as refusal:
            run(node.keymaster.create_grant(case["link"]))
        assert str(refusal.value) == f"Invalid parameter: link: {decoded['error']}{validity}"
        assert run(node.keymaster.list_assets()) == []
    else:
        did = run(node.keymaster.create_grant(case["link"]))
        assert grants.validate_grant(grant_of(node, did)) == "valid"


# list_grants


def test_list_grants_is_empty_for_an_identity_with_no_grants(node):
    run(node.keymaster.create_asset({"name": "not a grant"}, {"registry": BTC}))
    run(node.keymaster.create_asset({"memeplexGrant": {"v": 1, "client": "memepool"}}, {"registry": BTC}))
    run(node.keymaster.create_asset({"memeplexGrant": {"v": 2, "client": node.client}}, {"registry": BTC}))
    run(node.keymaster.create_asset(["memeplexGrant"], {"registry": BTC}))

    assert run(node.keymaster.list_grants()) == []


def test_list_grants_lists_a_grant_as_pending_until_it_is_anchored_on_its_registry(node):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"], expiresAt="2028-01-01T00:00:00Z")))
    grant = {"v": 1, "client": node.client, "actions": ["memeplex:tag"], "nonce": NONCE, "expiresAt": "2028-01-01T00:00:00Z"}
    listed = {"did": did, "grant": grant, "registry": BTC, "created": True}

    assert run(node.keymaster.list_grants()) == [{**listed, "status": "pending"}]

    anchor(node, did)
    assert run(node.keymaster.list_grants()) == [{**listed, "status": "anchored"}]


def test_list_grants_lists_a_change_as_not_the_creation(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    anchor(node, did)

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:tag"]})) is True
    del node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"]
    grant = {"v": 1, "client": node.client, "nonce": NONCE, "actions": ["memeplex:tag"]}
    listed = {"did": did, "grant": grant, "registry": BTC, "created": False}

    assert run(node.keymaster.list_grants()) == [{**listed, "status": "pending"}]
    anchor(node, did)
    assert run(node.keymaster.list_grants()) == [{**listed, "status": "anchored"}]


def test_list_grants_does_not_take_an_anchor_on_another_chain_or_confirmation_for_an_anchor(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    metadata = node.gatekeeper.docs[did]["didDocumentMetadata"]
    metadata["confirmed"] = True

    def status_with(timestamp):
        metadata["timestamp"] = timestamp
        return run(node.keymaster.list_grants())[0]["status"]

    assert run(node.keymaster.list_grants())[0]["status"] == "pending"
    assert status_with({"chain": ETH, "upperBound": BLOCK}) == "pending"
    assert status_with({"chain": BTC, "lowerBound": BLOCK}) == "pending"
    assert status_with({"chain": BTC, "upperBound": {"height": 100}}) == "pending"
    assert status_with({"chain": BTC, "upperBound": {"height": "100", "timeISO": BLOCK["timeISO"]}}) == "pending"
    assert status_with({"chain": BTC, "upperBound": {"height": True, "timeISO": BLOCK["timeISO"]}}) == "pending"
    assert status_with({"chain": BTC, "upperBound": BLOCK}) == "anchored"


def test_list_grants_lists_a_grant_on_a_registry_where_it_is_void(node):
    grant = {"v": 1, "client": node.client, "nonce": NONCE}
    did = run(node.keymaster.create_asset({"memeplexGrant": grant}, {"registry": "hyperswarm"}))

    assert run(node.keymaster.list_grants()) == [
        {"did": did, "status": "pending", "grant": grant, "registry": "hyperswarm", "created": True},
    ]


def test_list_grants_lists_the_grants_of_the_identity_asked_for(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))

    assert run(node.keymaster.list_grants()) == []
    assert [each["did"] for each in run(node.keymaster.list_grants("Alice"))] == [did]
    assert [each["did"] for each in run(node.keymaster.list_grants(node.alice))] == [did]
    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(node.keymaster.list_grants("Nobody"))


def test_list_grants_lists_an_asset_the_node_cannot_resolve_as_unresolved(node):
    first = run(node.keymaster.create_grant(link_for(node)))
    asset = run(node.keymaster.create_asset({"name": "not a grant"}, {"registry": BTC}))
    second = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))
    resolve = node.gatekeeper.resolve_did

    async def unreachable(did, options=None):
        if did in (first, asset):
            raise RuntimeError("unreachable")
        return await resolve(did, options)

    node.gatekeeper.resolve_did = unreachable

    assert [{"did": each["did"], "status": each["status"]} for each in run(node.keymaster.list_grants())] == [
        {"did": first, "status": "unresolved"},
        {"did": asset, "status": "unresolved"},
        {"did": second, "status": "pending"},
    ]
    assert run(node.keymaster.list_grants())[0] == {"did": first, "status": "unresolved"}


def test_list_grants_does_not_list_a_revoked_grant_which_list_revocations_has(node):
    kept = run(node.keymaster.create_grant(link_for(node)))
    revoked = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))

    assert run(node.keymaster.revoke_grant(revoked)) is True
    assert [each["did"] for each in run(node.keymaster.list_grants())] == [kept]
    assert run(node.keymaster.list_revocations()) == [{"did": revoked, "registry": BTC, "status": "pending"}]


# update_grant


def test_update_grant_changes_the_actions_and_keeps_every_other_field(node):
    scope = {"v": 1, "client": node.client, "nonce": NONCE, "label": "phone", "expiresAt": "2028-01-01T00:00:00Z"}
    did = run(node.keymaster.create_asset({"memeplexGrant": scope, "note": "kept"}, {"registry": BTC}))
    before = deepcopy(node.gatekeeper.docs[did])

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:tag", "memeplex:post"]})) is True

    after = node.gatekeeper.docs[did]
    assert after["didDocumentData"] == {
        "memeplexGrant": {**scope, "actions": ["memeplex:post", "memeplex:tag"]},
        "note": "kept",
    }
    assert after["didDocument"] == before["didDocument"]
    assert after["didDocumentRegistration"] == before["didDocumentRegistration"]
    # The operation changes the data and nothing else.
    assert list(node.gatekeeper.operations[-1]["doc"]) == ["didDocumentData"]


def test_update_grant_keeps_a_member_of_the_data_whose_value_is_none(node):
    scope = {"v": 1, "client": node.client, "nonce": NONCE}
    data = {"memeplexGrant": scope, "note": None, "kept": {"deep": None}}
    did = run(node.keymaster.create_asset(data, {"registry": BTC}))

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:tag"]})) is True

    expected = {"memeplexGrant": {**scope, "actions": ["memeplex:tag"]}, "note": None, "kept": {"deep": None}}
    assert node.gatekeeper.docs[did]["didDocumentData"] == expected
    assert node.gatekeeper.operations[-1]["doc"] == {"didDocumentData": expected}


def test_update_grant_is_refused_when_the_grant_has_changed_since_it_was_read(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    resolve = node.gatekeeper.resolve_did
    update = node.gatekeeper.update_did
    intervened = []

    # Another update lands after this one has read the grant.
    async def intervening(identifier, options=None):
        read = await resolve(identifier, options)
        if identifier == did and not intervened:
            intervened.append(read["didDocumentMetadata"].get("versionId"))
            assert await node.keymaster.update_grant(did, {"actions": ["memeplex:tag"]}) is True
        return read

    # As a Gatekeeper does, refuse an update that does not follow the latest version.
    async def checking(operation):
        if operation.get("previd") != node.gatekeeper.docs[operation["did"]]["didDocumentMetadata"].get("versionId"):
            return False
        return await update(operation)

    node.gatekeeper.resolve_did = intervening
    node.gatekeeper.update_did = checking

    assert run(node.keymaster.update_grant(did, {"expiresAt": "2028-01-01T00:00:00Z"})) is False
    assert len(intervened) == 1
    assert grant_of(node, did) == {"v": 1, "client": node.client, "nonce": NONCE, "actions": ["memeplex:tag"]}
    assert sequence_of(node, did) == 2


def test_update_grant_widens_to_every_core_kind_by_none_or_by_naming_the_core_actions(node):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))
    plain = {"v": 1, "client": node.client, "nonce": NONCE}

    assert run(node.keymaster.update_grant(did, {"actions": None})) is True
    assert grant_of(node, did) == plain

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:rate"]})) is True
    core = ["memeplex:tag", "memeplex:rate", "memeplex:reply", "memeplex:post"]
    assert run(node.keymaster.update_grant(did, {"actions": core})) is True
    assert grant_of(node, did) == plain


def test_update_grant_offers_the_extension_kinds_the_grant_lists_and_no_others(node):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag", EXTENSION])))
    every = [EXTENSION, "memeplex:reply", "memeplex:post", "memeplex:rate", "memeplex:tag"]

    assert run(node.keymaster.update_grant(did, {"actions": every})) is True
    assert grant_of(node, did)["actions"] == [*CORE, EXTENSION]
    with pytest.raises(KeymasterError) as refusal:
        run(node.keymaster.update_grant(did, {"actions": [OTHER_EXTENSION]}))
    assert str(refusal.value) == (
        f"Invalid parameter: changes.actions: every action must be one of {', '.join(CORE)}, {EXTENSION}"
    )

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:post"]})) is True
    with refuses("changes.actions: every action must be one of"):
        run(node.keymaster.update_grant(did, {"actions": [EXTENSION]}))
    assert grant_of(node, did)["actions"] == ["memeplex:post"]


def test_update_grant_sets_changes_and_removes_the_expiry_leaving_the_actions(node):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))
    scoped = {"v": 1, "client": node.client, "actions": ["memeplex:tag"], "nonce": NONCE}

    assert run(node.keymaster.update_grant(did, {"expiresAt": "2028-01-01T00:00:00Z"})) is True
    assert grant_of(node, did) == {**scoped, "expiresAt": "2028-01-01T00:00:00Z"}
    assert run(node.keymaster.update_grant(did, {"expiresAt": "2029-01-01T00:00:00.000Z"})) is True
    assert grant_of(node, did)["expiresAt"] == "2029-01-01T00:00:00.000Z"
    assert run(node.keymaster.update_grant(did, {"expiresAt": None})) is True
    assert grant_of(node, did) == scoped


def test_update_grant_writes_nothing_when_the_change_leaves_the_grant_as_it_is(node):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"], expiresAt="2028-01-01T00:00:00Z")))
    before = sequence_of(node, did)

    same = {"actions": ["memeplex:tag"], "expiresAt": "2028-01-01T00:00:00Z"}
    assert run(node.keymaster.update_grant(did, same)) is True
    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:tag"]})) is True
    assert sequence_of(node, did) == before

    assert run(node.keymaster.update_grant(did, {"actions": ["memeplex:post"]})) is True
    assert sequence_of(node, did) != before


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        pytest.param({}, "changes: actions or expiresAt is needed$", id="no change"),
        pytest.param("actions", "changes: actions or expiresAt is needed$", id="changes that are not an object"),
        pytest.param(None, "changes: actions or expiresAt is needed$", id="no changes at all"),
        pytest.param({"actions": []}, "changes.actions: at least one action is needed$", id="no actions"),
        pytest.param({"actions": ["memeplex:delete"]}, "changes.actions: every action must be one of", id="an unknown action"),
        pytest.param(
            {"expiresAt": "2027-02-30T00:00:00Z"},
            "changes.expiresAt: not an instant such as 2027-01-31T00:00:00Z$",
            id="an expiry that is not an instant",
        ),
        pytest.param(
            {"actions": ["memeplex:post"], "expiresAt": "tomorrow"},
            "changes.expiresAt: not an instant",
            id="a valid action with an invalid expiry",
        ),
    ],
)
def test_update_grant_refuses_a_change_it_cannot_make(node, changes, message):
    did = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))
    before = sequence_of(node, did)

    with refuses(message):
        run(node.keymaster.update_grant(did, changes))
    assert sequence_of(node, did) == before


def test_update_grant_finds_a_grant_by_its_alias(node):
    run(node.keymaster.create_grant(link_for(node), {"alias": "memepool-grant"}))

    assert run(node.keymaster.update_grant("memepool-grant", {"actions": ["memeplex:tag"]})) is True
    assert grant_of(node, "memepool-grant")["actions"] == ["memeplex:tag"]


def test_update_and_revoke_refuse_what_is_not_a_live_valid_grant_of_the_current_id(node):
    asset = run(node.keymaster.create_asset({"name": "not a grant"}, {"registry": BTC}))
    invalid = run(node.keymaster.create_asset({"memeplexGrant": {"v": 1, "client": node.client, "nonce": "short"}}, {"registry": BTC}))
    revoked = run(node.keymaster.create_grant(link_for(node)))
    grant = run(node.keymaster.create_grant(link_for(node, actions=["memeplex:tag"])))
    changes = {"actions": ["memeplex:post"]}

    assert run(node.keymaster.revoke_grant(revoked)) is True

    for did in (asset, invalid, revoked, node.alice):
        with refuses("id: not a grant$"):
            run(node.keymaster.update_grant(did, changes))
        with refuses("id: not a grant$"):
            run(node.keymaster.revoke_grant(did))

    run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    with refuses("id: not a grant of the current ID$"):
        run(node.keymaster.update_grant(grant, changes))
    with refuses("id: not a grant of the current ID$"):
        run(node.keymaster.revoke_grant(grant))

    run(node.keymaster.set_current_id("Alice"))
    assert grant_of(node, grant)["actions"] == ["memeplex:tag"]
    assert not run(node.keymaster.resolve_did(asset))["didDocumentMetadata"].get("deactivated")
    assert not run(node.keymaster.resolve_did(node.alice))["didDocumentMetadata"].get("deactivated")


# revoke_grant


def test_revoke_grant_deletes_the_grant(node):
    did = run(node.keymaster.create_grant(link_for(node)))
    anchor(node, did)

    assert run(node.keymaster.revoke_grant(did)) is True
    assert run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["deactivated"] is True
    assert run(node.keymaster.list_grants()) == []
    # The fake Gatekeeper keeps the creation's anchor on the deleted version.
    del node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"]
    assert run(node.keymaster.list_revocations()) == [{"did": did, "registry": BTC, "status": "pending"}]


def test_revoke_grant_revokes_a_grant_by_its_alias(node):
    did = run(node.keymaster.create_grant(link_for(node), {"alias": "memepool-grant"}))

    assert run(node.keymaster.revoke_grant("memepool-grant")) is True
    assert run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["deactivated"] is True
