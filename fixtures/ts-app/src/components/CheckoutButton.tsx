import { checkout } from '@/api/client';
import { cart } from '@/cart/Cart';
import { pluralize } from '../utils/format';

export default function CheckoutButton() {
  const handleCheckout = async () => {
    const { payUrl } = await checkout(cart.items, cart.promo);
    window.location.href = payUrl;
  };

  const count = cart.items.length;
  return (
    <button onClick={handleCheckout}>
      Оформить {count} {pluralize(count, 'товар', 'товаров')} · {cart.label()}
    </button>
  );
}
