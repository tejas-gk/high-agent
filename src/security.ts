import fs from "node:fs/promises";
import path from "node:path";

const PAN = "4111111111111111";
const CVV = "123";

export function redactText(input: string) {
  return input
    .replaceAll(PAN, "[REDACTED_PAN]")
    .replace(/\bCVV\s*[:=]?\s*123\b/gi, "CVV=[REDACTED]");
}

export function safeData(value: unknown): unknown {
  const serialized = JSON.stringify(value);

  if (
    serialized.includes(PAN) ||
    /"(?:cvv|cvc|securityCode)"\s*:/i.test(serialized)
  ) {
    return "[REDACTED_SENSITIVE_DATA]";
  }

  return value;
}

export async function leakScan(dir: string): Promise<boolean> {
  const leaks: string[] = [];

  async function walk(currentPath: string) {
    for (const entry of await fs.readdir(currentPath, {
      withFileTypes: true,
    })) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      const buffer = await fs.readFile(fullPath);
      const text = buffer.toString("utf8");

      if (text.includes(PAN) || text.includes(`"cvv":"${CVV}"`)) {
        leaks.push(fullPath);
      }
    }
  }

  await walk(dir);

  if (leaks.length) {
    throw new Error(`Leak check failed: ${leaks.join(", ")}`);
  }

  return true;
}
