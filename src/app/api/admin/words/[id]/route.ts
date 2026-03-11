import { NextResponse } from "next/server";

import { requireAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

type WordPatchPayload = {
  hint?: string | null;
  category?: string;
  difficulty?: "easy" | "medium" | "hard";
  is_active?: boolean;
};

function normalizePatch(payload: WordPatchPayload) {
  const output: Record<string, unknown> = {};

  if (payload.hint !== undefined) output.hint = payload.hint?.trim() || null;
  if (payload.category !== undefined) output.category = payload.category.trim().toLowerCase() || "general";
  if (payload.difficulty !== undefined) {
    if (!["easy", "medium", "hard"].includes(payload.difficulty)) {
      throw new Error("difficulty must be easy|medium|hard");
    }
    output.difficulty = payload.difficulty;
  }
  if (payload.is_active !== undefined) output.is_active = payload.is_active;

  if (Object.keys(output).length === 0) {
    throw new Error("No fields to update");
  }

  return output;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  try {
    const { id } = await context.params;
    const wordId = Number(id);
    if (!Number.isFinite(wordId)) {
      return NextResponse.json({ error: "Invalid word id" }, { status: 400 });
    }

    const payload = (await request.json()) as WordPatchPayload;
    const patch = normalizePatch(payload);
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
      .from("words")
      .update(patch)
      .eq("id", wordId)
      .select("id,word,hint,category,difficulty,language,is_active,created_at")
      .limit(1)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const { id } = await context.params;
  const wordId = Number(id);
  if (!Number.isFinite(wordId)) {
    return NextResponse.json({ error: "Invalid word id" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("words").delete().eq("id", wordId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
