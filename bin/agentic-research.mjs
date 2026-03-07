#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "src", "index.ts");

try {
  execFileSync("npx", ["tsx", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
