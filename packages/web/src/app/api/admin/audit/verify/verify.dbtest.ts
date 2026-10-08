// Live-DB integration test (gated) for the §15 audit hash chain and "Verify integrity":
// the genesis row, the trigger agreeing with the shared known-answer vectors, supplied chain
// values being overwritten, a gap-free chain under concurrent writers (with rollbacks), the
// READ COMMITTED guard, the audited verification run, the export's chain columns, and — using the
// owner connection to the EPHEMERAL test database only, inside transactions that are always
// rolled back — tampering being detected at the right row. Self-skips when DATABASE_URL is unset;
// the tamper cases also self-skip without TEST_OWNER_DATABASE_URL (set only by the harness).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

const ROW_TEXT_SQL = `select chain_seq::text as "chainSeq", id::text as id,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
       actor_user_id::text as "actorUserId", action, target_type as "targetType", target_id as "targetId",
       before::text as before, after::text as after, prev_hash as "prevHash", row_hash as "rowHash"
  from audit_log`;

test("genesis row: chain_seq 1, audit.chain_started, zero prev_hash, the unchained baseline", { skip }, async () => {
  const { Pool } = await import("pg");
  const { AUDIT_CHAIN_GENESIS_PREV_HASH, parseGenesisAfter } = await import("@innobox/shared");
  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ action: string; target_type: string; actor_user_id: string | null; prev_hash: string; after: string }>(
      `select action, target_type, actor_user_id, prev_hash, after::text as after from audit_log where chain_seq = 1`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "audit.chain_started");
    assert.equal(rows[0]!.target_type, "audit_log");
    assert.equal(rows[0]!.actor_user_id, null, "system actor");
    assert.equal(rows[0]!.prev_hash, AUDIT_CHAIN_GENESIS_PREV_HASH);
    const info = parseGenesisAfter(rows[0]!.after);
    assert.ok(info, "after carries { unchainedCount, lastUnchainedId }");
    const { rows: u } = await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where chain_seq is null`);
    assert.equal(Number(u[0]!.n), info.unchainedCount);
  } finally {
    await pool.end();
  }
});

test("the database's row hash matches the shared known-answer vectors", { skip }, async () => {
  const { Pool } = await import("pg");
  const { AUDIT_CHAIN_TEST_VECTORS } = await import("@innobox/shared");
  const pool = new Pool({ connectionString: url });
  try {
    for (const v of AUDIT_CHAIN_TEST_VECTORS) {
      const r = v.row;
      const { rows } = await pool.query<{ h: string }>(
        `select audit_log_row_hash($1::bigint, $2::bigint, $3::timestamptz, $4::uuid, $5, $6, $7, $8::jsonb, $9::jsonb, $10) as h`,
        [r.chainSeq, r.id, r.createdAt, r.actorUserId, r.action, r.targetType, r.targetId, r.before, r.after, r.prevHash],
      );
      assert.equal(rows[0]!.h, v.rowHash, `vector chain_seq ${r.chainSeq}`);
      // The vector's jsonb text IS PostgreSQL's own output form (stable under a round trip).
      for (const j of [r.before, r.after]) {
        if (j === null) continue;
        const { rows: t } = await pool.query<{ t: string }>(`select $1::jsonb::text as t`, [j]);
        assert.equal(t[0]!.t, j);
      }
    }
    // And jsonb normalizes key order / whitespace, so the hash covers the stored value, not the input text.
    const { rows: n } = await pool.query<{ t: string }>(`select $1::jsonb::text as t`, ['{"note":"Ünïcødé ✓","from":"awaiting_triage",  "to":"valid"}']);
    assert.equal(n[0]!.t, AUDIT_CHAIN_TEST_VECTORS[0]!.row.after);
  } finally {
    await pool.end();
  }
});

test("the trigger links each insert to the head and overwrites supplied chain values", { skip }, async () => {
  const { Pool } = await import("pg");
  const { auditRowHash } = await import("@innobox/shared");
  const pool = new Pool({ connectionString: url });
  try {
    const { rows: ins } = await pool.query<{ id: string }>(
      `insert into audit_log (action, target_type, target_id, after, chain_seq, prev_hash, row_hash)
       values ('test.chain_forge', 'test', 'forge', '{"x": 1}', 999999, $1, $1) returning id`,
      ["e".repeat(64)],
    );
    const { rows } = await pool.query(`${ROW_TEXT_SQL} where id = $1`, [ins[0]!.id]);
    const row = rows[0]!;
    assert.notEqual(row.chainSeq, "999999", "supplied chain_seq overwritten");
    assert.notEqual(row.rowHash, "e".repeat(64), "supplied row_hash overwritten");
    const { rows: prev } = await pool.query<{ row_hash: string }>(`select row_hash from audit_log where chain_seq = $1::bigint - 1`, [row.chainSeq]);
    assert.equal(row.prevHash, prev[0]!.row_hash, "prev_hash is the previous row's row_hash");
    assert.equal(auditRowHash(row), row.rowHash, "the independent recomputation agrees with the trigger");
  } finally {
    await pool.end();
  }
});

test("concurrent writers (with rollbacks) produce a gap-free, verifiable chain", { skip }, async () => {
  const { Pool } = await import("pg");
  const { appendAudit } = await import("../../../../../lib/audit");
  const { verifyAuditChain } = await import("./verify");
  const pool = new Pool({ connectionString: url, max: 12 });
  try {
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      writes.push(appendAudit(pool, { action: "test.chain_concurrent", targetType: "test", targetId: `c-${i}`, after: { i } }));
      if (i % 10 === 5) {
        // A transaction that writes two audit rows, then rolls back: no gap may remain.
        writes.push(
          (async () => {
            const c = await pool.connect();
            try {
              await c.query("begin");
              await appendAudit(c, { action: "test.chain_rolled_back", targetType: "test", targetId: `r-${i}` });
              await appendAudit(c, { action: "test.chain_rolled_back", targetType: "test", targetId: `r2-${i}` });
              await new Promise((r) => setTimeout(r, 15));
              await c.query("rollback");
            } finally {
              c.release();
            }
          })(),
        );
      }
    }
    // A multi-row INSERT chains each row in turn.
    writes.push(pool.query(`insert into audit_log (action, target_type, target_id) values ('test.chain_multi', 'test', 'm1'), ('test.chain_multi', 'test', 'm2')`));
    await Promise.all(writes);

    const { rows } = await pool.query<{ n: string; max: string; rolled: string }>(
      `select count(*)::text as n, max(chain_seq)::text as max,
              (select count(*)::text from audit_log where action = 'test.chain_rolled_back') as rolled
         from audit_log where chain_seq is not null`,
    );
    assert.equal(rows[0]!.n, rows[0]!.max, "chain_seq is 1..head with no gap");
    assert.equal(rows[0]!.rolled, "0");

    const progress: number[] = [];
    let started = -1;
    const outcome = await verifyAuditChain(pool, { pageSize: 7, progressEvery: 10, onStart: (h) => (started = h), onProgress: (n) => progress.push(n) });
    assert.equal(outcome.result, "intact", JSON.stringify(outcome.firstBreak));
    assert.equal(outcome.firstBreak, null);
    assert.equal(outcome.checked, Number(rows[0]!.max));
    assert.equal(started, Number(rows[0]!.max));
    assert.ok(progress.length >= 6 && progress.every((n) => n % 10 === 0), `progress every 10 rows: ${progress.join(",")}`);
  } finally {
    await pool.end();
  }
});

test("audit inserts refuse to run outside READ COMMITTED", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  try {
    for (const level of ["repeatable read", "serializable"]) {
      const c = await pool.connect();
      try {
        await c.query(`begin isolation level ${level}`);
        await assert.rejects(
          c.query(`insert into audit_log (action, target_type) values ('test.chain_isolation', 'test')`),
          /READ COMMITTED/,
          level,
        );
      } finally {
        await c.query("rollback");
        c.release();
      }
    }
  } finally {
    await pool.end();
  }
});

test("a verification run is audited as audit.verified and joins the chain after its head", { skip }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { endVerification, runAuditVerification, tryBeginVerification } = await import("./verify");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const { rows: u } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
      [`dbtest-verify-${stamp}`, `dbtest-verify-${stamp}@example.test`, `Dbtest Verifier ${stamp}`, `verifier-${stamp}@example.test`],
    );
    const actorId = u[0]!.id;

    assert.equal(tryBeginVerification(), true);
    assert.equal(tryBeginVerification(), false, "one run per process");
    endVerification();
    assert.equal(tryBeginVerification(), true, "released after the run");
    endVerification();

    const outcome = await runAuditVerification(pool, actorId);
    assert.equal(outcome.result, "intact");
    const { rows } = await pool.query<{ chain_seq: string; after: Record<string, unknown> }>(
      `select chain_seq::text, after from audit_log where action = 'audit.verified' and actor_user_id = $1 order by id`,
      [actorId],
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.after, { result: "intact", checked: outcome.checked, headChainSeq: outcome.head!.chainSeq, firstBreak: null });
    assert.equal(Number(rows[0]!.chain_seq), outcome.head!.chainSeq + 1, "the audit.verified row follows the head it verified");

    // A run the client abandons stops and is audited as aborted.
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await runAuditVerification(pool, actorId, { signal: ctrl.signal });
    assert.equal(aborted.result, "aborted");
    const { rows: r2 } = await pool.query<{ after: { result: string } }>(
      `select after from audit_log where action = 'audit.verified' and actor_user_id = $1 order by id desc limit 1`,
      [actorId],
    );
    assert.equal(r2[0]!.after.result, "aborted");
  } finally {
    await pool.end();
  }
});

test("the CSV export carries chain_seq, prev_hash and row_hash after `after`", { skip }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { appendAudit } = await import("../../../../../lib/audit");
  const { exportAudit } = await import("../store");
  const { AUDIT_CSV_COLUMNS, auditCsvLines } = await import("../csv");
  const pool = new Pool({ connectionString: url });
  try {
    const marker = `export-${randomUUID().slice(0, 8)}`;
    await appendAudit(pool, { action: "test.chain_export", targetType: "test", targetId: marker, after: { marker } });
    const { rows } = await exportAudit(pool, { targetId: marker });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.match(row.chainSeq ?? "", /^\d+$/);
    assert.match(row.prevHash ?? "", /^[0-9a-f]{64}$/);
    assert.match(row.rowHash ?? "", /^[0-9a-f]{64}$/);

    assert.deepEqual(AUDIT_CSV_COLUMNS.slice(-4), ["after", "chain_seq", "prev_hash", "row_hash"]);
    const lines = auditCsvLines(rows);
    assert.ok(lines[0]!.endsWith("after,chain_seq,prev_hash,row_hash"));
    assert.ok(lines[1]!.endsWith(`,${row.chainSeq},${row.prevHash},${row.rowHash}`));
  } finally {
    await pool.end();
  }
});

test(
  "tampering is detected at the right row (owner connection, ephemeral DB, always rolled back)",
  { skip: skip || (ownerUrl ? false : "TEST_OWNER_DATABASE_URL not set — tamper cases self-skip") },
  async () => {
    const { Client, Pool } = await import("pg");
    const { auditRowHash } = await import("@innobox/shared");
    const { appendAudit } = await import("../../../../../lib/audit");
    const { verifyAuditChain } = await import("./verify");
    const pool = new Pool({ connectionString: url });
    const owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      for (let i = 0; i < 4; i++) await appendAudit(pool, { action: "test.chain_tamper", targetType: "test", targetId: `t-${i}`, after: { i } });
      const { rows: victims } = await pool.query<{ id: string; chain_seq: string }>(
        `select id::text, chain_seq::text from audit_log where action = 'test.chain_tamper' order by chain_seq desc limit 3`,
      );
      // victims[2] < victims[1] < victims[0] (the head-most); tamper with the middle one.
      const mid = victims[1]!;
      const midSeq = Number(mid.chain_seq);

      const inRolledBackTx = async (tamper: () => Promise<void>) => {
        await owner.query("begin");
        try {
          await tamper();
          return await verifyAuditChain(owner);
        } finally {
          await owner.query("rollback");
        }
      };

      // content — an edited payload.
      const content = await inRolledBackTx(async () => {
        await owner.query(`alter table audit_log disable trigger audit_log_no_mutation`);
        await owner.query(`update audit_log set after = '{"i": 999}' where id = $1`, [mid.id]);
      });
      assert.equal(content.result, "broken");
      assert.equal(content.firstBreak?.check, "content");
      assert.equal(content.firstBreak?.id, mid.id);
      assert.equal(content.firstBreak?.chainSeq, midSeq);
      assert.equal(content.checked, midSeq - 1);

      // sequence — a removed row breaks at the next one.
      const sequence = await inRolledBackTx(async () => {
        await owner.query(`alter table audit_log disable trigger audit_log_no_mutation`);
        await owner.query(`delete from audit_log where id = $1`, [mid.id]);
      });
      assert.equal(sequence.firstBreak?.check, "sequence");
      assert.equal(sequence.firstBreak?.id, victims[0]!.id);
      assert.equal(sequence.firstBreak?.expected, midSeq);
      assert.equal(sequence.firstBreak?.actual, midSeq + 1);

      // link — a row re-hashed consistently but pointing at the wrong predecessor.
      const link = await inRolledBackTx(async () => {
        await owner.query(`alter table audit_log disable trigger audit_log_no_mutation`);
        const { rows } = await owner.query(
          `select chain_seq::text as "chainSeq", id::text as id,
                  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
                  actor_user_id::text as "actorUserId", action, target_type as "targetType", target_id as "targetId",
                  before::text as before, after::text as after, prev_hash as "prevHash"
             from audit_log where id = $1`,
          [mid.id],
        );
        const forged = { ...rows[0], prevHash: "d".repeat(64) };
        await owner.query(`update audit_log set prev_hash = $2, row_hash = $3 where id = $1`, [mid.id, forged.prevHash, auditRowHash(forged)]);
      });
      assert.equal(link.firstBreak?.check, "link");
      assert.equal(link.firstBreak?.id, mid.id);
      assert.equal(link.firstBreak?.actual, "d".repeat(64));

      // unchained — a row slipped in with the chain trigger disabled.
      let slippedId = "";
      const unchained = await inRolledBackTx(async () => {
        await owner.query(`alter table audit_log disable trigger audit_log_chain`);
        const { rows } = await owner.query<{ id: string }>(
          `insert into audit_log (action, target_type, target_id) values ('test.chain_slipped', 'test', 'slip') returning id::text`,
        );
        slippedId = rows[0]!.id;
      });
      assert.equal(unchained.firstBreak?.check, "unchained");
      assert.equal(unchained.firstBreak?.id, slippedId);

      // Every tamper was rolled back: the real chain is still intact.
      const after = await verifyAuditChain(pool);
      assert.equal(after.result, "intact", JSON.stringify(after.firstBreak));
    } finally {
      await owner.end();
      await pool.end();
    }
  },
);
