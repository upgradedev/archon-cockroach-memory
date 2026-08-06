import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const REAL_DB = Boolean(process.env.DATABASE_URL);
if (!REAL_DB) await import("./db_mock.js");

import {
  handleSandboxAudit,
  handleSandboxIngest,
  handleSandboxRecall,
} from "../src/http/sandbox-handler.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { SANDBOX_MAX_ACTIVE_SESSIONS } from "../src/memory/sandbox-store.js";
import { createHandler } from "../src/lambda.js";
import { closePool, query } from "../src/db/client.js";

after(async () => closePool());

test("sandbox rejects malformed input and capabilities", async () => {
  assert.equal((await handleSandboxIngest(null)).status, 400);
  assert.equal((await handleSandboxIngest({ fact: "abc" })).status, 400);
  assert.equal(
    (await handleSandboxIngest({ fact: "valid fact", sandbox_token: "guessable" })).status,
    400
  );
  assert.equal((await handleSandboxRecall({ question: "missing token" })).status, 400);
  assert.equal((await handleSandboxAudit({ sandbox_token: "guessable" })).status, 400);
  assert.equal(
    (await handleSandboxIngest({ fact: "valid fact", numericValue: "0" })).status,
    400
  );
  assert.equal(
    (await handleSandboxIngest({ fact: "valid fact", company: "\u0000" })).status,
    400
  );
  assert.equal(
    (await handleSandboxIngest({ fact: "valid fact", kind: "canonical" })).status,
    400
  );
  const capability = randomBytes(32).toString("base64url");
  assert.equal(
    (
      await handleSandboxRecall({
        sandbox_token: capability,
        question: "bounded question",
        limit: "10",
      })
    ).status,
    400
  );
});

test(
  "judge facts stay in a capability-scoped TTL store and never touch canonical memory",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const canonicalBefore = Number(
      (await query<{ count: string }>("SELECT count(*)::STRING AS count FROM agent_memory"))[0]!.count
    );
    const first = await handleSandboxIngest(
      {
        company: "Judge Corp",
        fact: "Invoice INV-9901 is recorded at EUR 45000.",
        sourceRef: "DOC-9901-A",
        subject: "INV-9901",
        attribute: "total",
        numericValue: 45000,
      },
      embedder
    );
    assert.equal(first.status, 201);
    const token = first.body.sandbox_token;
    assert.equal(typeof token, "string");
    assert.match(String(token), /^[A-Za-z0-9_-]{43}$/u);

    const second = await handleSandboxIngest(
      {
        sandbox_token: token,
        company: "Judge Corp",
        fact: "A signed correction records invoice INV-9901 at EUR 47000.",
        sourceRef: "DOC-9901-B",
        subject: "INV-9901",
        attribute: "total",
        numericValue: 47000,
      },
      embedder
    );
    assert.equal(second.status, 201);
    assert.equal(second.body.sandbox_token, token);

    const recall = await handleSandboxRecall(
      { sandbox_token: token, question: "What values exist for INV-9901?" },
      embedder,
      new FakeNarrator()
    );
    assert.equal(recall.status, 200);
    assert.equal(recall.body.recalled, 2);
    const citations = recall.body.citations as Array<{ sourceRef: string }>;
    assert.deepEqual(
      new Set(citations.map((item) => item.sourceRef)),
      new Set(["DOC-9901-A", "DOC-9901-B"])
    );

    const isolated = await handleSandboxIngest(
      {
        company: "Other Judge Corp",
        fact: "Invoice OTHER-1 is recorded at EUR 12.",
        sourceRef: "OTHER-DOC-1",
      },
      embedder
    );
    const isolatedToken = String(isolated.body.sandbox_token);
    const isolatedRecall = await handleSandboxRecall(
      { sandbox_token: isolatedToken, question: "What invoice is stored?" },
      embedder,
      new FakeNarrator()
    );
    assert.equal(isolatedRecall.status, 200);
    assert.equal(isolatedRecall.body.recalled, 1);
    assert.deepEqual(
      (isolatedRecall.body.citations as Array<{ sourceRef: string }>).map(
        (item) => item.sourceRef
      ),
      ["OTHER-DOC-1"]
    );

    const audit = await handleSandboxAudit({ sandbox_token: token });
    assert.equal(audit.status, 200);
    const contradictions = audit.body.contradictions as Array<{
      subject: string;
      values: Array<{ value: number }>;
    }>;
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0]!.subject, "INV-9901");
    assert.deepEqual(
      new Set(contradictions[0]!.values.map((item) => item.value)),
      new Set([45000, 47000])
    );

    const canonicalAfter = Number(
      (await query<{ count: string }>("SELECT count(*)::STRING AS count FROM agent_memory"))[0]!.count
    );
    assert.equal(canonicalAfter, canonicalBefore);
    const sandboxRows = await query<{ live: boolean; within_bound: boolean }>(
      `SELECT expires_at > now() AS live,
              expires_at <= now() + INTERVAL '61 minutes' AS within_bound
         FROM judge_sandbox_sessions
        WHERE token_hash = $1`,
      [createHash("sha256").update(String(token), "utf8").digest("hex")]
    );
    assert.deepEqual(sandboxRows, [{ live: true, within_bound: true }]);
  }
);

test(
  "sandbox capabilities fail closed on unknown and expired sessions",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const unknown = randomBytes(32).toString("base64url");
    assert.equal(
      (
        await handleSandboxRecall(
          { sandbox_token: unknown, question: "Anything stored?" },
          embedder,
          new FakeNarrator()
        )
      ).status,
      410
    );
    assert.equal(
      (await handleSandboxAudit({ sandbox_token: unknown })).status,
      410
    );

    const expired = randomBytes(32).toString("base64url");
    await query(
      `INSERT INTO judge_sandbox_sessions
         (token_hash, memory_count, created_at, updated_at, expires_at)
       VALUES (
         $1,
         0,
         now() - INTERVAL '2 hours',
         now() - INTERVAL '2 hours',
         now() - INTERVAL '1 hour'
       )`,
      [createHash("sha256").update(expired, "utf8").digest("hex")]
    );
    const response = await handleSandboxRecall(
      { sandbox_token: expired, question: "Anything stored?" },
      embedder,
      new FakeNarrator()
    );
    assert.equal(response.status, 410);
    assert.deepEqual(response.body, {
      ok: false,
      error: "sandbox session expired",
    });
  }
);

test(
  "sandbox retries without a supplied source reference are idempotent",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const request = {
      company: "Retry Judge Corp",
      fact: "A retry-safe judge fact with no explicit source reference.",
    };
    const first = await handleSandboxIngest(request, embedder);
    const second = await handleSandboxIngest(
      { ...request, sandbox_token: first.body.sandbox_token },
      embedder
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.reused, true);
    assert.equal(second.body.memory_id, first.body.memory_id);
  }
);

test(
  "sandbox rejects the twenty-first distinct memory without leaking internals",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    let token: string | undefined;
    for (let index = 0; index < 20; index += 1) {
      const response = await handleSandboxIngest(
        {
          ...(token ? { sandbox_token: token } : {}),
          fact: `Bounded sandbox fact number ${index}.`,
          sourceRef: `CAP-${index}`,
        },
        embedder
      );
      assert.equal(response.status, 201);
      token = String(response.body.sandbox_token);
    }
    const rejected = await handleSandboxIngest(
      {
        sandbox_token: token,
        fact: "This distinct fact exceeds the session capacity.",
        sourceRef: "CAP-20",
      },
      embedder
    );
    assert.equal(rejected.status, 429);
    assert.deepEqual(rejected.body, {
      ok: false,
      error: "sandbox session capacity reached",
    });
    assert.doesNotMatch(JSON.stringify(rejected.body), /postgres|sql|stack/iu);
  }
);

test(
  "sandbox rejects new sessions at the global active-session ceiling",
  { skip: !REAL_DB },
  async () => {
    const active = Number(
      (
        await query<{ count: string }>(
          `SELECT count(*)::STRING AS count
             FROM judge_sandbox_sessions
            WHERE expires_at > now()`
        )
      )[0]!.count
    );
    const needed = Math.max(0, SANDBOX_MAX_ACTIVE_SESSIONS - active);
    const nonce = randomBytes(16).toString("hex");
    const hashes = Array.from({ length: needed }, (_, index) =>
      createHash("sha256").update(`${nonce}:${index}`, "utf8").digest("hex")
    );
    if (hashes.length > 0) {
      await query(
        `INSERT INTO judge_sandbox_sessions (token_hash, expires_at)
         SELECT generated.token_hash, now() + INTERVAL '30 minutes'
           FROM unnest($1::STRING[]) AS generated(token_hash)`,
        [hashes]
      );
    }
    try {
      const rejected = await handleSandboxIngest(
        { fact: "A new session must not exceed the global capacity." },
        new FakeEmbedder()
      );
      assert.equal(rejected.status, 429);
      assert.deepEqual(rejected.body, {
        ok: false,
        error: "sandbox service capacity reached",
      });
    } finally {
      if (hashes.length > 0) {
        await query(
          `DELETE FROM judge_sandbox_sessions
            WHERE token_hash = ANY($1::STRING[])`,
          [hashes]
        );
      }
    }
  }
);

test(
  "Lambda exposes the isolated sandbox without leaking internal failures",
  { skip: !REAL_DB },
  async () => {
    const handler = createHandler({
      sandboxEmbedder: new FakeEmbedder(),
      sandboxNarrator: new FakeNarrator(),
    });
    const response = await handler({
      requestContext: { http: { method: "POST" } },
      rawPath: "/api/sandbox/ingest",
      headers: {
        "content-type": "application/json",
        "x-archon-origin-verify": process.env.ORIGIN_VERIFY_TOKEN,
      },
      body: JSON.stringify({ fact: "A bounded judge-provided financial fact." }),
    });
    assert.equal(response.statusCode, 201);
    assert.doesNotMatch(response.body, /postgres|permission|database_url|stack/iu);
  }
);
