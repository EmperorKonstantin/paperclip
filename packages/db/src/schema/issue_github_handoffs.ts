import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const issueGithubHandoffs = pgTable("issue_github_handoffs", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  ancestorIds: uuid("ancestor_ids").array().notNull(),
  operationId: uuid("operation_id").notNull(),
  action: text("action").$type<"approve" | "merge">().notNull(),
  sha: text("sha").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
});
