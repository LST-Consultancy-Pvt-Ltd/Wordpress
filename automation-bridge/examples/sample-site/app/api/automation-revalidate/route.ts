// Called by the bridge sidecar after an apply, with only the impacted paths,
// signed with BRIDGE_REVALIDATE_SECRET. Not reachable without that secret.
import { revalidatePath } from "next/cache";
import { createRevalidateHandler } from "@lst/automation-bridge/next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST } = createRevalidateHandler({ revalidatePath: (p) => revalidatePath(p) });
