"""Grants from a Keymaster: what an identity lets a client application do in
its name.

Keymaster knows no app. A client asks with a grant request, an asset it creates
whose data holds ``<app>GrantRequest``, and the grant is an asset of the
granting identity holding ``<app>Grant``. What a grant means is the app's.

tests/keymaster/grant.test.ts is this file for the TypeScript port. Both ports
run tests/fixtures/grant-request-vectors.json, and both state every refusal in
the same words.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest

from keymaster import KeymasterError, UnknownIDError
from keymaster import grant as grants

from .helpers import run

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
REQUEST_CASES = json.loads((FIXTURES / "grant-request-vectors.json").read_text(encoding="utf-8"))["cases"]

BTC = "BTC:mainnet"
ETH = "ETH:mainnet"
BLOCK = {"height": 100, "timeISO": "2026-11-02T01:40:00.000Z"}
NOT_ESTABLISHED = "request: changed since it was created, so who asks is not established$"
ACTIONS_NEEDED = "a list of at least one action, each once, is needed$"


def named(cases):
    return [pytest.param(case, id=case["name"]) for case in cases]


# The shape every grant request has -------------------------------------------


@pytest.mark.parametrize("case", named(REQUEST_CASES))
def test_data_is_read_as_its_vector_states(case):
    held = grants.grant_request_in(case["data"])
    read = None
    if held is not None:
        app, request = held
        fault = grants.grant_request_fault(request)
        read = {"app": app, **({"fault": fault} if fault else {})}

    assert read == case["expect"]


def test_there_are_vectors_for_every_fault_for_a_sound_request_and_for_data_that_holds_none():
    kinds = {"none" if case["expect"] is None else case["expect"].get("fault", "sound") for case in REQUEST_CASES}

    assert sorted(kinds) == ["actions", "expiresAt", "name", "none", "registries", "request", "sound", "v"]


def test_a_request_is_named_by_its_did_an_alias_or_a_link_to_it():
    assert grants.grant_request_id("did:cid:abc") == "did:cid:abc"
    assert grants.grant_request_id("  did:cid:abc\n") == "did:cid:abc"
    assert grants.grant_request_id("archon://grant?request=did:cid:abc") == "did:cid:abc"
    assert grants.grant_request_id("\tarchon://grant?request=did:cid:abc \n") == "did:cid:abc"
    assert grants.grant_request_id("my-request") == "my-request"
    assert grants.grant_request_id("archon://grant?request=") == ""
    assert grants.grant_request_id("archon://auth?challenge=did:cid:abc") == "archon://auth?challenge=did:cid:abc"


def test_the_white_space_trimmed_is_what_javascript_trims():
    # Python's own strip also removes the separators U+001C to U+001F, and
    # keeps the byte order mark.
    assert grants.grant_request_id("\x1c did:cid:abc﻿ ") == "\x1c did:cid:abc"


def test_the_one_grant_in_an_assets_data_is_found():
    grant = {"client": "did:cid:client"}

    assert grants.grant_in({"exampleGrant": grant, "note": None}) == ("example", "exampleGrant", grant)
    assert grants.grant_in({"exampleGrant": grant, "exampleGrantRequest": {"registries": ["local"]}})[0] == "example"
    assert grants.grant_in({"exampleGrant": grant, "otherGrant": grant}) is None
    assert grants.grant_in({"exampleGrant": {"client": 7}}) is None
    assert grants.grant_in({"exampleGrant": [grant]}) is None
    assert grants.grant_in({"ExampleGrant": grant}) is None
    assert grants.grant_in({"Grant": grant}) is None
    assert grants.grant_in([grant]) is None
    assert grants.grant_in(None) is None
    assert grants.grant_member("example") == "exampleGrant"


# Against a Gatekeeper --------------------------------------------------------


@pytest.fixture
def node(testbed):
    testbed.gatekeeper.registries = ["local", "hyperswarm", BTC, ETH]
    testbed.client = run(testbed.keymaster.create_id("Client", {"registry": "hyperswarm"}))
    testbed.alice = run(testbed.keymaster.create_id("Alice", {"registry": "hyperswarm"}))
    return testbed


def request_of(node, app="example", **request) -> str:
    """A grant request as a client makes one: an asset of the client's, holding
    what it asks for under its app's name. It lists both chains unless told
    otherwise."""
    data = {f"{app}GrantRequest": {"registries": [BTC, ETH], **request}}
    return run(node.keymaster.create_asset(data, {"registry": "hyperswarm", "controller": "Client"}))


def data_of(node, did):
    return run(node.keymaster.resolve_did(did))["didDocumentData"]


def grant_of(node, did, app="example"):
    return data_of(node, did)[f"{app}Grant"]


def registry_of(node, did):
    return run(node.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"]


def sequence_of(node, did):
    return run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["versionSequence"]


def anchor(node, did, registry=BTC):
    node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"] = {"chain": registry, "upperBound": dict(BLOCK)}


def refuses(message: str):
    return pytest.raises(KeymasterError, match=f"^Invalid parameter: {message}")


# create_grant


def test_create_grant_creates_the_grant_a_request_asks_for_to_the_identity_that_made_the_request(node):
    request = request_of(
        node, v=1, name="Example", actions=["example:read", "example:write"], expiresAt="2028-02-29T23:59:59.5Z"
    )
    did = run(node.keymaster.create_grant(request))
    doc = run(node.keymaster.resolve_did(did))
    grant = {
        "v": 1,
        "client": node.client,
        "request": request,
        "actions": ["example:read", "example:write"],
        "expiresAt": "2028-02-29T23:59:59.5Z",
    }

    assert doc["didDocumentData"] == {"exampleGrant": grant}
    assert list(doc["didDocumentData"]["exampleGrant"]) == ["v", "client", "request", "actions", "expiresAt"]
    assert doc["didDocumentRegistration"]["type"] == "asset"
    assert doc["didDocumentRegistration"]["registry"] == BTC
    assert doc["didDocument"]["controller"] == node.alice
    assert run(node.keymaster.list_assets()) == [did]


def test_create_grant_holds_only_the_client_and_the_request_when_the_request_asks_for_no_more(node):
    request = request_of(node, name="Example")

    assert grant_of(node, run(node.keymaster.create_grant(request))) == {"client": node.client, "request": request}


def test_create_grant_names_the_grant_for_the_app_the_request_names(node):
    request = request_of(node, "myApp2", v=2)
    did = run(node.keymaster.create_grant(request))

    assert data_of(node, did) == {"myApp2Grant": {"v": 2, "client": node.client, "request": request}}


def test_create_grant_writes_a_whole_number_v_as_an_integer(node):
    request = request_of(node, v=1.0)
    grant = grant_of(node, run(node.keymaster.create_grant(request)))

    assert grant["v"] == 1
    assert isinstance(grant["v"], int)
    assert grant_of(node, run(node.keymaster.create_grant(request_of(node, v=1.5))))["v"] == 1.5


def test_create_grant_takes_a_link_to_the_request_an_alias_for_it_and_white_space_around_either(node):
    request = request_of(node)
    run(node.keymaster.add_alias("example-request", request))

    for name in [
        f"archon://grant?request={request}",
        f"  archon://grant?request={request}\n",
        "example-request",
        f" {request} ",
        "archon://grant?request=example-request",
    ]:
        assert grant_of(node, run(node.keymaster.create_grant(name))) == {"client": node.client, "request": request}


def test_create_grant_takes_who_asks_from_who_made_the_request_and_nothing_from_its_data(node):
    request = request_of(node, client=node.alice, nonce="Qm9vdHN0cmFwIG5vbmNlMTIz", request="did:cid:another")

    assert grant_of(node, run(node.keymaster.create_grant(request))) == {"client": node.client, "request": request}


@pytest.mark.parametrize("name", ["", "  \n", "archon://grant?request=", 7, None])
def test_create_grant_refuses_what_names_no_request(node, name):
    with refuses("request: a DID, an alias or an archon://grant link is needed$"):
        run(node.keymaster.create_grant(name))


def test_create_grant_refuses_a_request_the_node_does_not_have(node):
    unknown = request_of(node)[:-6] + "aaaaaa"

    for name in [unknown, f"archon://grant?request={unknown}", "no-such-alias", "archon://auth?challenge=did:cid:abc"]:
        with refuses("request: not found$"):
            run(node.keymaster.create_grant(name))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_refuses_a_request_its_client_has_deleted(node):
    request = request_of(node)
    run(node.keymaster.set_current_id("Client"))
    assert run(node.keymaster.revoke_did(request)) is True
    run(node.keymaster.set_current_id("Alice"))

    with refuses("request: deleted$"):
        run(node.keymaster.create_grant(request))


def test_create_grant_refuses_what_is_not_an_asset(node):
    with refuses("request: not an asset$"):
        run(node.keymaster.create_grant(node.client))
    with refuses("request: not an asset$"):
        run(node.keymaster.create_grant("Client"))


def test_create_grant_refuses_a_request_transferred_to_another_identity_which_signed_nothing(node):
    request = request_of(node)
    bob = run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    run(node.keymaster.set_current_id("Client"))
    assert run(node.keymaster.transfer_asset(request, bob)) is True
    run(node.keymaster.set_current_id("Alice"))

    assert run(node.keymaster.resolve_did(request))["didDocument"]["controller"] == bob
    with refuses(NOT_ESTABLISHED):
        run(node.keymaster.create_grant(request))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_refuses_a_request_whose_contents_were_replaced_even_by_its_client(node):
    request = request_of(node, actions=["example:read"])
    replaced = {"exampleGrantRequest": {"registries": [BTC], "actions": ["example:write"]}}
    run(node.keymaster.set_current_id("Client"))
    assert run(node.keymaster.merge_data(request, replaced)) is True
    run(node.keymaster.set_current_id("Alice"))

    with refuses(NOT_ESTABLISHED):
        run(node.keymaster.create_grant(request))


def test_create_grant_refuses_an_asset_that_holds_no_one_request(node):
    client_asset = {"registry": "hyperswarm", "controller": "Client"}
    plain = run(node.keymaster.create_asset({"name": "not a request"}, client_asset))
    both = {"exampleGrantRequest": {"registries": [BTC]}, "otherGrantRequest": {"registries": [BTC]}}
    two = run(node.keymaster.create_asset(both, client_asset))
    grant = run(node.keymaster.create_grant(request_of(node)))

    for did in (plain, two, grant):
        with refuses("request: not a grant request$"):
            run(node.keymaster.create_grant(did))


@pytest.mark.parametrize("case", named([case for case in REQUEST_CASES if (case["expect"] or {}).get("fault")]))
def test_create_grant_refuses_a_request_that_has_not_the_shape_of_one(node, case):
    request = run(node.keymaster.create_asset(case["data"], {"registry": "hyperswarm", "controller": "Client"}))

    with pytest.raises(KeymasterError) as refusal:
        run(node.keymaster.create_grant(request))
    assert str(refusal.value) == f"Invalid parameter: request: invalid ({case['expect']['fault']})"
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_grants_some_of_the_actions_the_request_lists_in_the_order_it_lists_them(node):
    request = request_of(node, actions=["c", "a", "b"])

    def actions_with(chosen):
        return grant_of(node, run(node.keymaster.create_grant(request, {"actions": chosen})))["actions"]

    assert actions_with(["b", "c"]) == ["c", "b"]
    assert actions_with(["a"]) == ["a"]
    assert actions_with(["b", "a", "c"]) == ["c", "a", "b"]


@pytest.mark.parametrize(
    ("asked", "actions", "message"),
    [
        pytest.param({"actions": ["a"]}, ["b"], "every action must be one of a$", id="an action the request does not list"),
        pytest.param({}, ["a"], "the request lists no actions to choose from$", id="any action when the request lists none"),
        pytest.param({"actions": ["a"]}, [], ACTIONS_NEEDED, id="no actions"),
        pytest.param({"actions": ["a"]}, ["a", "a"], ACTIONS_NEEDED, id="an action twice"),
        pytest.param({"actions": ["a"]}, "a", ACTIONS_NEEDED, id="actions that are not a list"),
        pytest.param({"actions": ["a"]}, [1], ACTIONS_NEEDED, id="an action that is not a string"),
    ],
)
def test_create_grant_refuses_actions_the_request_does_not_offer(node, asked, actions, message):
    request = request_of(node, **asked)

    with refuses(f"options.actions: {message}"):
        run(node.keymaster.create_grant(request, {"actions": actions}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_changes_or_removes_the_expiry_the_request_asks_for(node):
    request = request_of(node, expiresAt="2027-01-01T00:00:00Z")
    plain = {"client": node.client, "request": request}

    assert grant_of(node, run(node.keymaster.create_grant(request))) == {**plain, "expiresAt": "2027-01-01T00:00:00Z"}
    did = run(node.keymaster.create_grant(request, {"expiresAt": "2027-06-30T12:00:00+05:30"}))
    assert grant_of(node, did) == {**plain, "expiresAt": "2027-06-30T12:00:00+05:30"}
    assert grant_of(node, run(node.keymaster.create_grant(request, {"expiresAt": None}))) == plain
    did = run(node.keymaster.create_grant(request_of(node), {"expiresAt": "2027-06-30T12:00:00Z"}))
    assert grant_of(node, did)["expiresAt"] == "2027-06-30T12:00:00Z"


@pytest.mark.parametrize(
    "expires_at",
    ["2027-02-30T00:00:00Z", "2027-06-30", "2027-06-30T12:00:00", "2027-06-30T12:00:00Z\n", "", 1798675200],
)
def test_create_grant_refuses_an_expiry_that_is_not_a_date_time(node, expires_at):
    with refuses("options.expiresAt: not a date-time such as 2027-01-31T00:00:00Z$"):
        run(node.keymaster.create_grant(request_of(node), {"expiresAt": expires_at}))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_takes_the_first_registry_the_request_lists_that_the_node_supports(node):
    def registry_for(registries):
        return registry_of(node, run(node.keymaster.create_grant(request_of(node, registries=registries))))

    assert registry_for([ETH, BTC]) == ETH
    assert registry_for(["ZEC:mainnet", ETH, BTC]) == ETH
    assert registry_for(["hyperswarm"]) == "hyperswarm"


def test_create_grant_creates_the_grant_on_the_registry_named_when_the_request_lists_it(node):
    request = request_of(node, registries=[BTC, ETH, "hyperswarm"])

    assert registry_of(node, run(node.keymaster.create_grant(request, {"registry": ETH}))) == ETH
    assert registry_of(node, run(node.keymaster.create_grant(request, {"registry": "hyperswarm"}))) == "hyperswarm"


def test_create_grant_refuses_a_registry_the_request_does_not_list_or_the_node_does_not_support(node):
    with refuses("options.registry: the request lists ETH:mainnet, SOL:mainnet-beta, not BTC:mainnet$"):
        run(node.keymaster.create_grant(request_of(node, registries=[ETH, "SOL:mainnet-beta"]), {"registry": BTC}))
    with refuses("options.registry: this node does not support ZEC:mainnet$"):
        run(node.keymaster.create_grant(request_of(node, registries=["ZEC:mainnet", BTC]), {"registry": "ZEC:mainnet"}))
    with refuses("options.registry: the request lists ZEC:mainnet, my chain and this node supports none of them$"):
        run(node.keymaster.create_grant(request_of(node, registries=["ZEC:mainnet", "my chain"])))
    assert run(node.keymaster.list_assets()) == []


def test_create_grant_creates_a_local_identitys_grant_on_local_and_only_when_the_request_lists_local(node):
    run(node.keymaster.create_id("Larry", {"registry": "local"}))
    on_local = "options.controller: a local identity's grant is created on local, and the request lists"

    with refuses(f"{on_local} BTC:mainnet, ETH:mainnet$"):
        run(node.keymaster.create_grant(request_of(node)))
    with refuses(f"{on_local} BTC:mainnet, local$"):
        run(node.keymaster.create_grant(request_of(node, registries=[BTC, "local"]), {"registry": BTC}))
    assert run(node.keymaster.list_assets()) == []

    listed = request_of(node, registries=[BTC, "local"])
    assert registry_of(node, run(node.keymaster.create_grant(listed))) == "local"
    assert registry_of(node, run(node.keymaster.create_grant(listed, {"registry": "local"}))) == "local"


def test_create_grant_refuses_a_request_the_granting_identity_made_itself(node):
    request = request_of(node)

    with refuses("request: the granting identity made the request, and cannot grant itself$"):
        run(node.keymaster.create_grant(request, {"controller": "Client"}))
    run(node.keymaster.set_current_id("Client"))
    with refuses("request: the granting identity made the request, and cannot grant itself$"):
        run(node.keymaster.create_grant(request))
    assert run(node.keymaster.list_assets()) == [request]


def test_create_grant_grants_from_the_identity_named_as_controller_under_an_alias(node):
    bob = run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    run(node.keymaster.set_current_id("Alice"))

    did = run(node.keymaster.create_grant(request_of(node), {"controller": "Bob", "alias": "example-grant"}))
    doc = run(node.keymaster.resolve_did("example-grant"))

    assert doc["didDocument"]["id"] == did
    assert doc["didDocument"]["controller"] == bob
    assert run(node.keymaster.list_assets()) == []
    assert run(node.keymaster.list_assets("Bob")) == [did]


def test_create_grant_creates_and_signs_as_the_identity_it_checked_whatever_the_current_id_becomes(node):
    request = request_of(node)
    resolve = node.gatekeeper.resolve_did
    switched = []

    # The current ID changes to the client while the grantor is being checked.
    async def switching(did, options=None):
        if did == node.alice and (options or {}).get("confirm") and not switched:
            switched.append(True)
            await node.keymaster.set_current_id("Client")
        return await resolve(did, options)

    node.gatekeeper.resolve_did = switching

    did = run(node.keymaster.create_grant(request))

    assert switched == [True]
    assert run(node.keymaster.get_current_id()) == "Client"
    assert run(node.keymaster.resolve_did(did))["didDocument"]["controller"] == node.alice
    assert run(node.keymaster.list_assets("Alice")) == [did]
    assert run(node.keymaster.list_assets("Client")) == [request]
    # Signed with a key of the identity checked.
    assert node.gatekeeper.operations[-1]["proof"]["verificationMethod"].startswith(node.alice)


# list_grants


def test_list_grants_lists_only_assets_that_hold_one_grant(node):
    grant = {"client": node.client}

    for data in [
        {"name": "not a grant"},
        {"exampleGrant": {"client": 7}},
        {"exampleGrant": grant, "otherGrant": grant},
        {"exampleGrantRequest": {"registries": [BTC]}},
        ["exampleGrant"],
    ]:
        run(node.keymaster.create_asset(data, {"registry": BTC}))

    assert run(node.keymaster.list_grants()) == []


def test_list_grants_lists_a_grant_with_its_app_and_its_request_as_pending_until_it_is_anchored(node):
    request = request_of(node, actions=["example:read"], expiresAt="2028-01-01T00:00:00Z")
    did = run(node.keymaster.create_grant(request))
    grant = {"client": node.client, "request": request, "actions": ["example:read"], "expiresAt": "2028-01-01T00:00:00Z"}
    listed = {"did": did, "app": "example", "grant": grant, "request": request, "registry": BTC, "created": True}

    assert run(node.keymaster.list_grants()) == [{**listed, "status": "pending"}]
    assert list(run(node.keymaster.list_grants())[0]) == ["did", "status", "app", "grant", "request", "registry", "created"]

    anchor(node, did)
    assert run(node.keymaster.list_grants()) == [{**listed, "status": "anchored"}]


def test_list_grants_lists_the_grants_of_every_app_and_one_made_without_a_request(node):
    first = run(node.keymaster.create_grant(request_of(node)))
    second = run(node.keymaster.create_grant(request_of(node, "memeplex")))
    by_hand = {"client": node.client, "label": "made by hand"}
    third = run(node.keymaster.create_asset({"handGrant": by_hand}, {"registry": "hyperswarm"}))
    listed = run(node.keymaster.list_grants())

    assert [(each["did"], each["app"]) for each in listed] == [(first, "example"), (second, "memeplex"), (third, "hand")]
    assert listed[2] == {
        "did": third, "status": "pending", "app": "hand", "grant": by_hand, "registry": "hyperswarm", "created": True,
    }


def test_list_grants_lists_a_change_as_not_the_creation(node):
    did = run(node.keymaster.create_grant(request_of(node)))
    anchor(node, did)

    assert run(node.keymaster.update_grant(did, {"actions": ["example:read"]})) is True
    del node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"]

    listed = run(node.keymaster.list_grants())[0]
    assert (listed["status"], listed["created"], listed["grant"]["actions"]) == ("pending", False, ["example:read"])
    anchor(node, did)
    listed = run(node.keymaster.list_grants())[0]
    assert (listed["status"], listed["created"]) == ("anchored", False)


def test_list_grants_does_not_take_an_anchor_on_another_chain_or_confirmation_for_an_anchor(node):
    did = run(node.keymaster.create_grant(request_of(node)))
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


def test_list_grants_lists_the_grants_of_the_identity_asked_for(node):
    did = run(node.keymaster.create_grant(request_of(node)))
    run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))

    assert run(node.keymaster.list_grants()) == []
    assert [each["did"] for each in run(node.keymaster.list_grants("Alice"))] == [did]
    assert [each["did"] for each in run(node.keymaster.list_grants(node.alice))] == [did]
    assert run(node.keymaster.list_grants("Client")) == []
    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(node.keymaster.list_grants("Nobody"))


def test_list_grants_lists_an_asset_the_node_cannot_resolve_as_unresolved(node):
    first = run(node.keymaster.create_grant(request_of(node)))
    asset = run(node.keymaster.create_asset({"name": "not a grant"}, {"registry": BTC}))
    second = run(node.keymaster.create_grant(request_of(node)))
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
    kept = run(node.keymaster.create_grant(request_of(node)))
    revoked = run(node.keymaster.create_grant(request_of(node)))

    assert run(node.keymaster.revoke_grant(revoked)) is True
    assert [each["did"] for each in run(node.keymaster.list_grants())] == [kept]
    assert run(node.keymaster.list_revocations()) == [{"did": revoked, "registry": BTC, "status": "pending"}]


def test_list_grants_lists_a_grant_again_after_a_revocation_that_did_not_take_effect(node):
    request = request_of(node, actions=["example:read"])
    did = run(node.keymaster.create_grant(request))
    live = deepcopy(node.gatekeeper.docs[did])

    assert run(node.keymaster.revoke_grant(did)) is True
    assert run(node.keymaster.list_grants()) == []
    assert run(node.keymaster.fetch_id_info("Alice")).get("revoking") == [did]

    # Another change took the deletion's place: the node resolves the grant as live.
    node.gatekeeper.docs[did] = live
    run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))

    assert run(node.keymaster.list_grants()) == []
    assert run(node.keymaster.list_grants("Alice")) == [{
        "did": did,
        "status": "pending",
        "app": "example",
        "grant": {"client": node.client, "request": request, "actions": ["example:read"]},
        "request": request,
        "registry": BTC,
        "created": True,
    }]
    assert run(node.keymaster.list_assets("Alice")) == [did]
    assert run(node.keymaster.fetch_id_info("Alice")).get("revoking") is None


# update_grant


def test_update_grant_changes_the_actions_to_any_the_caller_names_and_keeps_every_other_member(node):
    scope = {
        "v": 1, "client": node.client, "nonce": "Qm9vdHN0cmFwIG5vbmNlMTIz", "label": "phone",
        "expiresAt": "2028-01-01T00:00:00Z",
    }
    did = run(node.keymaster.create_asset({"exampleGrant": scope, "note": "kept"}, {"registry": BTC}))
    before = deepcopy(node.gatekeeper.docs[did])

    assert run(node.keymaster.update_grant(did, {"actions": ["example:write", "anything at all"]})) is True

    after = node.gatekeeper.docs[did]
    assert after["didDocumentData"] == {
        "exampleGrant": {**scope, "actions": ["example:write", "anything at all"]},
        "note": "kept",
    }
    assert after["didDocument"] == before["didDocument"]
    assert after["didDocumentRegistration"] == before["didDocumentRegistration"]
    # The operation changes the data and nothing else.
    assert list(node.gatekeeper.operations[-1]["doc"]) == ["didDocumentData"]


def test_update_grant_keeps_a_member_of_the_data_whose_value_is_none(node):
    data = {"exampleGrant": {"client": node.client}, "note": None, "kept": {"deep": None}}
    did = run(node.keymaster.create_asset(data, {"registry": BTC}))

    assert run(node.keymaster.update_grant(did, {"actions": ["example:read"]})) is True

    expected = {
        "exampleGrant": {"client": node.client, "actions": ["example:read"]},
        "note": None,
        "kept": {"deep": None},
    }
    assert node.gatekeeper.docs[did]["didDocumentData"] == expected
    assert node.gatekeeper.operations[-1]["doc"] == {"didDocumentData": expected}


def test_update_grant_removes_the_actions_or_the_expiry_with_none_and_sets_either(node):
    request = request_of(node, actions=["example:read"])
    did = run(node.keymaster.create_grant(request))
    plain = {"client": node.client, "request": request}

    assert run(node.keymaster.update_grant(did, {"expiresAt": "2028-01-01T00:00:00Z"})) is True
    assert grant_of(node, did) == {**plain, "actions": ["example:read"], "expiresAt": "2028-01-01T00:00:00Z"}
    assert run(node.keymaster.update_grant(did, {"actions": None, "expiresAt": "2029-01-01T00:00:00-08:00"})) is True
    assert grant_of(node, did) == {**plain, "expiresAt": "2029-01-01T00:00:00-08:00"}
    assert run(node.keymaster.update_grant(did, {"expiresAt": None})) is True
    assert grant_of(node, did) == plain


def test_update_grant_removes_a_member_whose_value_is_none_which_is_not_the_same_as_having_none(node):
    by_hand = {"exampleGrant": {"client": node.client, "actions": None, "expiresAt": None}}
    did = run(node.keymaster.create_asset(by_hand, {"registry": BTC}))
    assert sequence_of(node, did) == 1

    assert run(node.keymaster.update_grant(did, {"expiresAt": None})) is True
    assert data_of(node, did) == {"exampleGrant": {"client": node.client, "actions": None}}
    assert sequence_of(node, did) == 2

    assert run(node.keymaster.update_grant(did, {"actions": None})) is True
    assert data_of(node, did) == {"exampleGrant": {"client": node.client}}
    assert sequence_of(node, did) == 3


def test_update_grant_writes_nothing_when_the_change_leaves_the_grant_as_it_is(node):
    request = request_of(node, actions=["example:read"], expiresAt="2028-01-01T00:00:00Z")
    did = run(node.keymaster.create_grant(request))
    before = sequence_of(node, did)

    same = {"actions": ["example:read"], "expiresAt": "2028-01-01T00:00:00Z"}
    assert run(node.keymaster.update_grant(did, same)) is True
    assert run(node.keymaster.update_grant(did, {"actions": ["example:read"]})) is True
    assert sequence_of(node, did) == before

    assert run(node.keymaster.update_grant(did, {"actions": ["example:write"]})) is True
    assert sequence_of(node, did) != before


def test_update_grant_is_refused_when_the_grant_has_changed_since_it_was_read(node):
    request = request_of(node)
    did = run(node.keymaster.create_grant(request))
    resolve = node.gatekeeper.resolve_did
    update = node.gatekeeper.update_did
    intervened = []

    # Another update lands after this one has read the grant.
    async def intervening(identifier, options=None):
        read = await resolve(identifier, options)
        if identifier == did and not intervened:
            intervened.append(read["didDocumentMetadata"].get("versionId"))
            assert await node.keymaster.update_grant(did, {"actions": ["example:read"]}) is True
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
    assert grant_of(node, did) == {"client": node.client, "request": request, "actions": ["example:read"]}
    assert sequence_of(node, did) == 2


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        pytest.param({}, "changes: actions or expiresAt is needed$", id="no change"),
        pytest.param("actions", "changes: actions or expiresAt is needed$", id="changes that are not an object"),
        pytest.param(None, "changes: actions or expiresAt is needed$", id="no changes at all"),
        pytest.param({"actions": []}, f"changes.actions: {ACTIONS_NEEDED}", id="no actions"),
        pytest.param({"actions": ["a", "a"]}, f"changes.actions: {ACTIONS_NEEDED}", id="an action twice"),
        pytest.param({"actions": [""]}, f"changes.actions: {ACTIONS_NEEDED}", id="an empty action"),
        pytest.param(
            {"expiresAt": "2027-02-30T00:00:00Z"},
            "changes.expiresAt: not a date-time such as 2027-01-31T00:00:00Z$",
            id="an expiry that is not a date-time",
        ),
        pytest.param(
            {"actions": ["a"], "expiresAt": "tomorrow"},
            "changes.expiresAt: not a date-time",
            id="a sound action with an unsound expiry",
        ),
    ],
)
def test_update_grant_refuses_a_change_it_cannot_make(node, changes, message):
    did = run(node.keymaster.create_grant(request_of(node, actions=["example:read"])))
    before = sequence_of(node, did)

    with refuses(message):
        run(node.keymaster.update_grant(did, changes))
    assert sequence_of(node, did) == before


def test_update_grant_finds_a_grant_by_its_alias(node):
    run(node.keymaster.create_grant(request_of(node), {"alias": "example-grant"}))

    assert run(node.keymaster.update_grant("example-grant", {"actions": ["example:read"]})) is True
    assert grant_of(node, "example-grant")["actions"] == ["example:read"]


def test_update_and_revoke_refuse_what_is_not_a_live_grant_of_the_current_id(node):
    asset = run(node.keymaster.create_asset({"name": "not a grant"}, {"registry": BTC}))
    request = request_of(node)
    revoked = run(node.keymaster.create_grant(request))
    grant = run(node.keymaster.create_grant(request_of(node, actions=["example:read"])))
    changes = {"actions": ["example:write"]}

    assert run(node.keymaster.revoke_grant(revoked)) is True

    for did in (asset, revoked, node.alice):
        with refuses("id: not a grant$"):
            run(node.keymaster.update_grant(did, changes))
        with refuses("id: not a grant$"):
            run(node.keymaster.revoke_grant(did))

    # The request is the client's, and is no grant.
    with refuses("id: not a grant$"):
        run(node.keymaster.update_grant(request, changes))

    run(node.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    with refuses("id: not a grant of the current ID$"):
        run(node.keymaster.update_grant(grant, changes))
    with refuses("id: not a grant of the current ID$"):
        run(node.keymaster.revoke_grant(grant))

    run(node.keymaster.set_current_id("Alice"))
    assert grant_of(node, grant)["actions"] == ["example:read"]
    assert not run(node.keymaster.resolve_did(asset))["didDocumentMetadata"].get("deactivated")
    assert not run(node.keymaster.resolve_did(node.alice))["didDocumentMetadata"].get("deactivated")


# revoke_grant


def test_revoke_grant_deletes_the_grant(node):
    did = run(node.keymaster.create_grant(request_of(node)))
    anchor(node, did)

    assert run(node.keymaster.revoke_grant(did)) is True
    assert run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["deactivated"] is True
    # The fake Gatekeeper keeps the creation's anchor on the deleted version.
    del node.gatekeeper.docs[did]["didDocumentMetadata"]["timestamp"]
    assert run(node.keymaster.list_grants()) == []
    assert run(node.keymaster.list_revocations()) == [{"did": did, "registry": BTC, "status": "pending"}]


def test_revoke_grant_revokes_a_grant_by_its_alias(node):
    did = run(node.keymaster.create_grant(request_of(node), {"alias": "example-grant"}))

    assert run(node.keymaster.revoke_grant("example-grant")) is True
    assert run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["deactivated"] is True


# An app of its own


def test_an_app_is_granted_listed_changed_and_revoked_by_its_name_alone(node):
    asked = {
        "v": 3, "name": "Birdwatch", "registries": ["hyperswarm"],
        "actions": ["sightings:add", "sightings:edit"], "colour": "teal",
    }
    request = run(node.keymaster.create_asset(
        {"birdwatchGrantRequest": asked}, {"registry": "hyperswarm", "controller": "Client"},
    ))

    did = run(node.keymaster.create_grant(f"archon://grant?request={request}", {"actions": ["sightings:add"]}))
    grant = {"v": 3, "client": node.client, "request": request, "actions": ["sightings:add"]}

    assert data_of(node, did) == {"birdwatchGrant": grant}
    assert run(node.keymaster.list_grants()) == [{
        "did": did, "status": "pending", "app": "birdwatch", "grant": grant, "request": request,
        "registry": "hyperswarm", "created": True,
    }]

    changes = {"actions": ["sightings:edit", "sightings:delete"], "expiresAt": "2030-01-01T00:00:00Z"}
    assert run(node.keymaster.update_grant(did, changes)) is True
    assert data_of(node, did) == {"birdwatchGrant": {**grant, **changes}}
    listed = run(node.keymaster.list_grants())[0]
    assert (listed["app"], listed["created"]) == ("birdwatch", False)

    assert run(node.keymaster.revoke_grant(did)) is True
    assert run(node.keymaster.list_grants()) == []
    assert run(node.keymaster.resolve_did(did))["didDocumentMetadata"]["deactivated"] is True


def test_a_request_an_app_would_not_accept_is_granted_all_the_same(node):
    # Keymaster applies no app's rules: what such a grant is worth is for the
    # app's verifier to say.
    request = request_of(node, "memeplex", v=1, registries=["hyperswarm"], actions=["memeplex:nonsense"])
    did = run(node.keymaster.create_grant(request))

    assert data_of(node, did) == {
        "memeplexGrant": {"v": 1, "client": node.client, "request": request, "actions": ["memeplex:nonsense"]},
    }
    assert registry_of(node, did) == "hyperswarm"
