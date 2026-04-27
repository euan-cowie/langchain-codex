import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../../scripts/check-changeset.mjs", import.meta.url));
const temporaryRepositories: string[] = [];

describe("check-changeset script", () => {
  afterEach(() => {
    for (const repository of temporaryRepositories.splice(0)) {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it("allows Changesets version PRs that delete consumed changesets", () => {
    const repository = createRepository();
    write(repository, ".changeset/runtime-events.md", '---\n"langchain-codex": minor\n---\n');
    commitAll(repository, "add changeset");
    branch(repository, "version-packages");
    remove(repository, ".changeset/runtime-events.md");
    write(repository, "package.json", '{"name":"langchain-codex","version":"0.3.0"}\n');
    write(repository, "CHANGELOG.md", "# Changelog\n\n## 0.3.0\n\n- Runtime events.\n");
    commitAll(repository, "version packages");

    expect(() => runCheck(repository)).not.toThrow();
  });

  it("rejects package-impacting changes without a changeset", () => {
    const repository = createRepository();
    branch(repository, "feature");
    write(repository, "src/index.ts", "export const changed = true;\n");
    commitAll(repository, "change source");

    expect(() => runCheck(repository)).toThrow(/does not include a changeset/);
  });

  it("allows deleting unpublished planning docs without a changeset", () => {
    const repository = createRepository();
    write(repository, "REMAINING_GAP_PLAN.md", "# Remaining Gap Plan\n");
    commitAll(repository, "add planning doc");
    branch(repository, "remove-plan");
    remove(repository, "REMAINING_GAP_PLAN.md");
    commitAll(repository, "remove planning doc");

    expect(() => runCheck(repository)).not.toThrow();
  });

  it("allows changeset-check script updates without a changeset", () => {
    const repository = createRepository();
    write(repository, "scripts/check-changeset.mjs", "console.log('old');\n");
    commitAll(repository, "add checker script");
    branch(repository, "update-checker");
    write(repository, "scripts/check-changeset.mjs", "console.log('new');\n");
    commitAll(repository, "update checker script");

    expect(() => runCheck(repository)).not.toThrow();
  });
});

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "langchain-codex-changeset-check-"));
  temporaryRepositories.push(repository);

  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "codex@example.com"]);
  git(repository, ["config", "user.name", "Codex"]);
  mkdirSync(join(repository, ".changeset"), { recursive: true });
  mkdirSync(join(repository, "src"), { recursive: true });
  write(repository, ".changeset/README.md", "# Changesets\n");
  write(repository, "package.json", '{"name":"langchain-codex","version":"0.2.0"}\n');
  write(repository, "src/index.ts", "export const unchanged = true;\n");
  commitAll(repository, "initial commit");

  return repository;
}

function write(repository: string, path: string, content: string): void {
  const target = join(repository, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function remove(repository: string, path: string): void {
  rmSync(join(repository, path));
}

function branch(repository: string, name: string): void {
  git(repository, ["checkout", "-b", name]);
}

function commitAll(repository: string, message: string): void {
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", message]);
}

function runCheck(repository: string): void {
  execFileSync("node", [scriptPath], {
    cwd: repository,
    env: {
      ...process.env,
      CHANGESET_BASE_REF: "main",
    },
    encoding: "utf8",
    stdio: "pipe",
  });
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: "pipe",
  });
}
