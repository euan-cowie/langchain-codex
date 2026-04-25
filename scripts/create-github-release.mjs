import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const target = process.env.GITHUB_SHA ?? "HEAD";

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Could not read package version from package.json.");
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

if (token === undefined || token.length === 0) {
  throw new Error("GH_TOKEN or GITHUB_TOKEN is required to create a GitHub release.");
}

try {
  execFileSync("gh", ["release", "view", tag], {
    env: { ...process.env, GH_TOKEN: token },
    stdio: "ignore",
  });
  console.log(`GitHub release ${tag} already exists; skipping.`);
  process.exit(0);
} catch {
  // Missing release is the expected path for a newly published version.
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const notes = extractChangelogSection(changelog, version) ?? `Release ${tag}.`;
const notesDirectory = mkdtempSync(join(tmpdir(), "langchain-codex-release-"));
const notesFile = join(notesDirectory, `${tag}.md`);

writeFileSync(notesFile, `${notes.trim()}\n`);

execFileSync(
  "gh",
  ["release", "create", tag, "--target", target, "--title", tag, "--notes-file", notesFile],
  {
    env: { ...process.env, GH_TOKEN: token },
    stdio: "inherit",
  },
);

function extractChangelogSection(changelogText, releaseVersion) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((line) => isVersionHeading(line, releaseVersion));

  if (start === -1) {
    return undefined;
  }

  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  const sectionLines = lines.slice(start + 1, end === -1 ? undefined : end);
  const section = sectionLines.join("\n").trim();

  return section.length > 0 ? section : undefined;
}

function isVersionHeading(line, releaseVersion) {
  const escaped = escapeRegExp(releaseVersion);
  const pattern = new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`);

  return pattern.test(line.trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
