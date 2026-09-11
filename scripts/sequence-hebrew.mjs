import { sequence } from "hebrew-transliteration";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

const texts = JSON.parse(input || "[]");
if (!Array.isArray(texts)) {
  console.error("expected a JSON array of strings on stdin");
  process.exit(1);
}

const out = texts.map((t) => sequence(String(t)));
process.stdout.write(JSON.stringify(out));
