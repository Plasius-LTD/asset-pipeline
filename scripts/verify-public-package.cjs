#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asset-pipeline-packcheck-"));
  try {
    const output = execFileSync("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryRoot,
      "--cache",
      path.join(temporaryRoot, "npm-cache"),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const parsed = parseNpmPackJson(output);
    const packResult = Array.isArray(parsed) ? parsed[0] : undefined;
    const files = packResult?.files ?? [];
    const paths = files.map((entry) => entry.path);
    const requiredEntrypoints = [
      "dist/index.js",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.d.cts",
      "dist/shader-lifecycle.js",
      "dist/shader-lifecycle.cjs",
      "dist/shader-lifecycle.d.ts",
      "dist/shader-lifecycle.d.cts",
    ];
    const missingEntrypoints = requiredEntrypoints.filter((filePath) => !paths.includes(filePath));
    if (missingEntrypoints.length > 0) {
      throw new Error(`Public package is missing required entrypoints: ${missingEntrypoints.join(", ")}`);
    }

    const forbiddenTarballPathPatterns = [
      /(?:^|\/)plasius-ltd-site(?:\/|$)/iu,
      /(?:^|\/)(frontend|backend|dashboard|infra)(?:\/|$)/iu,
      /(?:^|\/)local\.settings(?:\.[^/]+)?\.json$/iu,
      /(?:^|\/)host\.json$/iu,
      /(?:^|\/)tsp-output(?:\/|$)/iu,
    ];
    const forbiddenPaths = paths.filter((filePath) =>
      forbiddenTarballPathPatterns.some((pattern) => pattern.test(filePath))
    );
    if (forbiddenPaths.length > 0) {
      throw new Error(`Public package contains forbidden paths: ${forbiddenPaths.join(", ")}`);
    }

    verifyNoForbiddenCodeReferences();

    if (typeof packResult?.filename !== "string") {
      throw new Error("npm pack did not return a package filename.");
    }
    const tarballPath = path.join(temporaryRoot, packResult.filename);
    const consumerDirectory = path.join(temporaryRoot, "consumer");
    fs.mkdirSync(consumerDirectory, { recursive: true });
    execFileSync("npm", [
      "install",
      "--prefix",
      consumerDirectory,
      "--ignore-scripts",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--cache",
      path.join(temporaryRoot, "npm-cache"),
      tarballPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    verifyInstalledExportMap(consumerDirectory);
    verifyInstalledTypeScriptBoundaries(consumerDirectory);
    verifyBrowserBoundaries(consumerDirectory);
    verifyNodeEntrypoints(consumerDirectory);
    console.log("Public package check passed.");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyNoForbiddenCodeReferences() {
  const forbiddenCodeReferencePatterns = [
    { label: "private monorepo reference", regex: /\bplasius-ltd-site\b/iu },
    { label: "Plasius Ltd private reference", regex: /\bplasius(?:\s+|-)ltd\b/iu },
    { label: "proprietary PGP artifact reference", regex: /\bpgp[-_a-z0-9]*\b/iu },
    { label: "proprietary Lunari artifact reference", regex: /\blunari\b/iu },
    { label: "proprietary Pixelverse artifact reference", regex: /\bpixelverse\b/iu },
  ];
  const codeRoots = ["src", "tests", "demo"];
  const codeExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
  const violations = scanCodeReferences(
    codeRoots,
    codeExtensions,
    forbiddenCodeReferencePatterns
  );

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `${violation.file}:${violation.line} (${violation.label})`)
      .join(", ");
    throw new Error(`Public package contains forbidden private/product code references: ${details}`);
  }
}

function scanCodeReferences(roots, extensions, patterns) {
  const allFiles = roots.flatMap((root) =>
    collectFiles(path.resolve(process.cwd(), root), extensions)
  );
  const violations = [];
  for (const file of allFiles) {
    const contents = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      const matchIndex = contents.search(pattern.regex);
      if (matchIndex < 0) {
        continue;
      }
      violations.push({
        file: path.relative(process.cwd(), file),
        line: contents.slice(0, matchIndex).split(/\r?\n/u).length,
        label: pattern.label,
      });
      break;
    }
  }
  return violations;
}

function collectFiles(root, extensions) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "dist-cjs") {
        files.push(...collectFiles(fullPath, extensions));
      }
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function verifyInstalledExportMap(consumerDirectory) {
  const installedManifestPath = path.join(
    consumerDirectory,
    "node_modules",
    "@plasius",
    "asset-pipeline",
    "package.json"
  );
  const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
  const rootExport = installedManifest.exports?.["."];
  const shaderExport = installedManifest.exports?.["./shader-lifecycle"];
  if (rootExport?.import?.types !== "./dist/index.d.ts"
    || rootExport?.import?.default !== "./dist/index.js"
    || rootExport?.require?.types !== "./dist/index.d.cts"
    || rootExport?.require?.default !== "./dist/index.cjs"
    || shaderExport?.node?.import?.types !== "./dist/shader-lifecycle.d.ts"
    || shaderExport?.node?.import?.default !== "./dist/shader-lifecycle.js"
    || shaderExport?.node?.require?.types !== "./dist/shader-lifecycle.d.cts"
    || shaderExport?.node?.require?.default !== "./dist/shader-lifecycle.cjs"
    || shaderExport?.default !== null) {
    throw new Error("Packed shader lifecycle export is not explicitly Node-only.");
  }
}

function verifyInstalledTypeScriptBoundaries(consumerDirectory) {
  const compilerPath = require.resolve("typescript/lib/tsc.js");
  const nodeEsmPath = path.join(consumerDirectory, "node-consumer.mts");
  const nodeCjsPath = path.join(consumerDirectory, "node-consumer.cts");
  const browserRootPath = path.join(consumerDirectory, "browser-root.ts");
  const browserShaderPath = path.join(consumerDirectory, "browser-shader.ts");
  fs.writeFileSync(nodeEsmPath, [
    'import { createAssetPipelinePlan } from "@plasius/asset-pipeline";',
    'import { createShaderPromotionPlan } from "@plasius/asset-pipeline/shader-lifecycle";',
    "void createAssetPipelinePlan;",
    "void createShaderPromotionPlan;",
  ].join("\n"));
  fs.writeFileSync(nodeCjsPath, [
    'import pipeline = require("@plasius/asset-pipeline");',
    'import shader = require("@plasius/asset-pipeline/shader-lifecycle");',
    "void pipeline.createAssetPipelinePlan;",
    "void shader.createShaderPromotionPlan;",
  ].join("\n"));
  fs.writeFileSync(browserRootPath, [
    'import { createAssetPipelinePlan } from "@plasius/asset-pipeline";',
    "void createAssetPipelinePlan;",
  ].join("\n"));
  fs.writeFileSync(browserShaderPath, [
    'import { createShaderPromotionPlan } from "@plasius/asset-pipeline/shader-lifecycle";',
    "void createShaderPromotionPlan;",
  ].join("\n"));

  const nodeConfigPath = writeTypeScriptConfig(consumerDirectory, "tsconfig.node.json", {
    compilerOptions: typeScriptCompilerOptions("NodeNext", "NodeNext"),
    files: ["node-consumer.mts", "node-consumer.cts"],
  });
  const browserRootConfigPath = writeTypeScriptConfig(
    consumerDirectory,
    "tsconfig.browser-root.json",
    {
      compilerOptions: {
        ...typeScriptCompilerOptions("ESNext", "Bundler"),
        customConditions: ["browser"],
      },
      files: ["browser-root.ts"],
    },
  );
  const browserShaderConfigPath = writeTypeScriptConfig(
    consumerDirectory,
    "tsconfig.browser-shader.json",
    {
      compilerOptions: {
        ...typeScriptCompilerOptions("ESNext", "Bundler"),
        customConditions: ["browser"],
      },
      files: ["browser-shader.ts"],
    },
  );

  runTypeScriptCompiler(compilerPath, nodeConfigPath, consumerDirectory);
  runTypeScriptCompiler(compilerPath, browserRootConfigPath, consumerDirectory);
  let rejectedBrowserShaderTypes = false;
  try {
    runTypeScriptCompiler(compilerPath, browserShaderConfigPath, consumerDirectory);
  } catch {
    rejectedBrowserShaderTypes = true;
  }
  if (!rejectedBrowserShaderTypes) {
    throw new Error("Browser TypeScript unexpectedly resolved the Node-only shader lifecycle subpath.");
  }
}

function typeScriptCompilerOptions(module, moduleResolution) {
  return {
    target: "ES2022",
    module,
    moduleResolution,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
}

function writeTypeScriptConfig(directory, name, config) {
  const configPath = path.join(directory, name);
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function runTypeScriptCompiler(compilerPath, configPath, consumerDirectory) {
  execFileSync(process.execPath, [compilerPath, "--project", configPath], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function verifyBrowserBoundaries(consumerDirectory) {
  const rootBuild = buildSync({
    stdin: {
      contents: 'import * as root from "@plasius/asset-pipeline"; globalThis.__assetPipelineSmoke = root;',
      resolveDir: consumerDirectory,
      sourcefile: "asset-pipeline-browser-smoke.mjs",
    },
    bundle: true,
    format: "esm",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });
  if ((rootBuild.outputFiles[0]?.contents.byteLength ?? 0) === 0) {
    throw new Error("Packed browser-root smoke bundle was unexpectedly empty.");
  }

  let rejectedNodeSubpath = false;
  try {
    buildSync({
      stdin: {
        contents: 'import * as shader from "@plasius/asset-pipeline/shader-lifecycle"; globalThis.__shaderLifecycleSmoke = shader;',
        resolveDir: consumerDirectory,
        sourcefile: "asset-pipeline-node-subpath-browser-smoke.mjs",
      },
      bundle: true,
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      write: false,
    });
  } catch {
    rejectedNodeSubpath = true;
  }
  if (!rejectedNodeSubpath) {
    throw new Error("Browser bundling unexpectedly resolved the Node-only shader lifecycle subpath.");
  }
}

function verifyNodeEntrypoints(consumerDirectory) {
  const esmSmoke = `
    const root = await import("@plasius/asset-pipeline");
    const shader = await import("@plasius/asset-pipeline/shader-lifecycle");
    if (typeof root.createAssetPipelinePlan !== "function"
      || "createShaderPromotionPlan" in root
      || typeof shader.createShaderPromotionPlan !== "function") process.exit(1);
  `;
  const cjsSmoke = `
    const root = require("@plasius/asset-pipeline");
    const shader = require("@plasius/asset-pipeline/shader-lifecycle");
    if (typeof root.createAssetPipelinePlan !== "function"
      || "createShaderPromotionPlan" in root
      || typeof shader.createShaderPromotionPlan !== "function") process.exit(1);
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", esmSmoke], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync(process.execPath, ["--eval", cjsSmoke], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseNpmPackJson(rawOutput) {
  const start = rawOutput.indexOf("[");
  const end = rawOutput.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error("Could not find npm pack JSON payload in command output.");
  }
  return JSON.parse(rawOutput.slice(start, end + 1));
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
