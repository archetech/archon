from __future__ import annotations

import asyncio
from typing import Any

import httpx


class GatekeeperClient:
    def __init__(self, base_url: str):
        api = base_url.rstrip("/")
        self.url = api
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

    async def search(self, query: dict[str, Any]) -> list[str]:
        response = await self._client.post("/query", json=query)
        response.raise_for_status()
        return response.json()

    async def add_data(self, data: bytes) -> str:
        response = await self._client.post(
            "/ipfs/data",
            content=data,
            headers={"Content-Type": "application/octet-stream"},
        )
        response.raise_for_status()
        return response.text

    async def get_data(self, cid: str) -> bytes | None:
        response = await self._client.get(f"/ipfs/data/{cid}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.content

    async def add_text(self, text: str) -> str:
        response = await self._client.post(
            "/ipfs/text",
            content=text,
            headers={"Content-Type": "text/plain"},
        )
        response.raise_for_status()
        return response.text

    async def get_text(self, cid: str) -> str | None:
        response = await self._client.get(f"/ipfs/text/{cid}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.text

    async def create_lightning_wallet(self, name: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/wallet", json={"name": name})
        response.raise_for_status()
        return response.json()

    async def get_lightning_balance(self, invoice_key: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/balance", json={"invoiceKey": invoice_key})
        response.raise_for_status()
        return response.json()

    async def create_lightning_invoice(self, invoice_key: str, amount: int, memo: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/invoice", json={"invoiceKey": invoice_key, "amount": amount, "memo": memo})
        response.raise_for_status()
        return response.json()

    async def pay_lightning_invoice(self, admin_key: str, bolt11: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/pay", json={"adminKey": admin_key, "bolt11": bolt11})
        response.raise_for_status()
        return response.json()

    async def check_lightning_payment(self, invoice_key: str, payment_hash: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/payment", json={"invoiceKey": invoice_key, "paymentHash": payment_hash})
        response.raise_for_status()
        return response.json()

    async def publish_lightning(self, did: str, invoice_key: str) -> dict[str, Any]:
        response = await self._client.post("/lightning/publish", json={"did": did, "invoiceKey": invoice_key})
        response.raise_for_status()
        return response.json()

    async def unpublish_lightning(self, did: str) -> bool:
        response = await self._client.delete(f"/lightning/publish/{did}")
        response.raise_for_status()
        return bool(response.json().get("ok"))

    async def zap_lightning(self, admin_key: str, did: str, amount: int, memo: str | None = None) -> dict[str, Any]:
        response = await self._client.post("/lightning/zap", json={"adminKey": admin_key, "did": did, "amount": amount, "memo": memo})
        response.raise_for_status()
        return response.json()

    async def get_lightning_payments(self, admin_key: str) -> list[dict[str, Any]]:
        response = await self._client.post("/lightning/payments", json={"adminKey": admin_key})
        response.raise_for_status()
        data = response.json()
        return data.get("payments", [])
