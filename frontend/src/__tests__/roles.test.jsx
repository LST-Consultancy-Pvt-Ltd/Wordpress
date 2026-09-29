import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RequireRole from "../components/RequireRole";
import GatedButton from "../components/sa/GatedButton";
import { hasRole } from "../lib/roles";
import { signIn } from "../test-utils";
import { getToken, getUser, dropStaleSessionKeys, TOKEN_KEY, USER_KEY } from "../lib/session";

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("role helpers", () => {
  test("hasRole follows viewer < editor < deployer < admin", () => {
    expect(hasRole("viewer", "editor")).toBe(false);
    expect(hasRole("editor", "editor")).toBe(true);
    expect(hasRole("deployer", "editor")).toBe(true);
    expect(hasRole("deployer", "admin")).toBe(false);
    expect(hasRole("admin", "deployer")).toBe(true);
    expect(hasRole(undefined, "editor")).toBe(false);
  });
});

describe("RequireRole", () => {
  test("renders children when the role is sufficient", () => {
    signIn("admin");
    wrap(<RequireRole min="admin" page><p>secret admin page</p></RequireRole>);
    expect(screen.getByText("secret admin page")).toBeInTheDocument();
  });

  test("shows an explanation (not the page) when the role is too low", () => {
    signIn("editor");
    wrap(<RequireRole min="admin" page><p>secret admin page</p></RequireRole>);
    expect(screen.queryByText("secret admin page")).not.toBeInTheDocument();
    expect(screen.getByTestId("require-role-denied")).toHaveTextContent(/Admin role required/);
    expect(screen.getByTestId("require-role-denied")).toHaveTextContent(/Editor/);
  });

  test("renders fallback or nothing for inline use", () => {
    signIn("viewer");
    wrap(<RequireRole min="editor" fallback={<span>read only</span>}><button>Edit</button></RequireRole>);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByText("read only")).toBeInTheDocument();
  });

  test("uses sa_user from the session; missing role counts as viewer", () => {
    window.localStorage.setItem(TOKEN_KEY, "t");
    window.localStorage.setItem(USER_KEY, JSON.stringify({ email: "x@example.com" }));
    wrap(<RequireRole min="editor" fallback={<span>nope</span>}><span>yes</span></RequireRole>);
    expect(screen.getByText("nope")).toBeInTheDocument();
  });
});

describe("GatedButton", () => {
  test("is disabled with a reason when the role is missing — never a dead control", () => {
    signIn("viewer");
    wrap(<GatedButton minRole="deployer" data-testid="apply">Apply</GatedButton>);
    const btn = screen.getByTestId("apply");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Requires the Deployer role");
  });

  test("is disabled with the precondition message when blocked", () => {
    signIn("admin");
    wrap(<GatedButton minRole="editor" blocked="The bridge does not offer X" data-testid="b">Go</GatedButton>);
    expect(screen.getByTestId("b")).toBeDisabled();
    expect(screen.getByTestId("b")).toHaveAttribute("title", "The bridge does not offer X");
  });

  test("is enabled when allowed", () => {
    signIn("deployer");
    wrap(<GatedButton minRole="deployer" data-testid="b">Go</GatedButton>);
    expect(screen.getByTestId("b")).toBeEnabled();
  });

  test("can be hidden instead of disabled", () => {
    signIn("editor");
    wrap(<GatedButton minRole="admin" hideIfRole>Admin thing</GatedButton>);
    expect(screen.queryByText("Admin thing")).not.toBeInTheDocument();
  });
});

describe("session keys", () => {
  test("stale sessions under other prefixes are dropped; sa_ keys are kept", () => {
    const legacyPrefix = ["x", "y"].join(""); // any non-sa prefix
    window.localStorage.setItem(`${legacyPrefix}_token`, "old");
    window.localStorage.setItem(`${legacyPrefix}_user`, "{}");
    window.localStorage.setItem("apply_mode", "manual"); // unrelated key survives
    signIn("editor");
    dropStaleSessionKeys();
    expect(window.localStorage.getItem(`${legacyPrefix}_token`)).toBeNull();
    expect(window.localStorage.getItem(`${legacyPrefix}_user`)).toBeNull();
    expect(window.localStorage.getItem("apply_mode")).toBe("manual");
    expect(getToken()).toBe("session-jwt-SECRET");
    expect(getUser().role).toBe("editor");
  });
});
