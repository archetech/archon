import os
import requests
import json
import sys
import time
from urllib.parse import urlencode

_base_url = os.environ.get("ARCHON_KEYMASTER_URL", "http://localhost:4226")
_keymaster_api = _base_url + "/api/v1"
_session = requests.Session()
_admin_api_key = os.environ.get("ARCHON_ADMIN_API_KEY", "")
if _admin_api_key:
    _session.headers["Authorization"] = f"Bearer {_admin_api_key}"


class KeymasterError(Exception):
    """An error occurred while communicating with the Keymaster API."""


def add_custom_header(header: str, value: str):
    _session.headers[header] = value


def remove_custom_header(header: str):
    _session.headers.pop(header, None)


def set_api_key(api_key: str):
    global _admin_api_key
    _admin_api_key = api_key
    if api_key:
        add_custom_header("Authorization", f"Bearer {api_key}")
    else:
        remove_custom_header("Authorization")


def proxy_request(method, url, **kwargs):
    """
    Send a request to the specified URL and handle any HTTP errors.

    Args:
        method (str): The HTTP method to use for the request.
        url (str): The URL to send the request to.
        **kwargs: Additional arguments to pass to `requests.request`.

    Returns:
        dict: The JSON response from the server.

    Raises:
        HTTPException: If the request fails, with the status
        code and response text from the server.
    """
    try:
        response = _session.request(method, url, **kwargs)
        response.raise_for_status()
        return response.json()
    except requests.HTTPError as e:
        raise KeymasterError(f"Error {e.response.status_code}: {e.response.text}")


def set_url(new_url: str):
    global _base_url, _keymaster_api
    _base_url = new_url
    _keymaster_api = _base_url + "/api/v1"


def connect(options=None):
    if options is None:
        options = {}

    url = options.get("url")
    if url:
        set_url(url)

    api_key = options.get("apiKey") or options.get("api_key")
    if api_key:
        set_api_key(api_key)

    if options.get("waitUntilReady") or options.get("wait_until_ready"):
        wait_until_ready(
            interval_seconds=options.get("intervalSeconds", options.get("interval_seconds", 5)),
            chatty=options.get("chatty", False),
            become_chatty_after=options.get("becomeChattyAfter", options.get("become_chatty_after", 0)),
            max_retries=options.get("maxRetries", options.get("max_retries", 0)),
        )


def create(options=None):
    connect(options)
    return sys.modules[__name__]


def wait_until_ready(interval_seconds=5, chatty=False, become_chatty_after=0, max_retries=0):
    ready = False
    retries = 0

    if chatty:
        print(f"Connecting to Keymaster at {_keymaster_api}")

    while not ready:
        ready = is_ready()
        if ready:
            break

        retries += 1
        if max_retries > 0 and retries > max_retries:
            return

        if not chatty and become_chatty_after > 0 and retries > become_chatty_after:
            print(f"Connecting to Keymaster at {_keymaster_api}")
            chatty = True

        if chatty:
            print("Waiting for Keymaster to be ready...")
        time.sleep(interval_seconds)

    if chatty:
        print("Keymaster service is ready!")


def _query_string(params=None):
    if not params:
        return ""

    encoded = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            encoded[key] = "true" if value else "false"
        else:
            encoded[key] = str(value)
    if not encoded:
        return ""
    return f"?{urlencode(encoded)}"


def _with_query(url, params=None):
    return f"{url}{_query_string(params)}"


def get_version():
    response = proxy_request("GET", f"{_keymaster_api}/version")
    return response


def is_ready():
    response = proxy_request("GET", f"{_keymaster_api}/ready")
    return response["ready"]


def create_id(name, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST", f"{_keymaster_api}/ids", json={"name": name, "options": options}
    )
    return response["did"]


def get_current_id():
    response = proxy_request("GET", f"{_keymaster_api}/ids/current")
    return response["current"]


def set_current_id(name):
    response = proxy_request(
        "PUT", f"{_keymaster_api}/ids/current", json={"name": name}
    )
    return response["ok"]


def remove_id(identifier):
    response = proxy_request("DELETE", f"{_keymaster_api}/ids/{identifier}")
    return response["ok"]


def rename_id(identifier, name):
    response = proxy_request(
        "POST", f"{_keymaster_api}/ids/{identifier}/rename", json={"name": name}
    )
    return response["ok"]


def change_registry(identifier, registry):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/ids/{identifier}/change-registry",
        json={"registry": registry},
    )
    return response["ok"]


def backup_id(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/ids/{identifier}/backup")
    return response["ok"]


def recover_id(did):
    response = proxy_request(
        "POST", f"{_keymaster_api}/ids/{did}/recover", json={"did": did}
    )
    return response["recovered"]


def encrypt_message(msg, receiver, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/keys/encrypt/message",
        json={"msg": msg, "receiver": receiver, "options": options},
    )
    return response["did"]


def decrypt_message(did):
    response = proxy_request(
        "POST", f"{_keymaster_api}/keys/decrypt/message", json={"did": did}
    )
    return response["message"]


def list_ids():
    response = proxy_request("GET", f"{_keymaster_api}/ids")
    return response["ids"]


def load_wallet():
    response = proxy_request("GET", f"{_keymaster_api}/wallet")
    return response["wallet"]


def save_wallet(wallet):
    response = proxy_request("PUT", f"{_keymaster_api}/wallet", json={"wallet": wallet})
    return response["ok"]


def backup_wallet():
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/backup",
    )
    return response["ok"]


def recover_wallet():
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/recover",
    )
    return response["wallet"]


def new_wallet(mnemonic, overwrite=False):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/new",
        json={"mnemonic": mnemonic, "overwrite": overwrite},
    )
    return response["wallet"]


def check_wallet():
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/check",
    )
    return response["check"]


def fix_wallet():
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/fix",
    )
    return response["fix"]


def decrypt_mnemonic():
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/wallet/mnemonic",
    )
    return response["mnemonic"]


def list_registries():
    response = proxy_request("GET", f"{_keymaster_api}/registries")
    return response["registries"]


def resolve_did(name, options=None):
    response = proxy_request("GET", _with_query(f"{_keymaster_api}/did/{name}", options))
    return response["docs"]


def resolve_asset(name, options=None):
    response = proxy_request("GET", _with_query(f"{_keymaster_api}/assets/{name}", options))
    return response["asset"]


def create_schema(schema, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST", f"{_keymaster_api}/schemas", json={"schema": schema, "options": options}
    )
    return response["did"]


def get_schema(identifier):
    response = proxy_request("GET", f"{_keymaster_api}/schemas/{identifier}")
    return response["schema"]


def set_schema(identifier, schema):
    response = proxy_request(
        "PUT", f"{_keymaster_api}/schemas/{identifier}", json={"schema": schema}
    )
    return response["ok"]


def test_schema(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/schemas/{identifier}/test")
    return response["test"]


def list_schemas(owner=None):
    if owner is None:
        owner = ""
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/schemas?owner={owner}",
    )
    return response["schemas"]


def test_agent(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/agents/{identifier}/test")
    return response["test"]


def create_template(id):
    response = proxy_request(
        "POST", f"{_keymaster_api}/schemas/{id}/template", json={"id": id}
    )
    return response["template"]


def bind_credential(subject, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/bind",
        json={"subject": subject, "options": options},
    )
    return response["credential"]


def issue_credential(credential, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/issued",
        json={"credential": credential, "options": options},
    )
    return response["did"]


def send_credential(did, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/issued/{did}/send",
        json={"options": options},
    )
    return response["did"]


def update_credential(did, credential):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/issued/{did}",
        json={"credential": credential},
    )
    return response["ok"]


def get_credential(did):
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/credentials/held/{did}",
    )
    return response["credential"]


def list_credentials():
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/credentials/held",
    )
    return response["held"]


def publish_credential(did, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/held/{did}/publish",
        json={"options": options},
    )
    return response["ok"]


def unpublish_credential(did):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/held/{did}/unpublish",
    )
    return response["ok"]


def remove_credential(did):
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/credentials/held/{did}",
    )
    return response["ok"]


def revoke_credential(did):
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/credentials/issued/{did}",
    )
    return response["ok"]


def list_issued():
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/credentials/issued",
    )
    return response["issued"]


def accept_credential(did):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/credentials/held",
        json={"did": did},
    )
    return response["ok"]


def decrypt_json(did):
    response = proxy_request(
        "POST", f"{_keymaster_api}/keys/decrypt/json", json={"did": did}
    )
    return response["json"]


def encrypt_json(json, receiver, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/keys/encrypt/json",
        json={"json": json, "receiver": receiver, "options": options},
    )
    return response["did"]


def list_aliases():
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/aliases",
    )
    return response["aliases"]


def add_alias(alias, did):
    response = proxy_request(
        "POST", f"{_keymaster_api}/aliases", json={"alias": alias, "did": did}
    )
    return response["ok"]


def get_alias(alias):
    response = proxy_request("GET", f"{_keymaster_api}/aliases/{alias}")
    return response["did"]


def remove_alias(alias):
    response = proxy_request("DELETE", f"{_keymaster_api}/aliases/{alias}")
    return response["ok"]


def list_addresses():
    response = proxy_request("GET", f"{_keymaster_api}/addresses")
    return response["addresses"]


def get_address(domain):
    response = proxy_request("GET", f"{_keymaster_api}/addresses/{domain}")
    return response["address"]


def import_address(domain):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/addresses/import",
        json={"domain": domain},
    )
    return response["addresses"]


def check_address(address):
    return proxy_request("GET", f"{_keymaster_api}/addresses/check/{address}")


def add_address(address):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/addresses",
        json={"address": address},
    )
    return response["ok"]


def remove_address(address):
    safe = requests.utils.quote(str(address), safe="")
    response = proxy_request("DELETE", f"{_keymaster_api}/addresses/{safe}")
    return response["ok"]


def create_challenge(challenge, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/challenge",
        json={"challenge": challenge, "options": options},
    )
    return response["did"]


def create_response(challenge, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/response",
        json={"challenge": challenge, "options": options},
    )
    return response["did"]


def verify_response(response, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/response/verify",
        json={"response": response, "options": options},
    )
    return response["verify"]


def create_group(name, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/groups",
        json={"name": name, "options": options},
    )
    return response["did"]


def get_group(group):
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/groups/{group}",
    )
    return response["group"]


def add_group_member(group, member):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/groups/{group}/add",
        json={"group": group, "member": member},
    )
    return response["ok"]


def remove_group_member(group, member):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/groups/{group}/remove",
        json={"group": group, "member": member},
    )
    return response["ok"]


def test_group(group, member):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/groups/{group}/test",
        json={"group": group, "member": member},
    )
    return response["test"]


def list_groups(owner=None):
    if owner is None:
        owner = ""
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/groups?owner={owner}",
    )
    return response["groups"]


def rotate_keys():
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/keys/rotate",
    )
    return response["ok"]


def add_proof(contents):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/keys/sign",
        json={"contents": contents},
    )
    return response["signed"]


def verify_proof(json):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/keys/verify",
        json={"json": json},
    )
    return response["ok"]


def poll_template():
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/templates/poll",
    )
    return response["template"]


def create_poll(poll, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/polls",
        json={"poll": poll, "options": options},
    )
    return response["did"]


def list_polls(owner=None):
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/polls?owner={owner}",
    )
    return response["polls"]


def get_poll(poll):
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/polls/{poll}",
    )
    return response["poll"]


def test_poll(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/polls/{identifier}/test")
    return response["test"]


def view_poll(poll):
    response = proxy_request(
        "GET",
        f"{_keymaster_api}/polls/{poll}/view",
    )
    return response["poll"]


def vote_poll(poll, vote, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/polls/{poll}/vote",
        json={"poll": poll, "vote": vote, "options": options},
    )
    return response["did"]


def update_poll(ballot):
    response = proxy_request(
        "PUT", f"{_keymaster_api}/polls/update", json={"ballot": ballot}
    )
    return response["ok"]


def publish_poll(poll, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/polls/{poll}/publish",
        json={"options": options},
    )
    return response["ok"]


def unpublish_poll(poll):
    response = proxy_request("POST", f"{_keymaster_api}/polls/{poll}/unpublish")
    return response["ok"]


def revoke_did(did):
    response = proxy_request("DELETE", f"{_keymaster_api}/did/{did}")
    return response["ok"]


def list_dmail(owner=None):
    url = f"{_keymaster_api}/dmail"
    if owner:
        url = f"{url}?owner={owner}"
    response = proxy_request("GET", url)
    return response["dmail"]


def create_dmail(message, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/dmail",
        json={"message": message, "options": options},
    )
    return response["did"]


def import_dmail(did):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/dmail/import",
        json={"did": did},
    )
    return response["ok"]


def get_dmail_message(identifier, options=None):
    response = proxy_request("GET", _with_query(f"{_keymaster_api}/dmail/{identifier}", options))
    return response["message"]


def update_dmail(identifier, message):
    response = proxy_request(
        "PUT",
        f"{_keymaster_api}/dmail/{identifier}",
        json={"message": message},
    )
    return response["ok"]


def remove_dmail(identifier):
    response = proxy_request("DELETE", f"{_keymaster_api}/dmail/{identifier}")
    return response["ok"]


def send_dmail(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/dmail/{identifier}/send")
    return response["did"]


def file_dmail(identifier, tags):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/dmail/{identifier}/file",
        json={"tags": tags},
    )
    return response["ok"]


def list_dmail_attachments(identifier, options=None):
    response = proxy_request(
        "GET",
        _with_query(f"{_keymaster_api}/dmail/{identifier}/attachments", options),
    )
    return response["attachments"]


def add_dmail_attachment(identifier, name, data):
    if isinstance(data, (bytes, bytearray)):
        raw = data
    else:
        with open(data, "rb") as f:
            raw = f.read()

    safe_name = str(name).replace("\\", "\\\\").replace('"', '\\"')
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Options": f'{{"name":"{safe_name}"}}',
    }

    response = proxy_request(
        "POST",
        f"{_keymaster_api}/dmail/{identifier}/attachments",
        data=raw,
        headers=headers,
    )
    return response["ok"]


def remove_dmail_attachment(identifier, name):
    safe = requests.utils.quote(str(name), safe="")
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/dmail/{identifier}/attachments/{safe}",
    )
    return response["ok"]


def get_dmail_attachment(identifier, name):
    safe = requests.utils.quote(str(name), safe="")
    url = f"{_keymaster_api}/dmail/{identifier}/attachments/{safe}"
    resp = _session.get(url)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        if resp.status_code == 404:
            return None
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    if not resp.content:
        return None
    return resp.content


def create_notice(message, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/notices",
        json={"message": message, "options": options},
    )
    return response["did"]


def update_notice(identifier, message):
    response = proxy_request(
        "PUT",
        f"{_keymaster_api}/notices/{identifier}",
        json={"message": message},
    )
    return response["ok"]


def refresh_notices():
    response = proxy_request("POST", f"{_keymaster_api}/notices/refresh")
    return response["ok"]


def create_vault(options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/vaults",
        json={"options": options},
    )
    return response["did"]


def get_vault(identifier, options=None):
    response = proxy_request("GET", _with_query(f"{_keymaster_api}/vaults/{identifier}", options))
    return response["vault"]


def test_vault(identifier, options=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/vaults/{identifier}/test",
        json={"options": options},
    )
    return response["test"]


def add_vault_member(vault_id, member_id):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/vaults/{vault_id}/members",
        json={"memberId": member_id},
    )
    return response["ok"]


def remove_vault_member(vault_id, member_id):
    safe_member = requests.utils.quote(str(member_id), safe="")
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/vaults/{vault_id}/members/{safe_member}",
    )
    return response["ok"]


def list_vault_members(vault_id):
    response = proxy_request("GET", f"{_keymaster_api}/vaults/{vault_id}/members")
    return response["members"]


def add_vault_item(vault_id, name, data):
    if isinstance(data, (bytes, bytearray)):
        raw = data
    else:
        with open(data, "rb") as f:
            raw = f.read()

    safe_name = str(name).replace("\\", "\\\\").replace('"', '\\"')
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Options": f'{{"name":"{safe_name}"}}',
    }
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/vaults/{vault_id}/items",
        data=raw,
        headers=headers,
    )
    return response["ok"]


def remove_vault_item(vault_id, name):
    safe = requests.utils.quote(str(name), safe="")
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/vaults/{vault_id}/items/{safe}",
    )
    return response["ok"]


def list_vault_items(vault_id, options=None):
    response = proxy_request("GET", _with_query(f"{_keymaster_api}/vaults/{vault_id}/items", options))
    return response["items"]


def get_vault_item(vault_id, name, options=None):
    safe = requests.utils.quote(str(name), safe="")
    url = _with_query(f"{_keymaster_api}/vaults/{vault_id}/items/{safe}", options)
    resp = _session.get(url)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        if resp.status_code == 404:
            return None
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    if not resp.content:
        return None
    return resp.content


def get_ipfs_data(cid):
    safe_cid = requests.utils.quote(str(cid), safe="")
    url = f"{_keymaster_api}/ipfs/data/{safe_cid}"
    resp = _session.get(url)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    return resp.content


def create_image(data, options=None):
    if options is None:
        options = {}
    headers = {"Content-Type": "application/octet-stream"}
    if options:
        headers["X-Options"] = json.dumps(options)
    resp = _session.post(f"{_keymaster_api}/images", data=data, headers=headers)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    return resp.json()["did"]


def update_image(identifier, data, options=None):
    if options is None:
        options = {}
    headers = {"Content-Type": "application/octet-stream"}
    if options:
        headers["X-Options"] = json.dumps(options)
    resp = _session.put(f"{_keymaster_api}/images/{identifier}", data=data, headers=headers)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    return resp.json()["ok"]


def get_image(identifier):
    resp = _session.get(
        f"{_keymaster_api}/images/{identifier}",
        headers={"Accept": "application/octet-stream"},
    )
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        if resp.status_code == 404:
            return None
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    metadata = json.loads(resp.headers.get("X-Metadata", "{}"))
    return {
        "file": {
            **metadata.get("file", {}),
            "data": resp.content,
        },
        "image": metadata.get("image"),
    }


def test_image(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/images/{identifier}/test")
    return response["test"]


def create_file(data, options=None):
    if options is None:
        options = {}
    headers = {"Content-Type": "application/octet-stream"}
    if options:
        headers["X-Options"] = json.dumps(options)
    resp = _session.post(f"{_keymaster_api}/files", data=data, headers=headers)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    return resp.json()["did"]


def create_file_stream(data, options=None):
    return create_file(data, options)


def update_file(identifier, data, options=None):
    if options is None:
        options = {}
    headers = {"Content-Type": "application/octet-stream"}
    if options:
        headers["X-Options"] = json.dumps(options)
    resp = _session.put(f"{_keymaster_api}/files/{identifier}", data=data, headers=headers)
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    return resp.json()["ok"]


def update_file_stream(identifier, data, options=None):
    return update_file(identifier, data, options)


def get_file(identifier):
    resp = _session.get(
        f"{_keymaster_api}/files/{identifier}",
        headers={"Accept": "application/octet-stream"},
    )
    try:
        resp.raise_for_status()
    except requests.HTTPError:
        if resp.status_code == 404:
            return None
        raise KeymasterError(f"Error {resp.status_code}: {resp.text}")
    metadata = json.loads(resp.headers.get("X-Metadata", "{}"))
    return {
        **metadata,
        "data": resp.content,
    }


def test_file(identifier):
    response = proxy_request("POST", f"{_keymaster_api}/files/{identifier}/test")
    return response["test"]


# Wallet extras

def change_passphrase(passphrase):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/wallet/passphrase",
        json={"passphrase": passphrase},
    )
    return response["ok"]


def export_encrypted_wallet():
    response = proxy_request("GET", f"{_keymaster_api}/export/wallet/encrypted")
    return response["wallet"]


# DID updates

def update_did(identifier, doc):
    response = proxy_request(
        "PUT",
        f"{_keymaster_api}/did/{identifier}",
        json={"doc": doc},
    )
    return response["ok"]


# Asset management

def create_asset(data, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/assets",
        json={"data": data, "options": options},
    )
    return response["did"]


def list_assets():
    response = proxy_request("GET", f"{_keymaster_api}/assets")
    return response["assets"]


def clone_asset(identifier, options=None):
    if options is None:
        options = {}
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/assets/{identifier}/clone",
        json={"options": options},
    )
    return response["did"]


def merge_data(identifier, data):
    response = proxy_request(
        "PUT",
        f"{_keymaster_api}/assets/{identifier}",
        json={"data": data},
    )
    return response["ok"]


def transfer_asset(identifier, controller):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/assets/{identifier}/transfer",
        json={"controller": controller},
    )
    return response["ok"]


# Poll extras

def send_poll(poll):
    response = proxy_request("POST", f"{_keymaster_api}/polls/{poll}/send")
    return response["did"]


def send_ballot(ballot, poll):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/polls/ballot/send",
        json={"ballot": ballot, "poll": poll},
    )
    return response["did"]


def view_ballot(did):
    response = proxy_request("GET", f"{_keymaster_api}/polls/ballot/{did}")
    return response["ballot"]


def add_poll_voter(poll, member_id):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/polls/{poll}/voters",
        json={"memberId": member_id},
    )
    return response["ok"]


def remove_poll_voter(poll, voter):
    safe = requests.utils.quote(str(voter), safe="")
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/polls/{poll}/voters/{safe}",
    )
    return response["ok"]


def list_poll_voters(poll):
    response = proxy_request("GET", f"{_keymaster_api}/polls/{poll}/voters")
    return response["voters"]


# Nostr

def add_nostr(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/nostr",
        json={"id": id},
    )
    return response


def import_nostr(nsec, id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/nostr/import",
        json={"nsec": nsec, "id": id},
    )
    return response


def remove_nostr(id=None):
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/nostr",
        json={"id": id},
    )
    return response["ok"]


def export_nsec(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/nostr/nsec",
        json={"id": id},
    )
    return response["nsec"]


def sign_nostr_event(event):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/nostr/sign",
        json={"event": event},
    )
    return response


# Lightning

def add_lightning(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning",
        json={"id": id},
    )
    return response


def remove_lightning(id=None):
    response = proxy_request(
        "DELETE",
        f"{_keymaster_api}/lightning",
        json={"id": id},
    )
    return response["ok"]


def get_lightning_balance(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/balance",
        json={"id": id},
    )
    return response


def create_lightning_invoice(amount, memo, id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/invoice",
        json={"amount": amount, "memo": memo, "id": id},
    )
    return response


def pay_lightning_invoice(bolt11, id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/pay",
        json={"bolt11": bolt11, "id": id},
    )
    return response


def check_lightning_payment(payment_hash, id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/payment",
        json={"paymentHash": payment_hash, "id": id},
    )
    return response


def decode_lightning_invoice(bolt11):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/decode",
        json={"bolt11": bolt11},
    )
    return response


def publish_lightning(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/publish",
        json={"id": id},
    )
    return response["ok"]


def unpublish_lightning(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/unpublish",
        json={"id": id},
    )
    return response["ok"]


def zap_lightning(did, amount, memo=None, id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/zap",
        json={"did": did, "amount": amount, "memo": memo, "id": id},
    )
    return response


def get_lightning_payments(id=None):
    response = proxy_request(
        "POST",
        f"{_keymaster_api}/lightning/payments",
        json={"id": id},
    )
    return response["payments"]
