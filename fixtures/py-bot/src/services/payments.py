import os

import httpx

PAY_API = "https://pay.example.com/v1/links"


async def create_link(order):
    async with httpx.AsyncClient() as client:
        response = await client.post(
            PAY_API,
            json={"order_id": order.id, "amount": order.total},
            headers={"Authorization": f"Bearer {os.environ['PAY_TOKEN']}"},
        )
        response.raise_for_status()
        return response.json()["url"]
