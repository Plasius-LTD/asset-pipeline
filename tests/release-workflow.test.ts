import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertReleaseSnapshot } = require("../scripts/select-release-snapshot.cjs") as {
  assertReleaseSnapshot(input: {
    dispatchSha: string;
    baseSha: string;
    packageVersion: string;
    changelog: string;
    targetVersion: string;
  }): string;
};

const temporaryDirectories: string[] = [];
const RELEASE_PROCESS_TIMEOUT_MS = 10_000;
const RELEASE_INTEGRATION_TEST_TIMEOUT_MS = 20_000;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("release snapshot selection", () => {
  it("selects the dispatch commit only when version and changelog are bound to it", () => {
    const dispatchSha = "a".repeat(40);

    expect(
      assertReleaseSnapshot({
        dispatchSha,
        baseSha: dispatchSha,
        packageVersion: "0.3.0",
        changelog: "## [0.3.0] - 2026-07-13\n",
        targetVersion: "0.3.0",
      })
    ).toBe(dispatchSha);
  });

  it("rejects a base branch that advances after workflow dispatch", () => {
    expect(() =>
      assertReleaseSnapshot({
        dispatchSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        packageVersion: "0.3.0",
        changelog: "## [0.3.0] - 2026-07-13\n",
        targetVersion: "0.3.0",
      })
    ).toThrow(/advanced from workflow-dispatch commit/u);
  });

  it("rejects release metadata absent from the dispatch commit", () => {
    const dispatchSha = "a".repeat(40);

    expect(() =>
      assertReleaseSnapshot({
        dispatchSha,
        baseSha: dispatchSha,
        packageVersion: "0.2.0",
        changelog: "## [Unreleased]\n",
        targetVersion: "0.3.0",
      })
    ).toThrow(/package version 0\.2\.0/u);
  });

  it("rejects a missing target-version changelog section", () => {
    const dispatchSha = "a".repeat(40);

    expect(() =>
      assertReleaseSnapshot({
        dispatchSha,
        baseSha: dispatchSha,
        packageVersion: "0.3.0",
        changelog: "## Unreleased\n",
        targetVersion: "0.3.0",
      })
    ).toThrow(/missing the changelog release section 0\.3\.0/u);
  });

  it("routes publication through an exact-main second workflow dispatch", async () => {
    const cdWorkflow = await readFile(
      new URL("../.github/workflows/cd.yml", import.meta.url),
      "utf8"
    );
    const workflow = await readFile(
      new URL("../.github/workflows/release-prepare.yml", import.meta.url),
      "utf8"
    );

    expect(cdWorkflow).toContain('"phase": "publish"');
    expect(cdWorkflow).toContain('"ref": "main"');
    expect(cdWorkflow).toContain("expected_commit_sha");
    expect(cdWorkflow).toContain("actions/workflows/cd.yml/dispatches");
    expect(workflow).toContain("COMMIT_SHA=$(git rev-parse HEAD)");
    expect(workflow).not.toContain(
      'COMMIT_SHA=$(git log -n 1 --format=%H -- "${PACKAGE_JSON}")'
    );
  });

  it("accepts only the new dispatch after release metadata lands", () => {
    const firstDispatch = "a".repeat(40);
    const preparedRelease = "b".repeat(40);

    expect(() =>
      assertReleaseSnapshot({
        dispatchSha: firstDispatch,
        baseSha: preparedRelease,
        packageVersion: "0.2.0",
        changelog: "## Unreleased\n",
        targetVersion: "0.3.0",
      })
    ).toThrow(/start a new CD workflow dispatch/u);

    expect(
      assertReleaseSnapshot({
        dispatchSha: preparedRelease,
        baseSha: preparedRelease,
        packageVersion: "0.3.0",
        changelog: "## [0.3.0] - 2026-07-13\n",
        targetVersion: "0.3.0",
      })
    ).toBe(preparedRelease);
  });

  it(
    "runs the workflow selector against immutable Git objects",
    async () => {
      const repository = await mkdtemp(join(tmpdir(), "asset-pipeline-release-"));
      temporaryDirectories.push(repository);
      git(repository, "init", "--initial-branch=main");
      git(repository, "config", "user.name", "Release Test");
      git(repository, "config", "user.email", "release-test@example.invalid");
      await writeFile(join(repository, "package.json"), '{"version":"0.3.0"}\n');
      await writeFile(join(repository, "CHANGELOG.md"), "## [0.3.0] - 2026-07-13\n");
      git(repository, "add", "package.json", "CHANGELOG.md");
      git(repository, "commit", "-m", "prepare release");
      const dispatchSha = git(repository, "rev-parse", "HEAD").trim();
      git(repository, "update-ref", "refs/remotes/origin/main", dispatchSha);

      const script = new URL("../scripts/select-release-snapshot.cjs", import.meta.url);
      const selected = execFileSync(process.execPath, [script.pathname], {
        cwd: repository,
        encoding: "utf8",
        timeout: RELEASE_PROCESS_TIMEOUT_MS,
        env: {
          ...process.env,
          DISPATCH_SHA: dispatchSha,
          BASE_BRANCH: "main",
          PACKAGE_JSON: "package.json",
          CHANGELOG_PATH: "CHANGELOG.md",
          TARGET_VERSION: "0.3.0",
        },
      });

      expect(selected).toBe(dispatchSha);

      await writeFile(join(repository, "README.md"), "concurrent change\n");
      git(repository, "add", "README.md");
      git(repository, "commit", "-m", "advance base");
      const advancedSha = git(repository, "rev-parse", "HEAD").trim();
      git(repository, "update-ref", "refs/remotes/origin/main", advancedSha);

      expect(() =>
        execFileSync(process.execPath, [script.pathname], {
          cwd: repository,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: RELEASE_PROCESS_TIMEOUT_MS,
          env: {
            ...process.env,
            DISPATCH_SHA: dispatchSha,
            BASE_BRANCH: "main",
            PACKAGE_JSON: "package.json",
            CHANGELOG_PATH: "CHANGELOG.md",
            TARGET_VERSION: "0.3.0",
          },
        })
      ).toThrow(/Base branch advanced from workflow-dispatch commit/u);
    },
    RELEASE_INTEGRATION_TEST_TIMEOUT_MS
  );
});

describe("public release policy", () => {
  it("publishes through the production OIDC trusted publisher without token fallbacks", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/cd.yml", import.meta.url),
      "utf8"
    );
    const npmrc = await readFile(new URL("../.npmrc", import.meta.url), "utf8");

    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('npm publish "./${TARBALL}" --ignore-scripts');
    expect(workflow).toContain("Enforce exact-main successful CI");
    expect(workflow).toContain("refs/remotes/origin/main");
    expect(workflow).toContain("-f branch=main");
    expect(workflow).toContain("-f event=push");
    expect(workflow).toContain('-f head_sha="${EXPECTED_SHA}"');
    expect(workflow).toContain('conclusion == "success"');
    expect(workflow).toContain("Verify release runtime");
    expect(workflow).toContain('ACTUAL_NODE%%.*');
    expect(workflow).toContain('"11.5.1"');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
    expect(npmrc).not.toMatch(/_authToken|NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });

  it("keeps trusted CI explicit and prevents untrusted fork execution", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).toContain("runs-on: [self-hosted, Linux, X64]");
    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("fromJSON(vars.");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
  });
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    timeout: RELEASE_PROCESS_TIMEOUT_MS,
  });
}
