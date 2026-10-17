// DEPRECATED: replaced by src/cart.js. Nothing imports this file any more.
export function calcTotal(items) {
  let t = 0;
  for (const i of items) t += i.price * i.qty;
  return t;
}
