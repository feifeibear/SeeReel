import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const maxFileBytes = 750_000;
const ignoredPathParts = new Set(["node_modules", "dist", ".git", "data", "media", ".cache"]);
const ignoredExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".sqlite",
  ".db",
]);

type Finding = {
  file: string;
  line: number;
  reason: string;
};

const explicitSecretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/, "private key block"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "GitHub fine-grained token"],
  [/\bsk-(?:live|test|proj)?-[A-Za-z0-9_-]{20,}\b/, "OpenAI-style API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bAKLT[A-Za-z0-9_-]{16,}\b/, "Volcengine-style access key"],
];

const assignmentPattern = /\b([A-Za-z0-9_.-]+)\b\s*[:=]\s*["']([^"']{12,})["']/g;

const safeValueHints = [
  "example",
  "placeholder",
  "dummy",
  "sample",
  "test",
  "smoke",
  "local",
  "changeme",
  "change-me",
  "redacted",
  "your-",
  "<",
  "$",
  "***",
];

function listGitCandidateFiles() {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !shouldIgnorePath(file));
}

function shouldIgnorePath(file: string) {
  const parts = file.split("/");
  if (parts.some((part) => ignoredPathParts.has(part))) return true;
  const lower = file.toLowerCase();
  for (const ext of ignoredExtensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isSafeExampleValue(value: string) {
  const lower = value.toLowerCase();
  return safeValueHints.some((hint) => lower.includes(hint));
}

function isSecretLikeName(name: string) {
  const lower = name.toLowerCase();
  if (/(placeholder|storage[_-]?key|label|title|hint|help|message|copy|text|prompt)$/.test(lower)) return false;
  if (/(password|passwd|token|secret|api[_-]?key|access[_-]?key|secret[_-]?key)/.test(lower)) return true;

  const parts = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.includes("ak") || parts.includes("sk");
}

function lineNumberFor(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

const findings: Finding[] = [];

for (const file of listGitCandidateFiles()) {
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) continue;
  const stat = statSync(abs);
  if (!stat.isFile() || stat.size > maxFileBytes) continue;

  const text = readFileSync(abs, "utf8");

  for (const [pattern, reason] of explicitSecretPatterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      findings.push({ file, line: lineNumberFor(text, match.index ?? 0), reason });
    }
  }

  for (const match of text.matchAll(assignmentPattern)) {
    const name = match[1];
    const value = match[2];
    if (!isSecretLikeName(name)) continue;
    if (isSafeExampleValue(value)) continue;
    findings.push({
      file,
      line: lineNumberFor(text, match.index ?? 0),
      reason: `hard-coded secret-like assignment to ${name}`,
    });
  }
}

if (findings.length > 0) {
  console.error("secret smoke failed; do not commit AK/SK, tokens, passwords, API keys, or private keys");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log("secret smoke passed");
