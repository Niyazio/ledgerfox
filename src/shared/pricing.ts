/** Price-list rules shared by the server (POS price lock) and the forms (default rate). Amounts in minor units. */
export interface PriceList { id: string; name: string; adjust_bp: number }
export interface PriceBreak { item_id: string; min_qty_milli: number; price: number }

/**
 * The rate for `qtyMilli` of an item: the list's own price with the highest quantity break not above the quantity,
 * else the selling price adjusted by the list's percentage, else the selling price.
 */
export function listPrice(salePrice: number, list: PriceList | null, breaks: PriceBreak[], itemId: string, qtyMilli: number): number {
  if (!list) return salePrice;
  const own = breaks.filter((b) => b.item_id === itemId && b.min_qty_milli <= Math.max(qtyMilli, 0)).sort((a, b) => b.min_qty_milli - a.min_qty_milli)[0];
  if (own) return own.price;
  return Math.round((salePrice * (10_000 + list.adjust_bp)) / 10_000);
}
