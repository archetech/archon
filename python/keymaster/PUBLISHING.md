# Publishing archon-keymaster

This package publishes the Python Keymaster library and the `keymaster` CLI as
the `archon-keymaster` distribution on PyPI.

Do not upload to TestPyPI or PyPI unless the release owner explicitly asks for
publication.

## GitHub Actions

Use the manual `Publish Python Keymaster to PyPI` workflow for routine
publishing. The workflow builds from `python/keymaster`, runs `twine check`,
smoke tests the CLI parser, and then either stops after checks, publishes to
TestPyPI, or publishes to PyPI.

Production PyPI publishing uses PyPI trusted publishing and the GitHub
`production` environment so release owners can require approval before upload.
The TestPyPI path uses the `testpypi` environment and installs the just-published
version back from TestPyPI before passing.

Configure PyPI trusted publishers for:

- workflow: `.github/workflows/python-keymaster-publish.yml`
- environment: `production` for PyPI
- environment: `testpypi` for TestPyPI

## Manual Preflight

```bash
python3 -m venv /tmp/archon-keymaster-publish
/tmp/archon-keymaster-publish/bin/python -m pip install --upgrade pip build twine
/tmp/archon-keymaster-publish/bin/python -m build --outdir /tmp/archon-keymaster-dist
/tmp/archon-keymaster-publish/bin/python -m twine check /tmp/archon-keymaster-dist/*
```

Verify the distribution name and version are available before uploading:

```bash
/tmp/archon-keymaster-publish/bin/python -m pip index versions archon-keymaster
```

## TestPyPI

```bash
/tmp/archon-keymaster-publish/bin/python -m twine upload \
  --repository testpypi \
  /tmp/archon-keymaster-dist/*
```

Then install into a clean environment and smoke test:

```bash
python3 -m venv /tmp/archon-keymaster-install-test
/tmp/archon-keymaster-install-test/bin/python -m pip install \
  --index-url https://test.pypi.org/simple/ \
  --extra-index-url https://pypi.org/simple/ \
  archon-keymaster
/tmp/archon-keymaster-install-test/bin/keymaster --help
/tmp/archon-keymaster-install-test/bin/python - <<'PY'
import argparse
from keymaster.cli import build_parser

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
PY
```

## PyPI

Only publish to PyPI after the TestPyPI smoke test passes.

```bash
/tmp/archon-keymaster-publish/bin/python -m twine upload /tmp/archon-keymaster-dist/*
```
