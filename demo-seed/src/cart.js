// Cart helpers.

/** Sum price * quantity for every item. */
export function calcTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function itemCount(items) {
  return items.reduce((n, item) => n + item.qty, 0);
}
