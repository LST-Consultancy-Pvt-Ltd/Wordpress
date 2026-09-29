import { describe, expect, it } from "vitest";
import { makeBridge } from "../helpers.js";

describe("smoke", () => {
  it("capabilities, plan and apply metadata.set", async () => {
    const { client, bridge } = await makeBridge();
    const caps = await client.get("/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.json.capabilities["metadata.write"]).toBe(true);
    const { plan, apply } = await client.planAndApply([{ op: "metadata.set", route: "/about", fields: { title: "New" } }]);
    expect(plan.json.valid).toBe(true);
    expect(apply!.status).toBe(200);
    expect(apply!.json.operations[0].effective).toBe(true);
    await bridge.close();
  });
});
