from __future__ import annotations

import uvicorn

from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run("keymaster_service.app:app", host=settings.bind_address, port=settings.keymaster_port)


if __name__ == "__main__":
    main()
