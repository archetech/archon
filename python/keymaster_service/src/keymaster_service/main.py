from __future__ import annotations

import logging
import sys

import uvicorn

from .admin import check_admin_api_key, check_passphrase
from .config import load_settings


LOGGER = logging.getLogger(__name__)


def main() -> None:
    settings = load_settings()

    # Before uvicorn binds the port, so a refused configuration never reaches a
    # state where requests can be served.
    for check in (check_admin_api_key(settings.admin_api_key), check_passphrase(settings.passphrase)):
        if check.fatal:
            print(check.fatal, file=sys.stderr)
            raise SystemExit(1)

        if check.warning:
            LOGGER.warning(check.warning)

    uvicorn.run("keymaster_service.app:app", host=settings.bind_address, port=settings.keymaster_port)


if __name__ == "__main__":
    main()
