import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageName = packageJson.name;
const version = packageJson.version;
const tag = `v${version}`;
const target = process.env.GITHUB_SHA ?? "HEAD";
const npmRegistry = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";

if (typeof packageName !== "string" || packageName.length === 0) {
  throw new Error("Could not read package name from package.json.");
}

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Could not read package version from package.json.");
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

if (token === undefined || token.length === 0) {
  throw new Error("GH_TOKEN or GITHUB_TOKEN is required to create a GitHub release.");
}

verifyPublishedPackage(packageName, version);

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

function verifyPublishedPackage(name, expectedVersion) {
  const timeoutMs = readPositiveIntegerEnv("NPM_RELEASE_VERIFY_TIMEOUT_MS", 120000);
  const intervalMs = readPositiveIntegerEnv("NPM_RELEASE_VERIFY_INTERVAL_MS", 5000);
  const startedAt = Date.now();
  let lastError = `Package ${name}@${expectedVersion} was not found.`;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const publishedVersion = execFileSync(
        "npm",
        ["view", `${name}@${expectedVersion}`, "version", "--registry", npmRegistry],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();

      if (publishedVersion === expectedVersion) {
        console.log(`Verified ${name}@${expectedVersion} is published to npm.`);
        return;
      }

      lastError = `npm returned version ${publishedVersion || "<empty>"}.`;
    } catch (error) {
      lastError = describeCommandError(error);
    }

    sleep(intervalMs);
  }

  throw new Error(
    `Refusing to create ${tag}: ${name}@${expectedVersion} was not visible on npm ` +
      `after ${timeoutMs}ms. Last npm check: ${lastError}`,
  );
}

function readPositiveIntegerEnv(name, fallback) {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer when set.`);
  }

  return parsed;
}

function describeCommandError(error) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr;
    const message = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr);

    if (message.length > 0) {
      return message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isVersionHeading(line, releaseVersion) {
  const escaped = escapeRegExp(releaseVersion);
  const pattern = new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`);

  return pattern.test(line.trim());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
