import path from "node:path";
import { leakScan } from "../src/security";
const dir = path.resolve(process.argv[2] ?? "artifacts");
await leakScan(dir);
console.log(`Leak check passed: ${dir}`);
