/**
 * Session storage for the app's own JWT and the signed-in user.
 *
 * Keys are namespaced `sa_` (Site Autopilot). Sessions written by older
 * builds under a different prefix are not migrated: they are dropped on
 * start-up and the user signs in again (see `dropStaleSessionKeys`).
 */
export const TOKEN_KEY = "sa_token";
export const USER_KEY = "sa_user";

// Any `<prefix>_token` / `<prefix>_user` pair that isn't ours is a stale
// session from an older build. We match the shape instead of naming keys.
const STALE_SESSION_KEY = /^(?!sa_)[a-z]{2,4}_(token|user)$/;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function dropStaleSessionKeys() {
  const ls = storage();
  if (!ls) return;
  const stale = [];
  for (let i = 0; i < ls.length; i += 1) {
    const k = ls.key(i);
    if (k && STALE_SESSION_KEY.test(k)) stale.push(k);
  }
  stale.forEach((k) => ls.removeItem(k));
}

export function getToken() {
  return storage()?.getItem(TOKEN_KEY) || null;
}

export function getUser() {
  try {
    return JSON.parse(storage()?.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  const ls = storage();
  if (!ls) return;
  ls.setItem(TOKEN_KEY, token);
  ls.setItem(USER_KEY, JSON.stringify(user || null));
  window.dispatchEvent(new Event("sa:session"));
}

export function clearSession() {
  const ls = storage();
  if (!ls) return;
  ls.removeItem(TOKEN_KEY);
  ls.removeItem(USER_KEY);
  window.dispatchEvent(new Event("sa:session"));
}
