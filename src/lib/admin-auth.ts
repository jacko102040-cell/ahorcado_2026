import { NextResponse } from "next/server";

export function requireAdminToken(request: Request): NextResponse | null {
  const expected = process.env.ADMIN_PANEL_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "ADMIN_PANEL_TOKEN is not configured on the server." },
      { status: 500 }
    );
  }

  const provided = request.headers.get("x-admin-token");
  if (provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
