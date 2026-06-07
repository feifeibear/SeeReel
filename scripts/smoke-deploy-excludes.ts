import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../deploy/deploy-to-ecs.sh", import.meta.url), "utf8");
const requiredExcludes = [
  ["--exclude 'outputs'", "--exclude 'outputs/'"],
  ["--exclude 'assets/generated'", "--exclude 'assets/generated/'"],
  ["--exclude 'assets/references'", "--exclude 'assets/references/'"],
  ["--exclude '.vscode'", "--exclude '.vscode/'"]
];

for (const patterns of requiredExcludes) {
  if (!patterns.some((pattern) => source.includes(pattern))) {
    throw new Error(`deploy rsync must include one of: ${patterns.join(", ")}`);
  }
}

console.log("deploy exclude smoke passed");
