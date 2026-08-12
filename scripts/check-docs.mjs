import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

const markdownFiles = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(path);
  }
};
walk(repositoryRoot);

const githubSlug = (heading) => heading
  .replace(/<[^>]*>/g, "")
  .replace(/[`*_~]/g, "")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s-]/gu, "")
  .trim()
  .replace(/\s+/g, "-");

const outsideFencedCode = (source) => {
  let fence = null;
  return source.split(/\r?\n/).map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character
        && marker.length >= fence.length
      ) {
        fence = null;
      }
      return "";
    }
    return fence === null ? line : "";
  }).join("\n");
};

const anchorsFor = (path) => {
  const anchors = new Set();
  const counts = new Map();
  for (const line of outsideFencedCode(readFileSync(path, "utf8")).split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = githubSlug(match[2]);
    if (base.length === 0) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
};

const anchorsByFile = new Map(
  markdownFiles.map((path) => [path, anchorsFor(path)]),
);
const failures = [];

const normalizeTarget = (rawTarget) => {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  const titleStart = trimmed.search(/\s+["']/);
  return titleStart === -1 ? trimmed : trimmed.slice(0, titleStart);
};

for (const sourcePath of markdownFiles) {
  const source = outsideFencedCode(readFileSync(sourcePath, "utf8"));
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const target = normalizeTarget(match[1]);
    if (
      target.length === 0
      || target.startsWith("http://")
      || target.startsWith("https://")
      || target.startsWith("mailto:")
    ) {
      continue;
    }

    const hashIndex = target.indexOf("#");
    const filePart = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const anchorPart = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
    let decodedFile;
    let decodedAnchor;
    try {
      decodedFile = decodeURIComponent(filePart);
      decodedAnchor = decodeURIComponent(anchorPart).toLowerCase();
    } catch {
      failures.push(`${relative(repositoryRoot, sourcePath)}: invalid URL encoding in ${target}`);
      continue;
    }

    const resolvedPath = decodedFile.length === 0
      ? sourcePath
      : normalize(resolve(dirname(sourcePath), decodedFile));
    const rootPrefix = `${repositoryRoot}${sep}`;
    if (resolvedPath !== repositoryRoot && !resolvedPath.startsWith(rootPrefix)) {
      failures.push(`${relative(repositoryRoot, sourcePath)}: link leaves repository: ${target}`);
      continue;
    }
    if (!existsSync(resolvedPath)) {
      failures.push(`${relative(repositoryRoot, sourcePath)}: missing target: ${target}`);
      continue;
    }
    if (anchorPart.length === 0 || statSync(resolvedPath).isDirectory()) continue;
    if (!resolvedPath.endsWith(".md")) {
      failures.push(`${relative(repositoryRoot, sourcePath)}: anchor targets a non-Markdown file: ${target}`);
      continue;
    }
    const anchors = anchorsByFile.get(resolvedPath) ?? anchorsFor(resolvedPath);
    if (!anchors.has(decodedAnchor)) {
      failures.push(`${relative(repositoryRoot, sourcePath)}: missing anchor: ${target}`);
    }
  }
}

assert.equal(
  failures.length,
  0,
  `documentation link check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
);
