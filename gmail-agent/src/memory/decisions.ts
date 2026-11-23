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

export interface EmailDecisionState {
  classificationErrors: number;
  lastClassificationError?: string;
  retryPending: boolean;
  exhausted: boolean;
}

export function getEmailDecisionStates(db: DB): Map<string, EmailDecisionState> {
  // Legacy tracker errors count as completed decisions, even if only the reasoning identifies them.
  const rows = db.prepare(`
    WITH classified AS (
      SELECT email_id, timestamp, CASE
        WHEN action_taken = 'skip' AND outcome = 'error'
          AND COALESCE(agent_reasoning, '') NOT LIKE 'Tracker error%'
        THEN 1 ELSE 0 END AS classification_error
      FROM decisions
    )
    SELECT email_id, COUNT(*) AS total, SUM(classification_error) AS errors,
           MAX(CASE WHEN classification_error = 1 THEN timestamp END) AS last_error
    FROM classified
    GROUP BY email_id
  `).all() as { email_id: string; total: number; errors: number; last_error: string | null }[];

  return new Map(rows.map(({ email_id, total, errors, last_error }) => [email_id, {
    classificationErrors: errors,
    lastClassificationError: last_error ?? undefined,
    retryPending: errors === total && errors < 3,
    exhausted: errors === total && errors >= 3,
  }]));
}

/** Emails with any completed decision or three failed classification attempts. */
export function getProcessedEmailIds(db: DB): Set<string> {
  return new Set([...getEmailDecisionStates(db)].filter(([, state]) => !state.retryPending).map(([id]) => id));
}
