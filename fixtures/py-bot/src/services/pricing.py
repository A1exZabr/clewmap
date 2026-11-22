from datetime import datetime

from db import promo_repo


def calc_total(items):
    """Сумма корзины без скидок."""
    return sum(item.price * item.qty for item in items)


def is_expired(promo, now=None):
    now = now or datetime.now()
    return promo.expires_at < now


def apply_promo(total, promo):
    if not promo:
        return total
    found = promo_repo.get(promo)
    if found is None or is_expired(found) or found.used >= found.limit:
        return total
    if found.percent:
        return round(total * (100 - found.percent) / 100, 2)
    return max(total - found.amount, 0)
