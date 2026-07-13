#!/usr/bin/env node
const { execFileSync } = require("node:child_process");

function assertReleaseSnapshot({
  dispatchSha,
  baseSha,
  packageVersion,
  changelog,
  targetVersion,
}) {
  const normalizedDispatchSha = normalizeCommit(dispatchSha, "DISPATCH_SHA");
  const normalizedBaseSha = normalizeCommit(baseSha, "base branch commit");

  if (normalizedBaseSha !== normalizedDispatchSha) {
    throw new Error(
      `Base branch advanced from workflow-dispatch commit ${normalizedDispatchSha} to ${normalizedBaseSha}; start a new CD workflow dispatch from the new head (the Re-run button retains the old commit).`
    );
  }

  if (packageVersion !== targetVersion) {
    throw new Error(
      `Workflow-dispatch commit has package version ${packageVersion}, expected ${targetVersion}; start a new CD workflow dispatch after release metadata lands.`
    );
  }

  const escapedVersion = targetVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const releaseSection = new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, "mu");
  if (!releaseSection.test(changelog)) {
    throw new Error(
      `Workflow-dispatch commit is missing the changelog release section ${targetVersion}; start a new CD workflow dispatch after release metadata lands.`
    );
  }

  return normalizedDispatchSha;
}

function selectReleaseSnapshotFromGit({
  dispatchSha,
  baseBranch,
  packageJsonPath,
  changelogPath,
  targetVersion,
}) {
  validateRepositoryPath(packageJsonPath, "PACKAGE_JSON");
  validateRepositoryPath(changelogPath, "CHANGELOG_PATH");
  if (!baseBranch || /[\s~^:?*[\\]/u.test(baseBranch) || baseBranch.includes("..")) {
    throw new Error("BASE_BRANCH is not a safe Git branch name.");
  }

  const resolvedDispatchSha = git("rev-parse", `${dispatchSha}^{commit}`).trim();
  const baseSha = git("rev-parse", `origin/${baseBranch}^{commit}`).trim();
  const packageJson = JSON.parse(git("show", `${resolvedDispatchSha}:${packageJsonPath}`));
  const changelog = git("show", `${resolvedDispatchSha}:${changelogPath}`);

  return assertReleaseSnapshot({
    dispatchSha: resolvedDispatchSha,
    baseSha,
    packageVersion: packageJson.version,
    changelog,
    targetVersion,
  });
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function normalizeCommit(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(normalized)) {
    throw new Error(`${label} must be a full Git commit identifier.`);
  }
  return normalized;
}

function validateRepositoryPath(value, label) {
  const normalized = String(value ?? "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
}

if (require.main === module) {
  try {
    const selected = selectReleaseSnapshotFromGit({
      dispatchSha: process.env.DISPATCH_SHA,
      baseBranch: process.env.BASE_BRANCH,
      packageJsonPath: process.env.PACKAGE_JSON,
      changelogPath: process.env.CHANGELOG_PATH,
      targetVersion: process.env.TARGET_VERSION,
    });
    process.stdout.write(selected);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertReleaseSnapshot, selectReleaseSnapshotFromGit };
