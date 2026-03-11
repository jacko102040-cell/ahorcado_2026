import { NextResponse } from "next/server";

import { requireAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

type WordPayload = {
  word?: string;
  hint?: string | null;
  category?: string;
  difficulty?: "easy" | "medium" | "hard";
  is_active?: boolean;
};

function normalizeWord(payload: WordPayload) {
  const word = payload.word?.trim().toUpperCase();
  const category = payload.category?.trim().toLowerCase() ?? "general";
  const hint = payload.hint?.trim() || null;
  const difficulty = payload.difficulty ?? "medium";

  if (!word || word.length < 3 || word.length > 40 || !/^[A-Z]+$/.test(word)) {
    throw new Error("word must be A-Z only, length 3..40");
  }
  if (!["easy", "medium", "hard"].includes(difficulty)) {
    throw new Error("difficulty must be easy|medium|hard");
  }

  return {
    word,
    hint,
    category,
    difficulty,
    is_active: payload.is_active ?? true,
    language: "es"
  };
}

export async function GET(request: Request) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("words")
    .select("id,word,hint,category,difficulty,language,is_active,created_at")
    .order("word", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(request: Request) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  try {
    const payload = (await request.json()) as WordPayload;
    const normalized = normalizeWord(payload);
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
      .from("words")
      .insert(normalized)
      .select("id,word,hint,category,difficulty,language,is_active,created_at")
      .limit(1)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }
}
