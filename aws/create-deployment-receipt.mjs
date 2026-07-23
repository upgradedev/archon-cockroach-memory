#!/usr/bin/env node

// Produce a deterministic, secret-free build receipt for promotion through the
// staging and production jobs. The receipt intentionally contains hashes and
// repository metadata only; cloud account IDs, role ARNs, and secret ARNs are
// never read.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    if (entry.isFile()) files.push(path);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are forbidden in release artifacts: ${path}`);
    }
  }
  return files;
}

async function digestTree(root) {
  const hash = createHash("sha256");
  const files = await filesBelow(root);
  let bytes = 0;
  for (const file of files) {
    const artifactPath = relative(root, file).replaceAll("\\", "/");
    const contents = await readFile(file);
    const fileHash = createHash("sha256").update(contents).digest("hex");
    bytes += contents.byteLength;
    hash.update(
      `${Buffer.byteLength(artifactPath, "utf8")}\0${artifactPath}\0` +
        `${contents.byteLength}\0${fileHash}\n`
    );
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const commitSha = argument("--commit");
const samRoot = resolve(argument("--sam") ?? ".aws-sam/build");
const webRoot = resolve(argument("--web") ?? "web/dist");
const verifyPath = argument("--verify");

if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha)) {
  throw new Error("--commit must be a full 40-character Git commit SHA");
}

await Promise.all([stat(samRoot), stat(webRoot)]);
const [sam, web] = await Promise.all([digestTree(samRoot), digestTree(webRoot)]);

if (verifyPath) {
  const receipt = JSON.parse(await readFile(resolve(verifyPath), "utf8"));
  const valid =
    receipt?.schemaVersion === 1 &&
    receipt?.commitSha === commitSha &&
    receipt?.artifacts?.sam?.sha256 === sam.sha256 &&
    receipt?.artifacts?.sam?.files === sam.files &&
    receipt?.artifacts?.sam?.bytes === sam.bytes &&
    receipt?.artifacts?.web?.sha256 === web.sha256 &&
    receipt?.artifacts?.web?.files === web.files &&
    receipt?.artifacts?.web?.bytes === web.bytes &&
    receipt?.provenance?.buildOncePromoteSameArtifact === true;
  if (!valid) {
    throw new Error("deployment receipt verification failed");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      commitSha,
      sam,
      web,
      secretMaterialPrinted: false,
    })}\n`
  );
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      commitSha,
      builtAt: new Date().toISOString(),
      runtime: "nodejs22.x",
      artifacts: {
        sam,
        web,
      },
      provenance: {
        source: "GitHub Actions OIDC delivery pipeline",
        buildOncePromoteSameArtifact: true,
      },
    },
    null,
    2
  )}\n`
);
