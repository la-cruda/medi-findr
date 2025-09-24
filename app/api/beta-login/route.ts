import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const form = await req.formData();
  const pass = form.get("pass")?.toString() || "";
  const ok = process.env.BETA_PASS && pass === process.env.BETA_PASS;
  if (!ok) {
    return NextResponse.redirect(new URL("/", req.url), { status: 302 });
  }
  const res = NextResponse.redirect(new URL("/prices", req.url), { status: 302 });
  res.cookies.set("mf_pass", pass, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30, path: "/" });
  return res;
}
