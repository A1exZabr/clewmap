from fastapi import APIRouter

from services.pricing import calc_total, apply_promo
from services import payments
from db import orders_repo

router = APIRouter()


@router.post("/api/checkout")
async def api_checkout(cart):
    total = apply_promo(calc_total(cart.items), cart.promo)
    order = await orders_repo.save(cart, total)
    return {"order_id": order.id, "pay_url": await payments.create_link(order)}


@router.get("/api/orders/{order_id}")
async def api_get_order(order_id: int):
    order = await orders_repo.get(order_id)
    return {"id": order.id, "total": order.total_label(), "status": order.status}
