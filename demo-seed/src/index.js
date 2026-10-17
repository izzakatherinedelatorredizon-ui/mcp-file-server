import { calcTotal, itemCount } from "./cart.js";
import { printReport } from "./report.js";

const items = [
  { name: "pen", price: 1.5, qty: 4 },
  { name: "notebook", price: 3.25, qty: 2 },
];

console.log(`Items: ${itemCount(items)}`);
console.log(`Total: ${calcTotal(items).toFixed(2)}`);
printReport(items);
