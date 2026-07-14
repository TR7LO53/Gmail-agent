import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { gmailSearch } from "../tools/gmail-search";
import { gmailRead } from "../tools/gmail-read";
import { gmailListLabels } from "../tools/gmail-labels";

/**
 * Exposes the SAME tool functions to Claude Code over MCP. Tool names use a double underscore
 * (gmail__search) to avoid collisions, per course lesson S01E03.
 */
const server = new McpServer({ name: "gmail-agent", version: "0.1.0" });

function asJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

server.tool(
  "gmail__search",
  "Search the Gmail inbox (read-only). Filter by sender, recipients, subject, free-text query, label, date range, attachment/unread flags. Returns message metadata; call gmail__read for full content.",
  {
    from: z.string().optional(),
    to: z.array(z.string()).optional(),
    subject: z.string().optional(),
    query: z.string().optional(),
    label: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    hasAttachment: z.boolean().optional(),
    isUnread: z.boolean().optional(),
    maxResults: z.number().int().positive().max(100).optional(),
    pageToken: z.string().optional(),
  },
  async (args) => asJson(await gmailSearch(args)),
);

server.tool(
  "gmail__read",
  'Read a full Gmail thread (read-only). Accepts a message id OR a thread id (resolved automatically). detail="full" returns decoded bodies; attachments are returned as reference links, never base64.',
  {
    id: z.string().min(1),
    detail: z.enum(["summary", "full"]).optional(),
  },
  async (args) => asJson(await gmailRead(args)),
);

server.tool(
  "gmail__list_labels",
  "List Gmail labels (read-only). Use a label name with gmail__search to filter messages.",
  {
    includeSystem: z.boolean().optional(),
  },
  async (args) => asJson(await gmailListLabels(args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
