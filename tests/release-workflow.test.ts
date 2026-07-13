import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release preparation workflow", () => {
  it("publishes the verified base-branch snapshot during an incomplete-release retry", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release-prepare.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).toContain("COMMIT_SHA=$(git rev-parse HEAD)");
    expect(workflow).not.toContain(
      'COMMIT_SHA=$(git log -n 1 --format=%H -- "${PACKAGE_JSON}")'
    );
  });
});
