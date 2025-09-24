// middleware.ts
import { NextResponse, NextRequest } from "next/server";

const PASS = process.env.BETA_PASS;

export function middleware(req: NextRequest) {
  // Allow assets and Next internals
  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/public") ||
    pathname.startsWith("/api/health")
  ) {
    return NextResponse.next();
  }

  // If no pass configured, do nothing (local/dev)
  if (!PASS) return NextResponse.next();

  // Check cookie or header
  const cookie = req.cookies.get("mf_pass")?.value;
  const header = req.headers.get("x-beta-pass");
  if (cookie === PASS || header === PASS) return NextResponse.next();

  // Show minimal pass form
  return new NextResponse(
    `<!doctype html>
<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc">
<form method="POST" action="/api/beta-login" style="padding:24px;border:1px solid #e5e7eb;border-radius:12px;background:white;min-width:320px">
  <h1 style="margin:0 0 12px;font-size:18px">mediFindr beta access</h1>
  <p style="margin:0 0 16px;color:#555">Enter passcode to continue.</p>
  <input name="pass" type="password" placeholder="Passcode" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:8px" />
  <button style="margin-top:12px;padding:10px 14px;border-radius:10px;background:black;color:white;border:1px solid black;cursor:pointer;width:100%">Enter</button>
</form>
</body></html>`,
    { status: 401, headers: { "content-type": "text/html" } }
  );
}

export const config = {
  // protect the whole app except static assets
  matcher: ["/((?!_next|.*\\.(?:png|jpg|jpeg|svg|ico|css|js|map)).*)"],
};
