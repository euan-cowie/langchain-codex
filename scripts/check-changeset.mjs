#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const baseRef = process.env.CHANGESET_BASE_REF ?? githubBaseRef() ?? "origin/main";
const changedFiles = getChangedFiles(baseRef);

if (changedFiles.length === 0) {
  process.exit(0);
}

if (changedFiles.some(isChangesetFile)) {
  process.exit(0);
}

const packageImpactingFiles = changedFiles.filter(isPackageImpactingFile);

if (packageImpactingFiles.length === 0) {
  process.exit(0);
}

console.error(
  [
    "This PR changes published package behavior but does not include a changeset.",
    "",
    "Add one with:",
    "  npm run changeset",
    "",
    "Package-impacting files:",
    ...packageImpactingFiles.map((file) => `  - ${file}`),
  ].join("\n"),
);
process.exit(1);

function githubBaseRef() {
  if (process.env.GITHUB_BASE_REF === undefined || process.env.GITHUB_BASE_REF.length === 0) {
    return undefined;
  }

  return `origin/${process.env.GITHUB_BASE_REF}`;
}

function getChangedFiles(ref) {
  const mergeBase = getMergeBase(ref);
  const diffBase = mergeBase ?? ref;

  return git(["diff", "--name-only", `${diffBase}...HEAD`])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function getMergeBase(ref) {
  try {
    return git(["merge-base", "HEAD", ref]).trim();
  } catch {
    return undefined;
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function isChangesetFile(file) {
  return file.startsWith(".changeset/") && file.endsWith(".md") && file !== ".changeset/README.md";
}

function isPackageImpactingFile(file) {
  if (file.startsWith(".changeset/")) {
    return false;
  }

  if (
    file.startsWith(".github/") ||
    file.startsWith("test/") ||
    file === "AGENTS.md" ||
    file === "CODE_OF_CONDUCT.md" ||
    file === "CONTRIBUTING.md" ||
    file === "FINDINGS.md" ||
    file === "PARITY_ROADMAP.md" ||
    file === "RELEASE_CHECKLIST.md" ||
    file === "SECURITY.md" ||
    file === "TASKS.md" ||
    file === "VERSIONING.md"
  ) {
    return false;
  }

  return true;
}
