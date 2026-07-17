import { existsSync, readFileSync, writeFileSync } from "node:fs";

const count = existsSync(".probe-count") ? Number(readFileSync(".probe-count", "utf8")) : 0;
const next = count + 1;
writeFileSync(".probe-count", String(next));
if (next < 3) console.log(`WAITING check=${next}`);
else if (next === 3) console.log("DEGRADED shard=s7 trace=t-41 queue_depth=912");
else console.log("HEALTHY shard=s7 queue_depth=44");
