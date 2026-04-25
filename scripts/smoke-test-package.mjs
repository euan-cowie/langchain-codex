import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = mkdtempSync(join(tmpdir(), "langchain-codex-smoke-"));
const packDir = join(tempDir, "pack");
const installDir = join(tempDir, "install");

mkdirSync(packDir);
mkdirSync(installDir);

try {
  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: rootDir,
    stdio: "inherit",
  });

  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));

  if (tarball === undefined) {
    throw new Error("npm pack did not produce a tarball.");
  }

  execFileSync("npm", ["init", "-y"], {
    cwd: installDir,
    stdio: "ignore",
  });

  execFileSync("npm", ["install", "@langchain/core", "zod"], {
    cwd: installDir,
    stdio: "inherit",
  });

  execFileSync("npm", ["install", join(packDir, tarball)], {
    cwd: installDir,
    stdio: "inherit",
  });

  execFileSync(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        'import { ChatCodexSDK, convertMessagesToCodexInput } from "langchain-codex";',
        'if (typeof ChatCodexSDK !== "function") throw new Error("ChatCodexSDK export missing");',
        'if (typeof convertMessagesToCodexInput !== "function") throw new Error("message helper export missing");',
        'console.log("Package smoke test passed");',
      ].join("\n"),
    ],
    {
      cwd: installDir,
      stdio: "inherit",
    },
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
