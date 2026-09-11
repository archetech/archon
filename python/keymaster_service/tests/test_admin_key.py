"""Startup validation of ARCHON_ADMIN_API_KEY.

Mirrors the TypeScript service's `keymaster admin key startup check` suite, so
the two flavors refuse and warn on the same configurations.
"""

from keymaster_service.admin import (
    MIN_ADMIN_API_KEY_LENGTH,
    check_admin_api_key,
    check_passphrase,
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
    assert "ARCHON_PASSPHRASE must be set" in result.fatal
    # Someone reading this may have the value under the older name.
    assert "ARCHON_ENCRYPTED_PASSPHRASE" in result.fatal


def test_any_non_empty_passphrase_is_accepted():
    assert check_passphrase("correct horse battery staple").fatal is None


def test_old_name_is_reported_without_refusing_to_start():
    # The old name still works, so the only thing to say is which name to move
    # to -- and it has to start, not stop the service (#1020).
    result = check_passphrase("correct horse battery staple", from_old_name=True)

    assert result.fatal is None
    assert "ARCHON_ENCRYPTED_PASSPHRASE" in (result.warning or "")
    assert "ARCHON_PASSPHRASE" in (result.warning or "")


def test_current_name_reports_nothing():
    assert check_passphrase("correct horse battery staple", from_old_name=False).warning is None


def test_secret_matches_handles_non_ascii_and_non_str():
    """compare_digest raises TypeError on non-ASCII str, and a request body can
    carry any JSON type — either would turn a 401 into a 500."""
    from keymaster_service.app import _secret_matches

    assert _secret_matches("pässwörd", "pässwörd")
    assert not _secret_matches("pässwörd", "other")
    assert not _secret_matches(None, "secret")
    assert not _secret_matches(1234, "secret")


def test_two_names_holding_different_values_are_flagged():
    # Compose resolves ${ARCHON_PASSPHRASE} from an exported shell variable in
    # preference to the same name in .env, so a leftover export displaces a
    # correct file with nothing in either file changed. The wallet then refuses
    # to decrypt and the operator has no trace to follow (#1121).
    result = check_passphrase("from the shell", shadowed=True)

    assert result.fatal is None
    assert "different values" in (result.warning or "")
    assert "exported in the shell" in (result.warning or "")
    # Commands belong in the README, where they are read in context. A service's
    # stderr is the wrong place to maintain them, and the obvious one --
    # docker compose config -- prints the secret into scrollback.
    assert "docker compose" not in (result.warning or "")


def test_two_names_in_agreement_say_nothing():
    assert check_passphrase("correct horse battery staple", shadowed=False).warning is None
