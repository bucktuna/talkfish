#!/usr/bin/env node
/** Copy only the bundled chess corpus. Never reads data/ or account files. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED = new Set(["manifest.json", "positions.json", "patterns.json"]);
const FORBIDDEN = [
  "password",
  "passwordhash",
  "email",
  "audio",
  "transcript",
  "userid",
  "session",
  "apikey",
  "authorization",
  "cookie",
  "secret",
  "dialogue",
  "username",
  "vote",
];

function walk(value, pointer, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${pointer}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.includes(key.toLowerCase())) errors.push(`${pointer}.${key}`);
    walk(child, `${pointer}.${key}`, errors);
  }
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return path.resolve(process.argv[index + 1]);
}

const source = arg("--from");
const dest = arg("--out");
if (path.resolve(source).split(path.sep).includes("data")) {
  console.error("Refusing to export from a data directory.");
  process.exit(1);
}
const names = (await readdir(source)).filter((name) => name.endsWith(".json"));
const unexpected = names.filter((name) => !ALLOWED.has(name));
if (unexpected.length) {
  console.error(`Refusing unexpected corpus files: ${unexpected.join(", ")}`);
  process.exit(1);
}
await mkdir(dest, { recursive: true });
for (const name of names) {
  const text = await readFile(path.join(source, name), "utf8");
  const errors = [];
  walk(JSON.parse(text), name, errors);
  if (errors.length) {
    console.error(`Refusing ${name}: ${errors.join(", ")}`);
    process.exit(1);
  }
  await writeFile(path.join(dest, name), text);
}
console.log(`Exported ${names.length} corpus file(s). Pending contributions were not included.`);
