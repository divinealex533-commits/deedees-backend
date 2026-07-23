import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readTable(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeTable(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
}

export const db = {
  users: {
    all: () => readTable("users"),
    save: (rows) => writeTable("users", rows),
  },
  items: {
    all: () => readTable("items"),
    save: (rows) => writeTable("items", rows),
  },
  deposits: {
    all: () => readTable("deposits"),
    save: (rows) => writeTable("deposits", rows),
  },
};
