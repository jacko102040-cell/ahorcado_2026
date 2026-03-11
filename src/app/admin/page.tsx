"use client";

import { useEffect, useMemo, useState } from "react";

import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/constants";
import { type Difficulty } from "@/lib/types";

type WordRow = {
  id: number;
  word: string;
  hint: string | null;
  category: string;
  difficulty: Difficulty;
  language: string;
  is_active: boolean;
  created_at: string;
};

type NewWordForm = {
  word: string;
  hint: string;
  category: string;
  difficulty: Difficulty;
};

const INITIAL_NEW_WORD: NewWordForm = {
  word: "",
  hint: "",
  category: "general",
  difficulty: "medium"
};

async function fetchApi<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
      ...(init?.headers ?? {})
    }
  });
  const body = (await response.json()) as { data?: T; error?: string; ok?: boolean };
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return (body.data as T) ?? (body as T);
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [words, setWords] = useState<WordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newWord, setNewWord] = useState<NewWordForm>(INITIAL_NEW_WORD);

  useEffect(() => {
    const saved = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (saved) setToken(saved);
  }, []);

  const sortedWords = useMemo(() => [...words].sort((a, b) => a.word.localeCompare(b.word)), [words]);

  const loadWords = async () => {
    if (!token.trim()) {
      setError("Ingresa ADMIN_PANEL_TOKEN.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
      const data = await fetchApi<WordRow[]>("/api/admin/words", token.trim(), { method: "GET" });
      setWords(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar palabras.");
    } finally {
      setLoading(false);
    }
  };

  const createWord = async () => {
    if (!token.trim()) return;
    setError(null);
    try {
      const created = await fetchApi<WordRow>("/api/admin/words", token.trim(), {
        method: "POST",
        body: JSON.stringify(newWord)
      });
      setWords((prev) => [...prev, created]);
      setNewWord(INITIAL_NEW_WORD);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear palabra.");
    }
  };

  const patchWord = async (word: WordRow) => {
    if (!token.trim()) return;
    setError(null);
    try {
      const updated = await fetchApi<WordRow>(`/api/admin/words/${word.id}`, token.trim(), {
        method: "PATCH",
        body: JSON.stringify({
          hint: word.hint,
          category: word.category,
          difficulty: word.difficulty,
          is_active: word.is_active
        })
      });
      setWords((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar palabra.");
    }
  };

  const deleteWord = async (wordId: number) => {
    if (!token.trim()) return;
    setError(null);
    try {
      await fetchApi<{ ok: true }>(`/api/admin/words/${wordId}`, token.trim(), { method: "DELETE" });
      setWords((prev) => prev.filter((item) => item.id !== wordId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar palabra.");
    }
  };

  return (
    <main className="page">
      <section className="card admin-shell">
        <h1>Admin de Palabras</h1>
        <p className="muted">Panel protegido por token para CRUD de banco de palabras.</p>

        <label htmlFor="adminToken">ADMIN_PANEL_TOKEN</label>
        <div className="control-row">
          <input
            id="adminToken"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Token del panel admin"
          />
          <button type="button" onClick={() => void loadWords()} disabled={loading}>
            {loading ? "Cargando..." : "Cargar"}
          </button>
        </div>

        <h2>Nueva palabra</h2>
        <div className="admin-grid">
          <input
            type="text"
            value={newWord.word}
            onChange={(event) => setNewWord((prev) => ({ ...prev, word: event.target.value.toUpperCase() }))}
            placeholder="PALABRA"
          />
          <input
            type="text"
            value={newWord.hint}
            onChange={(event) => setNewWord((prev) => ({ ...prev, hint: event.target.value }))}
            placeholder="Pista"
          />
          <input
            type="text"
            value={newWord.category}
            onChange={(event) => setNewWord((prev) => ({ ...prev, category: event.target.value.toLowerCase() }))}
            placeholder="Categoria"
          />
          <select
            value={newWord.difficulty}
            onChange={(event) => setNewWord((prev) => ({ ...prev, difficulty: event.target.value as Difficulty }))}
          >
            <option value="easy">easy</option>
            <option value="medium">medium</option>
            <option value="hard">hard</option>
          </select>
          <button type="button" onClick={() => void createWord()}>
            Crear
          </button>
        </div>

        <h2>Lista</h2>
        {sortedWords.length === 0 ? (
          <p className="muted">Sin palabras cargadas.</p>
        ) : (
          <ul className="admin-list">
            {sortedWords.map((word) => (
              <li key={word.id}>
                <div className="admin-row">
                  <strong>{word.word}</strong>
                  <label className="inline">
                    Activa
                    <input
                      type="checkbox"
                      checked={word.is_active}
                      onChange={(event) =>
                        setWords((prev) =>
                          prev.map((item) =>
                            item.id === word.id ? { ...item, is_active: event.target.checked } : item
                          )
                        )
                      }
                    />
                  </label>
                </div>
                <div className="admin-grid">
                  <input
                    type="text"
                    value={word.hint ?? ""}
                    onChange={(event) =>
                      setWords((prev) =>
                        prev.map((item) => (item.id === word.id ? { ...item, hint: event.target.value } : item))
                      )
                    }
                    placeholder="Pista"
                  />
                  <input
                    type="text"
                    value={word.category}
                    onChange={(event) =>
                      setWords((prev) =>
                        prev.map((item) =>
                          item.id === word.id ? { ...item, category: event.target.value.toLowerCase() } : item
                        )
                      )
                    }
                    placeholder="Categoria"
                  />
                  <select
                    value={word.difficulty}
                    onChange={(event) =>
                      setWords((prev) =>
                        prev.map((item) =>
                          item.id === word.id ? { ...item, difficulty: event.target.value as Difficulty } : item
                        )
                      )
                    }
                  >
                    <option value="easy">easy</option>
                    <option value="medium">medium</option>
                    <option value="hard">hard</option>
                  </select>
                  <button type="button" onClick={() => void patchWord(word)}>
                    Guardar
                  </button>
                  <button type="button" className="secondary" onClick={() => void deleteWord(word.id)}>
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
