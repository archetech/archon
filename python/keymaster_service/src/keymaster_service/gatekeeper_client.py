from __future__ import annotations

import asyncio
from typing import Any

import httpx


class GatekeeperClient:
    def __init__(self, base_url: str):
        api = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=f"{api}/api/v1", timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def connect(self, wait_until_ready: bool = True, interval_seconds: int = 5) -> None:
        if not wait_until_ready:
            return
        while True:
            try:
                if await self.is_ready():
                    return
            except Exception:
                pass
            await asyncio.sleep(interval_seconds)

    async def is_ready(self) -> bool:
        response = await self._client.get("/ready")
        response.raise_for_status()
        return bool(response.json())

    async def list_registries(self) -> list[str]:
        response = await self._client.get("/registries")
        response.raise_for_status()
        return response.json()

    async def create_did(self, operation: dict[str, Any]) -> str:
        response = await self._client.post("/did", json=operation)
        response.raise_for_status()
        return response.json()

    async def resolve_did(self, did: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        response = await self._client.get(f"/did/{did}", params=options or {})
        response.raise_for_status()
        return response.json()

    async def update_did(self, operation: dict[str, Any]) -> bool:
        response = await self._client.post("/did", json=operation)
        response.raise_for_status()
        return bool(response.json())

    async def delete_did(self, operation: dict[str, Any]) -> bool:
        response = await self._client.post("/did", json=operation)
        response.raise_for_status()
        return bool(response.json())

    async def get_block(self, registry: str, block: str | None = None) -> dict[str, Any] | None:
        path = f"/block/{registry}/{block}" if block else f"/block/{registry}/latest"
        response = await self._client.get(path)
        response.raise_for_status()
        return response.json()
