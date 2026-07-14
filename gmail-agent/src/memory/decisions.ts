import type { DB } from "./db.js";

export interface Decision {
  id?: number;
  timestamp: string;
  email_id: string;
  thread_id?: string;
  action_taken: "track" | "skip" | "update";
  agent_reasoning?: string;
  outcome?: string;
}

function rowToDecision(row: Record<string, unknown>): Decision {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    email_id: row.email_id as string,
    thread_id: (row.thread_id as string | null) ?? undefined,
    action_taken: row.action_taken as Decision["action_taken"],
    agent_reasoning: (row.agent_reasoning as string | null) ?? undefined,
    outcome: (row.outcome as string | null) ?? undefined,
  };
}

export function recordDecision(db: DB, decision: Omit<Decision, "id">): void {
  db.prepare(
    `INSERT INTO decisions (timestamp, email_id, thread_id, action_taken, agent_reasoning, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    decision.timestamp,
    decision.email_id,
    decision.thread_id ?? null,
    decision.action_taken,
    decision.agent_reasoning ?? null,
    decision.outcome ?? null,
  );
}

export function listDecisions(db: DB, limit = 50): Decision[] {
  const rows = db
    .prepare("SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToDecision);
}

/**
 * Every email id that already has at least one decision logged. This is the cleanest
 * deduplication source for the heartbeat: an email that was already classified should
 * not be re-read or re-sent to the LLM on the next scan.
 */
export function getProcessedEmailIds(db: DB): Set<string> {
  const rows = db.prepare("SELECT DISTINCT email_id FROM decisions").all() as {
    email_id: string;
  }[];
  return new Set(rows.map((r) => r.email_id));
}
