import { z } from "zod";
import { getGmailClient, type GmailClient } from "../gmail/client";
import { ok, type ToolResponse } from "./types";
import { mapError } from "./errors";

export const labelsInputSchema = z.object({
  /** Set false to hide Gmail's built-in (system) labels like INBOX/SENT. Defaults to including them. */
  includeSystem: z.boolean().optional(),
});
export type LabelsInput = z.infer<typeof labelsInputSchema>;

export interface LabelRow {
  id: string;
  name: string;
  type: string;
}

export interface LabelsData {
  labels: LabelRow[];
}

/** List Gmail labels (read-only). Used once at startup to build context for searches. */
export async function gmailListLabels(
  input: LabelsInput = {},
  deps: { gmail?: GmailClient } = {},
): Promise<ToolResponse<LabelsData>> {
  try {
    const gmail = deps.gmail ?? (await getGmailClient());
    const res = await gmail.users.labels.list({ userId: "me" });

    let labels: LabelRow[] = (res.data.labels ?? []).map((l) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      type: l.type ?? "user",
    }));

    if (input.includeSystem === false) {
      labels = labels.filter((l) => l.type !== "system");
    }

    return ok<LabelsData>(
      { labels },
      {
        next_action: "Pass a label `name` to gmail_search (via the `label` field) to filter messages.",
        diagnostics: { count: labels.length },
      },
    );
  } catch (err) {
    return mapError(err);
  }
}
