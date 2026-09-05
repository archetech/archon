"""Startup validation of ARCHON_ADMIN_API_KEY.

Mirrors the TypeScript service's `keymaster admin key startup check` suite, so
the two flavors refuse and warn on the same configurations.
"""

from keymaster_service.admin import (
    MIN_ADMIN_API_KEY_LENGTH,
    check_admin_api_key,
    check_passphrase,
    check_wallet_store,
)


def test_unset_key_is_fatal():
    result = check_admin_api_key("")

    assert result.fatal is not None
    assert "ARCHON_ADMIN_API_KEY must be set" in result.fatal
    assert "openssl rand -hex 32" in result.fatal
    assert result.warning is None


def test_short_key_warns_but_starts():
    result = check_admin_api_key("short-key")

    assert result.fatal is None
    assert f"shorter than {MIN_ADMIN_API_KEY_LENGTH}" in result.warning


def test_key_at_minimum_length_is_accepted_silently():
    result = check_admin_api_key("a" * MIN_ADMIN_API_KEY_LENGTH)

    assert result.fatal is None
    assert result.warning is None


def test_unset_passphrase_is_fatal():
    result = check_passphrase("")

    assert result.fatal is not None
    assert "ARCHON_ENCRYPTED_PASSPHRASE must be set" in result.fatal


def test_any_non_empty_passphrase_is_accepted():
    assert check_passphrase("correct horse battery staple").fatal is None


def test_secret_matches_handles_non_ascii_and_non_str():
    """compare_digest raises TypeError on non-ASCII str, and a request body can
    carry any JSON type — either would turn a 401 into a 500."""
    from keymaster_service.app import _secret_matches

    assert _secret_matches("pässwörd", "pässwörd")
    assert not _secret_matches("pässwörd", "other")
    assert not _secret_matches(None, "secret")
    assert not _secret_matches(1234, "secret")


def test_present_wallet_needs_no_decision():
    check = check_wallet_store(missing=False, require_wallet=True, db="redis")

    assert check.fatal is None
    assert check.warning is None


def test_missing_wallet_is_fatal_when_required():
    check = check_wallet_store(missing=True, require_wallet=True, db="redis")

    assert "ARCHON_KEYMASTER_REQUIRE_WALLET" in check.fatal
    assert "redis" in check.fatal
    assert check.warning is None


def test_missing_wallet_warns_when_provisioning_is_allowed():
    check = check_wallet_store(missing=True, require_wallet=False, db="json")

    assert check.fatal is None
    assert "creating one" in check.warning
    assert "ARCHON_KEYMASTER_REQUIRE_WALLET=true" in check.warning
