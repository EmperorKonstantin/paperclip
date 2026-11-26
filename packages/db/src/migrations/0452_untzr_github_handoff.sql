CREATE TABLE "issue_github_handoffs" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"ancestor_ids" uuid[] NOT NULL,
	"operation_id" uuid NOT NULL,
	"action" text NOT NULL,
	"sha" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "issue_github_handoffs" ADD CONSTRAINT "issue_github_handoffs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Keep a started reservation until the caller has a definitive GitHub outcome.
-- Acquisition takes table locks against these writers before validating the issue.
CREATE FUNCTION reject_reserved_github_handoff_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    affected_issue uuid;
    approval_id_to_check uuid;
BEGIN
    IF TG_TABLE_NAME = 'issues' THEN
        IF TG_OP = 'DELETE' THEN
            affected_issue := OLD.id;
        ELSIF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
            affected_issue := NEW.id;
        END IF;
        IF affected_issue IS NOT NULL AND EXISTS (
            SELECT 1 FROM issue_github_handoffs h
            WHERE h.started_at IS NOT NULL AND affected_issue = ANY(h.ancestor_ids)
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0214', MESSAGE = 'The issue has a GitHub operation in flight.';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF (NEW.status IS DISTINCT FROM OLD.status
            OR NEW.status_version IS DISTINCT FROM OLD.status_version
            OR NEW.assignee_agent_id IS DISTINCT FROM OLD.assignee_agent_id
            OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
            OR NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id
            OR NEW.execution_run_id IS DISTINCT FROM OLD.execution_run_id
            OR NEW.checkout_run_id IS DISTINCT FROM OLD.checkout_run_id)
            AND EXISTS (
                SELECT 1 FROM issue_github_handoffs h
                WHERE h.issue_id = NEW.id AND h.started_at IS NOT NULL
            ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0214', MESSAGE = 'The issue has a GitHub operation in flight.';
        END IF;
    ELSIF TG_TABLE_NAME = 'issue_tree_holds' THEN
        IF NEW.status = 'active' AND NEW.mode IN ('pause', 'cancel') AND EXISTS (
            SELECT 1 FROM issue_github_handoffs h
            WHERE h.started_at IS NOT NULL AND NEW.root_issue_id = ANY(h.ancestor_ids)
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0214', MESSAGE = 'The issue has a GitHub operation in flight.';
        END IF;
    ELSIF TG_TABLE_NAME = 'heartbeat_runs' THEN
        IF NEW.status IN ('queued', 'running') AND EXISTS (
            SELECT 1 FROM issue_github_handoffs h
            WHERE h.started_at IS NOT NULL
              AND (h.issue_id IN (NEW.issue_id, NEW.native_issue_id)
                   OR h.issue_id::text = NEW.context_snapshot ->> 'issueId')
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0214', MESSAGE = 'The issue has a GitHub operation in flight.';
        END IF;
    ELSE
        IF TG_TABLE_NAME = 'issue_approvals' THEN
            affected_issue := NEW.issue_id;
            approval_id_to_check := NEW.approval_id;
        ELSE
            IF NEW.status NOT IN ('pending', 'revision_requested') THEN RETURN NEW; END IF;
            approval_id_to_check := NEW.id;
        END IF;
        IF EXISTS (
            SELECT 1 FROM issue_github_handoffs h
            WHERE h.started_at IS NOT NULL
              AND (
                  (affected_issue = h.issue_id AND EXISTS (
                      SELECT 1 FROM approvals a
                      WHERE a.id = approval_id_to_check AND a.status IN ('pending', 'revision_requested')
                  )) OR (affected_issue IS NULL AND EXISTS (
                      SELECT 1 FROM issue_approvals ia
                      WHERE ia.issue_id = h.issue_id AND ia.approval_id = approval_id_to_check
                  ))
              )
        ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0214', MESSAGE = 'The issue has a GitHub operation in flight.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issue_github_handoff_issue_guard BEFORE UPDATE OR DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION reject_reserved_github_handoff_mutation();
--> statement-breakpoint
CREATE TRIGGER issue_github_handoff_hold_guard BEFORE INSERT OR UPDATE ON issue_tree_holds
FOR EACH ROW EXECUTE FUNCTION reject_reserved_github_handoff_mutation();
--> statement-breakpoint
CREATE TRIGGER issue_github_handoff_run_guard BEFORE INSERT OR UPDATE OF status, issue_id, native_issue_id, context_snapshot ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION reject_reserved_github_handoff_mutation();
--> statement-breakpoint
CREATE TRIGGER issue_github_handoff_approval_link_guard BEFORE INSERT OR UPDATE ON issue_approvals
FOR EACH ROW EXECUTE FUNCTION reject_reserved_github_handoff_mutation();
--> statement-breakpoint
CREATE TRIGGER issue_github_handoff_approval_guard BEFORE UPDATE OF status ON approvals
FOR EACH ROW EXECUTE FUNCTION reject_reserved_github_handoff_mutation();
