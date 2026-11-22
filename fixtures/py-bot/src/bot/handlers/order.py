from services.pricing import calc_total, apply_promo
from services import payments
from db import orders_repo
from bot import texts
async def create_order(message, cart):
    total = calc_total(cart.items)
    total = apply_promo(total, cart.promo)
    order = await orders_repo.save(cart, total)
    link = await payments.create_link(order)
    await message.answer(texts.PAY.format(link=link))
    if cart.promo:
        await message.answer(texts.PROMO_APPLIED.format(code=cart.promo))
    return order


@router.callback_query(F.data == "checkout")
async def on_checkout_click(callback, state):
    data = await state.get_data()
    cart = data["cart"]
    await create_order(callback.message, cart)
    await callback.answer()


async def retry_pay(message, order_id):
    order = await orders_repo.get(order_id)
    link = await payments.create_link(order)
    await message.answer(texts.PAY.format(link=link))
