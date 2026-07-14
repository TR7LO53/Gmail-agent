import type { DB } from "./db.js";

export type ParcelStatus =
  | "ordered"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "unknown";

export interface HistoryEntry {
  status: ParcelStatus;
  date: string;
  email_id: string;
}

export interface Parcel {
  tracking_number: string;
  carrier: string;
  status: ParcelStatus;
  last_update: string;
  thread_id?: string;
  first_seen: string;
  history: HistoryEntry[];
}

function rowToParcel(row: Record<string, unknown>): Parcel {
  return {
    tracking_number: row.tracking_number as string,
    carrier: row.carrier as string,
    status: row.status as ParcelStatus,
    last_update: row.last_update as string,
    thread_id: (row.thread_id as string | null) ?? undefined,
    first_seen: row.first_seen as string,
    history: JSON.parse(row.history as string) as HistoryEntry[],
  };
}

export function upsertParcel(
  db: DB,
  parcel: Omit<Parcel, "first_seen" | "history" | "last_update"> & { email_id: string },
): void {
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT * FROM parcels WHERE tracking_number = ?")
    .get(parcel.tracking_number) as Record<string, unknown> | undefined;

  if (!existing) {
    const history: HistoryEntry[] = [
      { status: parcel.status, date: now, email_id: parcel.email_id },
    ];
    db.prepare(
      `INSERT INTO parcels (tracking_number, carrier, status, last_update, thread_id, first_seen, history)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parcel.tracking_number,
      parcel.carrier,
      parcel.status,
      now,
      parcel.thread_id ?? null,
      now,
      JSON.stringify(history),
    );
  } else {
    const history = JSON.parse(existing.history as string) as HistoryEntry[];
    const statusChanged = existing.status !== parcel.status;
    if (statusChanged) {
      history.push({ status: parcel.status, date: now, email_id: parcel.email_id });
    }
    db.prepare(
      `UPDATE parcels
       SET carrier = ?, status = ?, last_update = ?, thread_id = COALESCE(?, thread_id), history = ?
       WHERE tracking_number = ?`,
    ).run(
      parcel.carrier,
      parcel.status,
      statusChanged ? now : (existing.last_update as string),
      parcel.thread_id ?? null,
      JSON.stringify(history),
      parcel.tracking_number,
    );
  }
}

export function getParcel(db: DB, trackingNumber: string): Parcel | undefined {
  const row = db
    .prepare("SELECT * FROM parcels WHERE tracking_number = ?")
    .get(trackingNumber) as Record<string, unknown> | undefined;
  return row ? rowToParcel(row) : undefined;
}

export function listActiveParcels(db: DB): Parcel[] {
  const rows = db
    .prepare("SELECT * FROM parcels WHERE status != 'delivered' ORDER BY last_update DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToParcel);
}

export function listAllParcels(db: DB): Parcel[] {
  const rows = db
    .prepare("SELECT * FROM parcels ORDER BY last_update DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToParcel);
}
