/** Control-plane roles, ascending. See protocol/control-plane-api.md. */
export const ROLES = ["viewer", "editor", "deployer", "admin"];

export const ROLE_LABELS = {
  viewer: "Viewer",
  editor: "Editor",
  deployer: "Deployer",
  admin: "Admin",
};

export const ROLE_DESCRIPTIONS = {
  viewer: "Read everything",
  editor: "Create, edit, validate, preview and submit change sets; run audits",
  deployer: "Approve, apply, roll back, deploy, back up and restore",
  admin: "Everything, plus site connections, credentials, write enablement, policies and users",
};

export function roleRank(role) {
  const i = ROLES.indexOf(role);
  return i === -1 ? 0 : i;
}

/** True when `role` is at least `min`. Unknown roles are treated as viewer. */
export function hasRole(role, min) {
  if (!min) return true;
  return roleRank(role) >= roleRank(min);
}

export function requiresRoleMessage(min) {
  return `Requires the ${ROLE_LABELS[min] || min} role`;
}
