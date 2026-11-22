import { useEffect, useState } from 'react';
import { getOrder } from '@/api/client';

export default function Account({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<{ total: string; status: string } | null>(null);

  useEffect(() => {
    getOrder(orderId).then(setOrder);
  }, [orderId]);

  if (!order) return <p>Загрузка…</p>;
  return (
    <section>
      <h1>Заказ №{orderId}</h1>
      <p>{order.total} · {order.status}</p>
    </section>
  );
}
