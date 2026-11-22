from dataclasses import dataclass

_ORDERS = {}


@dataclass
class Order:
    id: int
    user_id: int
    total: float
    status: str = "new"

    def total_label(self):
        return f"{self.total:.2f} ₾"


async def save(cart, total):
    order = Order(id=len(_ORDERS) + 1, user_id=cart.user_id, total=total)
    _ORDERS[order.id] = order
    return order


async def get(order_id):
    return _ORDERS.get(order_id)


async def list_by_user(user_id):
    return [o for o in _ORDERS.values() if o.user_id == user_id]
