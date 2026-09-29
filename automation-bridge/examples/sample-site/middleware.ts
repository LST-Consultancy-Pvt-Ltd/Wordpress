// Runtime redirects managed through the bridge (redirect.upsert / redirect.delete).
// Uses the Node.js middleware runtime (stable in Next.js 15.5) so it can read the store.
import { NextResponse, type NextRequest } from "next/server";
import { matchRedirect } from "@lst/automation-bridge/next";

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!api/|_next/|favicon.ico|hero.svg).*)"],
};

export function middleware(req: NextRequest) {
  const hit = matchRedirect(req.nextUrl.pathname);
  if (!hit) return NextResponse.next();
  const target = hit.destination.startsWith("/") ? new URL(hit.destination, req.nextUrl) : new URL(hit.destination);
  return NextResponse.redirect(target, hit.permanent ? 308 : 307);
}
