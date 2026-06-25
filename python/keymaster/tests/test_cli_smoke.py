from __future__ import annotations

import argparse

from keymaster.cli import build_parser


def test_cli_parser_builds_with_stable_commands() -> None:
    parser = build_parser()
    subparsers = [
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    ]

    assert subparsers, "CLI parser has no subcommands"

    commands = subparsers[0].choices
    required = {
        "create-id",
        "backup-wallet-file",
        "create-asset",
        "resolve-did",
        "create-vault",
        "add-vault-item",
        "create-dmail",
        "send-dmail",
        "list-registries",
    }

    missing = sorted(required - commands.keys())
    assert not missing, f"Missing expected commands: {', '.join(missing)}"
