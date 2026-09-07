"""Where the CLI gets the wallet passphrase (#977).

The quickstart taught ``export ARCHON_PASSPHRASE=...`` as the only way in, for
a secret that encrypts a wallet holding Lightning funds — into shell history,
/proc/<pid>/environ, and every child the shell spawns after it.
"""

from __future__ import annotations

import pytest

from keymaster.cli import missing_passphrase_message, resolve_passphrase


def no_file(path: str) -> str:
    raise AssertionError("no file expected")


def no_prompt(query: str) -> str:
    raise AssertionError("no prompt expected")


def test_environment_comes_first_so_automation_is_unaffected() -> None:
    resolved = resolve_passphrase(
        {"ARCHON_PASSPHRASE": "from-env"}, read_file=no_file, interactive=False, prompt=no_prompt
    )

    assert resolved == "from-env"


def test_older_name_is_still_read() -> None:
    resolved = resolve_passphrase(
        {"ARCHON_ENCRYPTED_PASSPHRASE": "older"}, read_file=no_file, interactive=False, prompt=no_prompt
    )

    assert resolved == "older"


def test_file_is_read_when_the_environment_holds_nothing() -> None:
    seen: list[str] = []

    def read(path: str) -> str:
        seen.append(path)
        return "from-file\n"

    resolved = resolve_passphrase(
        {"ARCHON_PASSPHRASE_FILE": "/run/secrets/pass"}, read_file=read, interactive=False, prompt=no_prompt
    )

    assert resolved == "from-file"
    assert seen == ["/run/secrets/pass"]


def test_only_one_trailing_newline_is_removed() -> None:
    # Spaces could be the passphrase.
    resolved = resolve_passphrase(
        {"ARCHON_PASSPHRASE_FILE": "/f"},
        read_file=lambda _: "  two words  \r\n",
        interactive=False,
        prompt=no_prompt,
    )

    assert resolved == "  two words  "


def test_unreadable_file_raises_rather_than_prompting() -> None:
    # A path that is wrong is an error, not an invitation to type something
    # else -- silently prompting would let a typo mint a different wallet.
    def read(path: str) -> str:
        raise FileNotFoundError(path)

    with pytest.raises(FileNotFoundError):
        resolve_passphrase(
            {"ARCHON_PASSPHRASE_FILE": "/missing"},
            read_file=read,
            interactive=True,
            prompt=lambda _: "typed",
        )


def test_asks_when_there_is_someone_to_ask() -> None:
    asked: list[str] = []

    def prompt(query: str) -> str:
        asked.append(query)
        return "typed"

    resolved = resolve_passphrase({}, read_file=no_file, interactive=True, prompt=prompt)

    assert resolved == "typed"
    assert len(asked) == 1


def test_does_not_ask_when_nothing_is_attached() -> None:
    # Asking a pipe hangs the script that opened it.
    resolved = resolve_passphrase({}, read_file=no_file, interactive=False, prompt=no_prompt)

    assert resolved is None


def test_empty_answer_is_no_passphrase() -> None:
    resolved = resolve_passphrase({}, read_file=no_file, interactive=True, prompt=lambda _: "")

    assert resolved is None


def test_message_never_tells_a_non_interactive_caller_to_answer_a_prompt() -> None:
    lines = " ".join(missing_passphrase_message(False))

    assert "no terminal" in lines
    assert "ARCHON_PASSPHRASE_FILE" in lines


def test_message_does_not_instruct_anyone_to_export_the_secret() -> None:
    # The old message said "export ARCHON_PASSPHRASE=...", which is the habit
    # this change exists to stop teaching.
    for interactive in (True, False):
        assert "export " not in " ".join(missing_passphrase_message(interactive))
