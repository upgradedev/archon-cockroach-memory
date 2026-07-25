import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/db/client.js";
import { DEFAULT_EMBED_MODEL } from "../src/memory/embeddings.js";
import { reconcileLegacyPublicDemoMemory } from "../src/memory/demo-reconciliation.js";

async function main(): Promise<void> {
  const targetSha = process.env.TARGET_SHA?.trim() ?? "";
  const embedModel =
    process.env.BEDROCK_EMBED_MODEL_ID?.trim() || DEFAULT_EMBED_MODEL;
  const receipt = await reconcileLegacyPublicDemoMemory(
    embedModel,
    targetSha
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invokedPath === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main()
    .catch((error) => {
      const message =
        error instanceof Error ? error.message : "unknown reconciliation error";
      process.stderr.write(`Legacy memory reconciliation failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => undefined);
    });
}
