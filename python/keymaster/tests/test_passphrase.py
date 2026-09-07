"""Where the CLI gets the wallet passphrase (#977).

Exporting it puts a secret that encrypts a wallet holding Lightning funds into
shell history, /proc/<pid>/environ, and every child the shell spawns
afterwards. It stays available for automation, but it is not the only way in
and not what a first-time reader is shown.
"""

from __future__ import annotations

import pytest

from keymaster.cli import missing_passphrase_message, resolve_passphrase


def no_file(path: str) -> str:
    raise AssertionError("no file expected")


def no_prompt(query: str) -> str:
    raise AssertionError("no prompt expected")


def resolve(env, **overrides):
    kwargs = {
        "read_file": no_file,
        "file_exists": lambda _: False,
        "saved_file": "/home/someone/.archon/passphrase",
        "interactive": False,
        "prompt": no_prompt,
    }
    kwargs.update(overrides)
    return resolve_passphrase(env, **kwargs)


def test_environment_comes_first_so_automation_is_unaffected() -> None:
    resolved = resolve({"ARCHON_PASSPHRASE": "from-env"})

    assert resolved == ("from-env", "environment")


def test_older_name_is_still_read() -> None:
    resolved = resolve({"ARCHON_ENCRYPTED_PASSPHRASE": "older"})

    assert resolved == ("older", "environment")


def test_file_is_read_when_the_environment_holds_nothing() -> None:
    seen: list[str] = []

    def read(path: str) -> str:
        seen.append(path)
        return "from-file\n"

    resolved = resolve({"ARCHON_PASSPHRASE_FILE": "/run/secrets/pass"}, read_file=read)

    assert resolved == ("from-file", "file")
    assert seen == ["/run/secrets/pass"]


def test_only_one_trailing_newline_is_removed() -> None:
    # Spaces could be the passphrase.
    resolved = resolve({"ARCHON_PASSPHRASE_FILE": "/f"}, read_file=lambda _: "  two words  \r\n")

    assert resolved[0] == "  two words  "


def test_unreadable_file_raises_rather_than_prompting() -> None:
    # A path that is wrong is an error, not an invitation to type something
    # else -- silently prompting would let a typo mint a different wallet.
    def read(path: str) -> str:
        raise FileNotFoundError(path)

    with pytest.raises(FileNotFoundError):
        resolve({"ARCHON_PASSPHRASE_FILE": "/missing"}, read_file=read, interactive=True, prompt=lambda _: "typed")


def test_saved_file_is_read_before_asking() -> None:
    # Accepting the CLI's offer to save has to end the asking, or every command
    # in a session prompts again -- the convenience exporting it buys.
    asked: list[str] = []

    resolved = resolve(
        {},
        file_exists=lambda path: path == "/home/someone/.archon/passphrase",
        read_file=lambda _: "saved-one\n",
        interactive=True,
        prompt=lambda query: asked.append(query) or "typed",
    )

    assert resolved == ("saved-one", "saved")
    assert asked == []


def test_unreadable_saved_file_raises_as_a_configured_one_does() -> None:
    def read(path: str) -> str:
        raise PermissionError(path)

    with pytest.raises(PermissionError):
        resolve({}, file_exists=lambda _: True, read_file=read, interactive=True, prompt=lambda _: "typed")


def test_refuses_a_file_holding_nothing_but_a_newline() -> None:
    # "" would encrypt a wallet with no secret at all, which Keymaster and
    # encrypt_with_passphrase both accept.
    with pytest.raises(ValueError, match="is empty"):
        resolve(
            {"ARCHON_PASSPHRASE_FILE": "/blank"},
            read_file=lambda _: "\n",
            interactive=True,
            prompt=lambda _: "typed",
        )


def test_refuses_an_empty_saved_file_too() -> None:
    with pytest.raises(ValueError, match="is empty"):
        resolve({}, file_exists=lambda _: True, read_file=lambda _: "", interactive=True, prompt=lambda _: "typed")


def test_asks_when_there_is_someone_to_ask() -> None:
    asked: list[str] = []

    def prompt(query: str) -> str:
        asked.append(query)
        return "typed"

    resolved = resolve({}, interactive=True, prompt=prompt)

    assert resolved == ("typed", "prompt")
    assert len(asked) == 1


def test_does_not_ask_when_nothing_is_attached() -> None:
    # Asking a pipe hangs the script that opened it.
    resolved = resolve({})

    assert resolved is None


def test_empty_answer_is_no_passphrase() -> None:
    resolved = resolve({}, interactive=True, prompt=lambda _: "")

    assert resolved is None


def test_message_never_tells_a_non_interactive_caller_to_answer_a_prompt() -> None:
    lines = " ".join(missing_passphrase_message(False))

    assert "no terminal" in lines
    assert "ARCHON_PASSPHRASE_FILE" in lines


def test_message_does_not_instruct_anyone_to_export_the_secret() -> None:
    # Telling someone to export it teaches the habit this exists to avoid.
    for interactive in (True, False):
        assert "export " not in " ".join(missing_passphrase_message(interactive))
