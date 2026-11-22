import type { CartItem } from '@/cart/Cart';

export interface CheckoutResult {
  orderId: number;
  payUrl: string;
}

export async function checkout(items: CartItem[], promo?: string): Promise<CheckoutResult> {
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, promo }),
  });
  const data = await res.json();
  return { orderId: data.order_id, payUrl: data.pay_url };
}

export const getOrder = async (id: number) => {
  const res = await fetch(`/api/orders/${id}`);
  return res.json();
};
