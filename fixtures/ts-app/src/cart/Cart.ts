import { formatPrice } from '@/utils/format';

export interface CartItem {
  id: string;
  price: number;
  qty: number;
}

export class Cart {
  items: CartItem[] = [];
  promo?: string;

  add(item: CartItem): void {
    const existing = this.items.find((i) => i.id === item.id);
    if (existing) existing.qty += item.qty;
    else this.items.push(item);
  }

  total(): number {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  label(): string {
    return formatPrice(this.total());
  }
}

export const cart = new Cart();
