import { existsSync, readFileSync, writeFileSync } from "node:fs";

const count = existsSync(".probe-count") ? Number(readFileSync(".probe-count", "utf8")) : 0;
const next = count + 1;
writeFileSync(".probe-count", String(next));
if (next < 4) {
  console.log(`OK check=${next} node=n2 volume=v9 usage=76%`);
} else {
  console.error("UNHEALTHY event=d-88 node=n2 volume=v9 usage=97%");
  process.exitCode = 2;
}
