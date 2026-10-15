import fs from "node:fs/promises";

import { normalisePayload } from "../src/payload";
import { runAgent } from "../src/runner";

const file = process.argv[2] ?? "payload.example.json";
const mutate = process.argv.includes("--mutate");
const raw = JSON.parse(await fs.readFile(file, "utf8"));
const payload = normalisePayload(raw);
const jobId = `cli-${Date.now()}`;

const report = await runAgent({
  jobId,
  payload,
  mutate,
  emit: (event) => console.log(JSON.stringify(event)),
});

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "success" ? 0 : 1;
