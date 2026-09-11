from __future__ import annotations

from dataclasses import dataclass

# Minimum length we accept for ARCHON_ADMIN_API_KEY. Below this we warn but
# still start -- an existing deployment with a short key should not be bricked
# by an upgrade. `openssl rand -hex 32` (the documented generator) yields 64.
MIN_ADMIN_API_KEY_LENGTH = 32


@dataclass
class StartupCheck:
    # Set when the key is unusable and the process must not start.
    fatal: str | None = None
    # Set when the key works but is weak enough to be worth flagging.
    warning: str | None = None


def check_admin_api_key(admin_api_key: str) -> StartupCheck:
    """Validate ARCHON_ADMIN_API_KEY at startup.

    Fail closed: the guard covers the entire v1 router, not an admin subset, so
    an unset key leaves wallet, identity, credential and Lightning operations
    reachable by anyone who can open the port. Mirrors the TypeScript service's
    checkAdminApiKey, and gatekeeper's, so the two flavors refuse the same
    configurations.
    """
    if not admin_api_key:
        return StartupCheck(
            fatal=(
                "ARCHON_ADMIN_API_KEY must be set — the API would otherwise be "
                "unauthenticated. Generate one with: openssl rand -hex 32"
            )
        )

    if len(admin_api_key) < MIN_ADMIN_API_KEY_LENGTH:
        return StartupCheck(
            warning=(
                f"Warning: ARCHON_ADMIN_API_KEY is shorter than {MIN_ADMIN_API_KEY_LENGTH} "
                "characters — regenerate it with: openssl rand -hex 32"
            )
        )

    return StartupCheck()


def check_passphrase(
    passphrase: str, from_old_name: bool = False, shadowed: bool = False
) -> StartupCheck:
    """Validate ARCHON_PASSPHRASE at startup.

    Fail closed: the passphrase is both the wallet's encryption secret and the
    credential POST /login checks before handing back the admin API key. An
    empty one made /login return that key to any caller, and /login sits ahead
    of the admin guard because it is how a client obtains the key.

    ARCHON_ENCRYPTED_PASSPHRASE is the older name for the same secret and is
    still read; a node using it is told which name supersedes it (#1020).
    """
    if not passphrase:
        return StartupCheck(
            fatal=(
                "ARCHON_PASSPHRASE must be set — POST /login would otherwise "
                "return the admin API key without checking it. The older name "
                "ARCHON_ENCRYPTED_PASSPHRASE is read too."
            )
        )

    # Both names set to different values means one of them is wrong, and
    # nothing here can tell which. Worth saying out loud because the usual
    # cause is invisible: ``docker compose`` substitutes an exported shell
    # variable in preference to the same name in .env, so a stale export can
    # displace a correct file without either being edited (#1121).
    if shadowed:
        return StartupCheck(
            warning="\n".join(
                [
                    "Warning: ARCHON_PASSPHRASE and ARCHON_ENCRYPTED_PASSPHRASE hold "
                    "different values, and the wallet is encrypted with only one of them.",
                    "ARCHON_PASSPHRASE is the one in use. If the wallet does not open, an "
                    "exported shell variable may be displacing the value in .env:",
                    "  env | grep -c '^ARCHON_PASSPHRASE='              # 1 means this shell exports it, and compose prefers that",
                    "  env -u ARCHON_PASSPHRASE docker compose up -d    # ignores the export for one run",
                ]
            )
        )

    if from_old_name:
        return StartupCheck(
            warning=(
                "Warning: ARCHON_ENCRYPTED_PASSPHRASE holds the wallet passphrase under "
                "its older name. ARCHON_PASSPHRASE is the name the CLIs, the lightning "
                "scripts and the MCP server read, so one value under that name serves "
                "everything. The old name still works."
            )
        )

    return StartupCheck()


def wrong_passphrase_advice(shadowed: bool, from_old_name: bool) -> list[str]:
    """What to print when the stored wallet will not decrypt.

    The failure names neither the value it tried nor where that value came
    from, and the usual cause leaves no trace in any file: ``docker compose``
    resolves ``${ARCHON_PASSPHRASE}`` from an exported shell variable in
    preference to the same name in .env, so a stale export displaces a correct
    file silently. An operator who does not remember exporting it has nothing
    to go on (#1121).
    """
    source = "ARCHON_ENCRYPTED_PASSPHRASE" if from_old_name else "ARCHON_PASSPHRASE"
    lines = [f"The wallet did not decrypt with {source}."]

    if shadowed:
        lines.append(
            "ARCHON_ENCRYPTED_PASSPHRASE holds a different value; the wallet may be "
            "encrypted with that one instead."
        )

    return [
        *lines,
        "A value exported in the shell takes precedence over the same name in .env, so a "
        f"stale export of {source} can displace it without either file changing:",
        f"  env | grep -c '^{source}='   # 1 means this shell exports it, and compose prefers that",
        f"  env -u {source} docker compose up -d   # ignores the export for one run",
    ]
