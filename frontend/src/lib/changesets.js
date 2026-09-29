/**
 * Change-set helpers shared by every screen that proposes site changes.
 * Nothing in the UI writes to a site directly: it creates a change set, which
 * is then planned, validated, approved and applied in the Change Sets area.
 */
import { toast } from "sonner";

export const STATUS_LABELS = {
  draft: "Draft",
  planned: "Planned",
  plan_failed: "Plan failed",
  validating: "Validating",
  validated: "Validated",
  validation_failed: "Validation failed",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  applying: "Applying",
  applied: "Applied",
  apply_failed: "Apply failed",
  rolled_back: "Rolled back",
  cancelled: "Cancelled",
};

export const STATUS_TONE = {
  draft: "muted",
  planned: "info",
  plan_failed: "error",
  validating: "info",
  validated: "info",
  validation_failed: "error",
  pending_approval: "warn",
  approved: "ok",
  rejected: "error",
  applying: "info",
  applied: "ok",
  apply_failed: "error",
  rolled_back: "muted",
  cancelled: "muted",
};

export const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

const EDITABLE = ["draft", "planned", "plan_failed", "validation_failed", "rejected"];
const PRE_APPLY = ["draft", "planned", "plan_failed", "validating", "validated", "validation_failed", "pending_approval", "approved", "rejected"];

export const isEditable = (cs) => EDITABLE.includes(cs?.status);
export const canSubmit = (cs) => ["planned", "validated"].includes(cs?.status) && cs?.plan?.valid !== false;
export const canDecide = (cs) => cs?.status === "pending_approval";
export const canApply = (cs) => cs?.status === "approved";
export const canRollback = (cs) => cs?.status === "applied" && !!cs?.apply?.revision_id;
export const canCancel = (cs) => PRE_APPLY.includes(cs?.status) && cs?.status !== "rejected";
export const canValidate = (cs) => ["planned", "validated", "validation_failed"].includes(cs?.status) && cs?.plan?.valid !== false;

/** Pull the ChangeSet out of `{changeset}` responses (or a bare ChangeSet). */
export function extractChangeSet(data) {
  if (!data) return null;
  if (data.changeset) return data.changeset;
  if (data.id && (data.operations || data.status)) return data;
  return null;
}

/**
 * Standard "Change set created → review in Change Sets" feedback.
 * `navigate` is react-router's navigate function.
 */
export function notifyChangeSetCreated(changeset, navigate, { title } = {}) {
  if (!changeset) {
    toast.success(title || "Change set created", { description: "Review it in Change Sets." });
    return;
  }
  const planFailed = changeset.status === "plan_failed";
  const show = planFailed ? toast.warning : toast.success;
  show(title || (planFailed ? "Change set created, but planning failed" : "Change set created"), {
    description: planFailed
      ? "Open it to see the plan errors."
      : `${changeset.title || changeset.id} — review, validate and submit it for approval in Change Sets.`,
    action: navigate
      ? { label: "Review", onClick: () => navigate(`/changesets/${changeset.id}`) }
      : undefined,
  });
}

/** Human description of an operation for lists. */
export function describeOperation(op) {
  switch (op?.op) {
    case "content.upsert":
      return `${op.status === "published" ? "Publish" : "Save draft"} ${op.collection}/${op.slug}`;
    case "content.delete":
      return `Delete ${op.collection}/${op.slug}`;
    case "metadata.set":
      return `Set metadata on ${op.route}`;
    case "metadata.clear":
      return `Clear metadata override on ${op.route}`;
    case "block.set":
      return `Set block ${op.block_id}`;
    case "block.clear":
      return `Reset block ${op.block_id}`;
    case "image.alt.set":
      return `Set alt text on ${op.image_id}`;
    case "image.alt.clear":
      return `Reset alt text on ${op.image_id}`;
    case "redirect.upsert":
      return `Redirect ${op.source} → ${op.destination} (${op.permanent ? "308" : "307"})`;
    case "redirect.delete":
      return `Remove redirect ${op.source}`;
    case "file.write":
      return `${op.base_sha256 ? "Modify" : "Create"} ${op.root}/${op.path}`;
    case "file.delete":
      return `Delete ${op.root}/${op.path}`;
    default:
      return op?.op || "Unknown operation";
  }
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
