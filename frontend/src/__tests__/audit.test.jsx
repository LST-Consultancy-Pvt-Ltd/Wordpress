import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fail, ok, renderAt, signIn } from "../test-utils";

jest.mock("../lib/api", () => {
  const actual = jest.requireActual("../lib/api");
  return { ...actual, listAudit: jest.fn(), getSites: jest.fn() };
});
const api = require("../lib/api");
const Audit = require("../pages/Audit").default;

const events = [
  {
    id: "a1", at: "2026-09-28T11:00:00Z", actor_id: "u2", actor_email: "deployer@example.com", role: "deployer",
    site_id: "site-1", environment: "production", action: "changeset.apply", target_type: "changeset", target_id: "cs_1",
    change_id: "cs_1", revision_id: "r_2", correlation_id: "corr-abc", outcome: "ok", detail: null,
  },
  {
    id: "a2", at: "2026-09-28T10:30:00Z", actor_id: "u3", actor_email: "viewer@example.com", role: "viewer",
    site_id: "site-1", environment: "production", action: "changeset.approve", target_type: "changeset", target_id: "cs_1",
    change_id: "cs_1", revision_id: null, correlation_id: "corr-def", outcome: "denied", detail: "role viewer < deployer",
  },
];

beforeEach(() => {
  signIn("viewer");
  api.getSites.mockImplementation(() => ok([{ id: "site-1", name: "Marketing site" }]));
});

test("lists who did what, outcome, revision and correlation id, with links to change sets", async () => {
  api.listAudit.mockImplementation(() => ok({ items: events, next_cursor: null }));
  renderAt(<Audit />);
  const rows = await screen.findAllByTestId("audit-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("deployer@example.com");
  expect(rows[0]).toHaveTextContent("changeset.apply");
  expect(rows[0]).toHaveTextContent("r_2");
  expect(rows[0]).toHaveTextContent("corr-abc");
  expect(rows[1]).toHaveTextContent("denied");
  expect(rows[1]).toHaveTextContent("role viewer < deployer");
  expect(screen.getAllByRole("link", { name: "cs_1" })[0]).toHaveAttribute("href", "/changesets/cs_1");
  await waitFor(() => expect(rows[0]).toHaveTextContent("Marketing site"));
});

test("filters are sent to the API and pagination loads more", async () => {
  const user = userEvent.setup();
  api.listAudit
    .mockImplementationOnce(() => ok({ items: [events[0]], next_cursor: "c2" }))
    .mockImplementationOnce(() => ok({ items: [events[1]], next_cursor: null }))
    .mockImplementation(() => ok({ items: [events[0]], next_cursor: null }));
  renderAt(<Audit />);
  await screen.findAllByTestId("audit-row");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
  expect(api.listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c2" }));

  await user.type(screen.getByTestId("audit-actor"), "deployer@example.com");
  await user.type(screen.getByTestId("audit-action"), "changeset.apply");
  await user.click(screen.getByRole("button", { name: /Filter/ }));
  await waitFor(() =>
    expect(api.listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ actor: "deployer@example.com", action: "changeset.apply" }))
  );
});

test("empty and error states", async () => {
  api.listAudit.mockImplementation(() => ok({ items: [], next_cursor: null }));
  const { unmount } = renderAt(<Audit />);
  expect(await screen.findByTestId("audit-empty")).toBeInTheDocument();
  unmount();
  api.listAudit.mockImplementation(() => fail(500, "boom"));
  renderAt(<Audit />);
  expect(await screen.findByTestId("error-callout")).toHaveTextContent("boom");
});
