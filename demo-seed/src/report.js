import { calcTotal } from "./cart.js";

export function printReport(items) {
  const total = calcTotal(items);
  console.log(`Report: ${items.length} line(s), total ${total.toFixed(2)}`);
}
