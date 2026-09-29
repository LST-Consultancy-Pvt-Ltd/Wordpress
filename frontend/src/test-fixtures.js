export const DIFF = `--- a/overrides/metadata.json
+++ b/overrides/metadata.json
@@ -1,3 +1,3 @@
 {
-  "title": "Old title"
+  "title": "New title"
 }
`;

export const changeSet = (over = {}) => ({
  id: "cs_1",
  site_id: "site-1",
  title: "Metadata for /",
  description: "Better title",
  source: "manual",
  status: "pending_approval",
  operations: [{ op: "metadata.set", route: "/", fields: { title: "New title" } }],
  plan: {
    valid: true,
    errors: [],
    warnings: [],
    diff: DIFF,
    diff_sha256: "f".repeat(64),
    files: [{ root: "overrides", path: "metadata.json", change: "modify" }],
    impacted_routes: ["/"],
    risk: { level: "low", flags: [] },
    planned_at: "2026-09-28T10:00:00Z",
    base_revision: "r_1",
  },
  validation: null,
  preview: null,
  policy_checks: [{ name: "writes_enabled", ok: true, message: "Writes are enabled" }],
  approvals: [],
  apply: null,
  rollback: null,
  created_by: "u-editor",
  created_at: "2026-09-28T10:00:00Z",
  updated_at: "2026-09-28T10:00:00Z",
  correlation_id: "corr-123",
  ...over,
});
