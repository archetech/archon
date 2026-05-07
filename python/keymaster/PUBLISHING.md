# Publishing archon-keymaster

This package publishes the Python Keymaster library and the `keymaster` CLI as
the `archon-keymaster` distribution on PyPI.

Do not upload to TestPyPI or PyPI unless the release owner explicitly asks for
publication.

## Preflight

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
/tmp/archon-keymaster-install-test/bin/python -c "import argparse; from keymaster.cli import build_parser; p=build_parser(); sp=[a for a in p._actions if isinstance(a, argparse._SubParsersAction)][0]; assert len(sp.choices)==134"
```

## PyPI

Only publish to PyPI after the TestPyPI smoke test passes.

```bash
/tmp/archon-keymaster-publish/bin/python -m twine upload /tmp/archon-keymaster-dist/*
```
