from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from services.pricing import calc_total, apply_promo
from bot import texts


def checkout_keyboard():
    button = InlineKeyboardButton(text="Оформить", callback_data="checkout")
    return InlineKeyboardMarkup(inline_keyboard=[[button]])


async def preview_cart(message, cart):
    total = calc_total(cart.items)
    total = apply_promo(total, cart.promo)
    await message.answer(texts.CART.format(total=total), reply_markup=checkout_keyboard())
