"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SupabaseClient } from "@supabase/supabase-js";

import {
  ALPHABET,
  DEFAULT_ROOM_CODE,
  HEARTBEAT_MS,
  NAME_STORAGE_KEY,
  ROOM_STORAGE_KEY,
  TURN_TICK_MS
} from "@/lib/constants";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import {
  type Difficulty,
  type PlayerRow,
  type RoomJoinResult,
  type RoomRow,
  type RoundRow,
  type Team,
  type VoteResetResult,
  type VoteRematchResult,
  type VoteStatus
} from "@/lib/types";

type JoinState = {
  roomId: string;
  roomCode: string;
  playerId: string;
};

type TeamPreference = "AUTO" | Team;

const EMPTY_VOTES: VoteStatus = {
  rematch_votes: 0,
  reset_votes: 0,
  needed: 1
};

function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

function normalizeRoom(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function toDifficulty(value: string): Difficulty | null {
  if (value === "easy" || value === "medium" || value === "hard") {
    return value;
  }
  return null;
}

export default function HangmanApp() {
  const [clientError, setClientError] = useState<string | null>(null);
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(DEFAULT_ROOM_CODE);
  const [teamPreference, setTeamPreference] = useState<TeamPreference>("AUTO");
  const [joinState, setJoinState] = useState<JoinState | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [round, setRound] = useState<RoundRow | null>(null);
  const [votes, setVotes] = useState<VoteStatus>(EMPTY_VOTES);

  const [categoryFilter, setCategoryFilter] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<Difficulty | "">("");

  const [isJoining, setIsJoining] = useState(false);
  const [isStartingRound, setIsStartingRound] = useState(false);
  const [isUsingHint, setIsUsingHint] = useState(false);
  const [isChangingTeamMode, setIsChangingTeamMode] = useState(false);
  const [isVotingRematch, setIsVotingRematch] = useState(false);
  const [isVotingReset, setIsVotingReset] = useState(false);
  const [isSkippingTurn, setIsSkippingTurn] = useState(false);
  const [busyLetter, setBusyLetter] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingRoom, setLoadingRoom] = useState(false);

  const [turnTick, setTurnTick] = useState<number>(Date.now());
  const autoJoinTriedRef = useRef(false);
  const autoTurnGuardRef = useRef<string>("");

  useEffect(() => {
    try {
      setSupabase(getSupabaseBrowserClient());
    } catch (error) {
      setClientError(error instanceof Error ? error.message : "Failed to initialize Supabase client.");
      return;
    }

    const savedName = window.localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) setDisplayName(savedName);

    const savedRoom = window.localStorage.getItem(ROOM_STORAGE_KEY);
    if (savedRoom) setRoomCode(savedRoom);
  }, []);

  const loadRoom = useCallback(
    async (roomId: string) => {
      if (!supabase) return;

      const { data, error } = await supabase
        .from("rooms")
        .select("id,code,team_mode,turn_seconds,max_errors,created_at,current_round_id")
        .eq("id", roomId)
        .limit(1);

      if (error) {
        setActionError(error.message);
        return;
      }

      const row = data?.[0] as RoomRow | undefined;
      setRoom(row ?? null);
    },
    [supabase]
  );

  const loadPlayers = useCallback(
    async (roomId: string) => {
      if (!supabase) return;

      const { data, error } = await supabase
        .from("players")
        .select(
          "id,room_id,auth_user_id,display_name,team,turn_order,score,is_host,is_active,joined_at,last_seen_at"
        )
        .eq("room_id", roomId)
        .eq("is_active", true)
        .order("score", { ascending: false })
        .order("turn_order", { ascending: true });

      if (error) {
        setActionError(error.message);
        return;
      }

      setPlayers((data ?? []) as PlayerRow[]);
    },
    [supabase]
  );

  const loadRound = useCallback(
    async (roomId: string) => {
      if (!supabase) return;

      const { data, error } = await supabase
        .from("rounds")
        .select(
          "id,room_id,status,category,difficulty,masked_word,wrong_letters,correct_letters,max_errors,errors_count,points_letter,points_solve,active_turn_player_id,turn_started_at,hint_used,hint_text,created_by_player_id,winner_player_id,started_at,ended_at"
        )
        .eq("room_id", roomId)
        .order("started_at", { ascending: false })
        .limit(1);

      if (error) {
        setActionError(error.message);
        return;
      }

      setRound(data?.[0] ? (data[0] as RoundRow) : null);
      setTurnTick(Date.now());
    },
    [supabase]
  );

  const loadVotes = useCallback(
    async (roomCodeValue: string) => {
      if (!supabase) return;

      const { data, error } = await supabase.rpc("get_vote_status", {
        p_room_code: roomCodeValue
      });

      if (error) {
        setActionError(error.message);
        return;
      }

      const row = Array.isArray(data) ? (data[0] as VoteStatus | undefined) : (data as VoteStatus);
      setVotes(row ?? EMPTY_VOTES);
    },
    [supabase]
  );

  const refreshJoinedState = useCallback(
    async (state: JoinState) => {
      setLoadingRoom(true);
      setActionError(null);
      await Promise.all([
        loadRoom(state.roomId),
        loadPlayers(state.roomId),
        loadRound(state.roomId),
        loadVotes(state.roomCode)
      ]);
      setLoadingRoom(false);
    },
    [loadPlayers, loadRoom, loadRound, loadVotes]
  );

  const ensureAnonymousSession = useCallback(async (): Promise<string> => {
    if (!supabase) throw new Error("Supabase client not initialized.");

    const existing = await supabase.auth.getSession();
    const existingUserId = existing.data.session?.user.id;
    if (existingUserId) {
      setAuthUserId(existingUserId);
      return existingUserId;
    }

    const anon = await supabase.auth.signInAnonymously();
    if (anon.error) throw new Error(anon.error.message);

    const userId = anon.data.user?.id ?? anon.data.session?.user.id;
    if (!userId) throw new Error("Could not create anonymous session.");

    setAuthUserId(userId);
    return userId;
  }, [supabase]);

  const joinRoom = useCallback(
    async (overrideRoom?: string, overrideName?: string) => {
      if (!supabase) return;

      const normalizedRoom = normalizeRoom(overrideRoom ?? roomCode);
      const normalizedName = normalizeName(overrideName ?? displayName);
      const requestedTeam = teamPreference === "AUTO" ? null : teamPreference;

      if (normalizedRoom.length < 3 || normalizedRoom.length > 16) {
        setActionError("El codigo de sala debe tener entre 3 y 16 caracteres.");
        return;
      }
      if (normalizedName.length < 2 || normalizedName.length > 24) {
        setActionError("El nombre debe tener entre 2 y 24 caracteres.");
        return;
      }

      setIsJoining(true);
      setActionError(null);

      try {
        await ensureAnonymousSession();

        const { data, error } = await supabase.rpc("join_room", {
          p_room_code: normalizedRoom,
          p_display_name: normalizedName,
          p_requested_team: requestedTeam
        });
        if (error) throw new Error(error.message);

        const row = (Array.isArray(data) ? data[0] : data) as RoomJoinResult | null;
        if (!row?.room_id || !row?.player_id) throw new Error("No se pudo unir a la sala.");

        const newJoinState: JoinState = {
          roomId: row.room_id,
          playerId: row.player_id,
          roomCode: normalizedRoom
        };

        window.localStorage.setItem(NAME_STORAGE_KEY, normalizedName);
        window.localStorage.setItem(ROOM_STORAGE_KEY, normalizedRoom);

        setDisplayName(normalizedName);
        setRoomCode(normalizedRoom);
        setJoinState(newJoinState);

        await refreshJoinedState(newJoinState);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo unir.");
      } finally {
        setIsJoining(false);
      }
    },
    [displayName, ensureAnonymousSession, refreshJoinedState, roomCode, supabase, teamPreference]
  );

  const leaveRoom = useCallback(async () => {
    if (!supabase || !joinState) {
      setJoinState(null);
      return;
    }

    await supabase.rpc("leave_room", { p_room_code: joinState.roomCode });
    setJoinState(null);
    setRoom(null);
    setPlayers([]);
    setRound(null);
    setVotes(EMPTY_VOTES);
    autoTurnGuardRef.current = "";
  }, [joinState, supabase]);

  const sendHeartbeat = useCallback(async () => {
    if (!supabase || !joinState) return;
    await supabase.rpc("heartbeat", { p_room_code: joinState.roomCode });
  }, [joinState, supabase]);

  const startRound = useCallback(async () => {
    if (!supabase || !joinState) return;
    setIsStartingRound(true);
    setActionError(null);

    try {
      const { error } = await supabase.rpc("start_round", {
        p_room_code: joinState.roomCode,
        p_category: categoryFilter.trim() || null,
        p_difficulty: difficultyFilter || null
      });
      if (error) throw new Error(error.message);
      await Promise.all([loadRound(joinState.roomId), loadVotes(joinState.roomCode)]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo iniciar ronda.");
    } finally {
      setIsStartingRound(false);
    }
  }, [categoryFilter, difficultyFilter, joinState, loadRound, loadVotes, supabase]);

  const guessLetter = useCallback(
    async (letter: string) => {
      if (!supabase || !joinState || !round || round.status !== "playing") return;
      if (round.correct_letters.includes(letter) || round.wrong_letters.includes(letter)) return;

      setBusyLetter(letter);
      setActionError(null);
      try {
        const { error } = await supabase.rpc("guess_letter", {
          p_room_code: joinState.roomCode,
          p_letter: letter
        });
        if (error) throw new Error(error.message);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo enviar la letra.");
      } finally {
        setBusyLetter(null);
      }
    },
    [joinState, round, supabase]
  );

  const requestHint = useCallback(async () => {
    if (!supabase || !joinState || !round) return;
    setIsUsingHint(true);
    setActionError(null);
    try {
      const { error } = await supabase.rpc("use_hint", { p_room_code: joinState.roomCode });
      if (error) throw new Error(error.message);
      await loadRound(joinState.roomId);
      await loadPlayers(joinState.roomId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo usar pista.");
    } finally {
      setIsUsingHint(false);
    }
  }, [joinState, loadPlayers, loadRound, round, supabase]);

  const advanceTurn = useCallback(
    async (force = false) => {
      if (!supabase || !joinState || !round || round.status !== "playing") return;
      setIsSkippingTurn(true);
      try {
        const { error } = await supabase.rpc("advance_turn", {
          p_room_code: joinState.roomCode,
          p_force: force
        });
        if (error) throw new Error(error.message);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo pasar el turno.");
      } finally {
        setIsSkippingTurn(false);
      }
    },
    [joinState, round, supabase]
  );

  const setTeamMode = useCallback(
    async (enabled: boolean) => {
      if (!supabase || !joinState) return;
      setIsChangingTeamMode(true);
      setActionError(null);
      try {
        const { error } = await supabase.rpc("set_team_mode", {
          p_room_code: joinState.roomCode,
          p_enabled: enabled
        });
        if (error) throw new Error(error.message);
        await Promise.all([loadRoom(joinState.roomId), loadPlayers(joinState.roomId)]);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo cambiar modo equipos.");
      } finally {
        setIsChangingTeamMode(false);
      }
    },
    [joinState, loadPlayers, loadRoom, supabase]
  );

  const voteRematch = useCallback(async () => {
    if (!supabase || !joinState) return;
    setIsVotingRematch(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc("vote_rematch", {
        p_room_code: joinState.roomCode
      });
      if (error) throw new Error(error.message);
      const result = (Array.isArray(data) ? data[0] : data) as VoteRematchResult | null;
      await loadVotes(joinState.roomCode);
      if (result?.resolved) await loadRound(joinState.roomId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo votar revancha.");
    } finally {
      setIsVotingRematch(false);
    }
  }, [joinState, loadRound, loadVotes, supabase]);

  const voteResetScores = useCallback(async () => {
    if (!supabase || !joinState) return;
    setIsVotingReset(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc("vote_reset_scores", {
        p_room_code: joinState.roomCode
      });
      if (error) throw new Error(error.message);
      const result = (Array.isArray(data) ? data[0] : data) as VoteResetResult | null;
      if (result?.resolved) await loadPlayers(joinState.roomId);
      await loadVotes(joinState.roomCode);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo votar reset.");
    } finally {
      setIsVotingReset(false);
    }
  }, [joinState, loadPlayers, loadVotes, supabase]);

  useEffect(() => {
    if (!supabase || joinState || autoJoinTriedRef.current) return;
    autoJoinTriedRef.current = true;

    const savedName = normalizeName(window.localStorage.getItem(NAME_STORAGE_KEY) ?? "");
    const savedRoom = normalizeRoom(window.localStorage.getItem(ROOM_STORAGE_KEY) ?? "");

    if (savedName.length >= 2 && savedRoom.length >= 3) {
      void joinRoom(savedRoom, savedName);
    }
  }, [joinRoom, joinState, supabase]);

  useEffect(() => {
    if (!joinState) return;
    void sendHeartbeat();
    const interval = window.setInterval(() => {
      void sendHeartbeat();
    }, HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [joinState, sendHeartbeat]);

  useEffect(() => {
    if (!joinState || !supabase) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void sendHeartbeat();
        void refreshJoinedState(joinState);
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [joinState, refreshJoinedState, sendHeartbeat, supabase]);

  useEffect(() => {
    if (!joinState || !supabase) return;
    const roomId = joinState.roomId;

    const channel = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` }, () => {
        void loadPlayers(roomId);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rounds", filter: `room_id=eq.${roomId}` }, () => {
        void loadRound(roomId);
        void loadPlayers(roomId);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, () => {
        void loadRoom(roomId);
      })
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_votes", filter: `room_id=eq.${roomId}` },
        () => {
          void loadVotes(joinState.roomCode);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [joinState, loadPlayers, loadRoom, loadRound, loadVotes, supabase]);

  useEffect(() => {
    if (!joinState || !round || round.status !== "playing") return;

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toUpperCase();
      if (!ALPHABET.includes(key)) return;
      event.preventDefault();
      void guessLetter(key);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [guessLetter, joinState, round]);

  useEffect(() => {
    if (!round || round.status !== "playing") return;
    const interval = window.setInterval(() => setTurnTick(Date.now()), TURN_TICK_MS);
    return () => window.clearInterval(interval);
  }, [round]);

  const me = useMemo(() => {
    if (!joinState) return null;
    return players.find((player) => player.id === joinState.playerId || player.auth_user_id === authUserId) ?? null;
  }, [authUserId, joinState, players]);

  const currentTurnPlayer = useMemo(() => {
    if (!round?.active_turn_player_id) return null;
    return players.find((player) => player.id === round.active_turn_player_id) ?? null;
  }, [players, round?.active_turn_player_id]);

  const winnerName = useMemo(() => {
    if (!round?.winner_player_id) return null;
    return players.find((player) => player.id === round.winner_player_id)?.display_name ?? "Jugador";
  }, [players, round?.winner_player_id]);

  const isMyTurn = Boolean(me && round?.status === "playing" && round.active_turn_player_id === me.id);
  const canStartRound = Boolean(me?.is_host && (!round || round.status !== "playing"));
  const guessedLetters = useMemo(() => {
    if (!round) return new Set<string>();
    return new Set([...round.correct_letters, ...round.wrong_letters]);
  }, [round]);

  const teamScores = useMemo(() => {
    const teamA = players.filter((p) => p.team === "A").reduce((acc, p) => acc + p.score, 0);
    const teamB = players.filter((p) => p.team === "B").reduce((acc, p) => acc + p.score, 0);
    return { teamA, teamB };
  }, [players]);

  const turnSecondsLeft = useMemo(() => {
    if (!round || !room || round.status !== "playing") return null;
    const elapsed = Math.floor((turnTick - new Date(round.turn_started_at).getTime()) / 1000);
    return Math.max(room.turn_seconds - elapsed, 0);
  }, [room, round, turnTick]);

  useEffect(() => {
    if (!joinState || !round || round.status !== "playing" || turnSecondsLeft === null) return;
    if (turnSecondsLeft > 0) return;

    const guard = `${round.id}:${round.active_turn_player_id}:${round.turn_started_at}`;
    if (autoTurnGuardRef.current === guard) return;
    autoTurnGuardRef.current = guard;

    void advanceTurn(false);
  }, [advanceTurn, joinState, round, turnSecondsLeft]);

  if (clientError) {
    return (
      <main className="page">
        <section className="card">
          <h1>Error de configuracion</h1>
          <p>{clientError}</p>
        </section>
      </main>
    );
  }

  if (!supabase) {
    return (
      <main className="page">
        <section className="card">
          <p>Cargando cliente de Supabase...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      {!joinState ? (
        <section className="card join-card">
          <h1>Ahorcado Multiplayer</h1>
          <p className="muted">Ingresa rapido con nombre y codigo de sala.</p>

          <label htmlFor="displayName">Tu nombre</label>
          <input
            id="displayName"
            type="text"
            minLength={2}
            maxLength={24}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Ejemplo: Carla"
          />

          <label htmlFor="roomCode">Sala</label>
          <input
            id="roomCode"
            type="text"
            minLength={3}
            maxLength={16}
            value={roomCode}
            onChange={(event) => setRoomCode(normalizeRoom(event.target.value))}
            placeholder="OFICINA"
          />

          <label htmlFor="teamPreference">Preferencia de equipo</label>
          <select
            id="teamPreference"
            value={teamPreference}
            onChange={(event) => setTeamPreference(event.target.value as TeamPreference)}
          >
            <option value="AUTO">Auto</option>
            <option value="A">Equipo A</option>
            <option value="B">Equipo B</option>
          </select>

          <button type="button" onClick={() => void joinRoom()} disabled={isJoining}>
            {isJoining ? "Entrando..." : "Entrar a jugar"}
          </button>

          {actionError ? <p className="error">{actionError}</p> : null}
        </section>
      ) : (
        <section className="game-shell">
          <header className="topbar card">
            <div>
              <h1>Ahorcado - {joinState.roomCode}</h1>
              <p className="muted">
                Jugando como <strong>{me?.display_name ?? displayName}</strong> {me?.is_host ? "(Host)" : ""}
              </p>
            </div>
            <div className="topbar-actions">
              <button type="button" className="secondary" onClick={() => void leaveRoom()}>
                Salir
              </button>
            </div>
          </header>

          <div className="layout-grid">
            <section className="card board">
              <h2>Ronda actual</h2>
              {loadingRoom ? <p className="muted">Cargando sala...</p> : null}

              {!round ? (
                <p className="muted">Todavia no hay ronda activa.</p>
              ) : (
                <>
                  <p className="status">
                    {round.status === "playing" && "Adivina la palabra por turnos"}
                    {round.status === "won" && `Ronda terminada. Gano ${winnerName ?? "alguien"}.`}
                    {round.status === "lost" && "Ronda terminada. Se agotaron los errores."}
                  </p>

                  <p className="masked-word">{round.masked_word.split("").join(" ")}</p>
                  <p>
                    Categoria: <strong>{round.category}</strong> | Dificultad: <strong>{round.difficulty}</strong>
                  </p>
                  <p>
                    Errores:{" "}
                    <strong>
                      {round.errors_count}/{round.max_errors}
                    </strong>
                  </p>
                  <p>
                    Letras falladas: <strong>{round.wrong_letters.length ? round.wrong_letters.join(", ") : "-"}</strong>
                  </p>
                  <p>
                    Turno actual: <strong>{currentTurnPlayer?.display_name ?? "N/A"}</strong>{" "}
                    {turnSecondsLeft !== null ? `(${turnSecondsLeft}s)` : ""}
                  </p>
                  {round.hint_text ? (
                    <p>
                      Pista: <strong>{round.hint_text}</strong>
                    </p>
                  ) : null}
                </>
              )}

              <div className="round-actions">
                <div className="control-row">
                  <input
                    type="text"
                    placeholder="Categoria (opcional)"
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                    disabled={!canStartRound}
                  />
                  <select
                    value={difficultyFilter}
                    onChange={(event) => setDifficultyFilter(toDifficulty(event.target.value) ?? "")}
                    disabled={!canStartRound}
                  >
                    <option value="">Dificultad: cualquiera</option>
                    <option value="easy">easy</option>
                    <option value="medium">medium</option>
                    <option value="hard">hard</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => void startRound()}
                  disabled={!canStartRound || isStartingRound}
                >
                  {isStartingRound ? "Iniciando..." : round?.status === "playing" ? "Ronda en curso" : "Nueva ronda"}
                </button>

                <div className="control-row">
                  <button
                    type="button"
                    onClick={() => void requestHint()}
                    disabled={!isMyTurn || Boolean(round?.hint_used) || isUsingHint || round?.status !== "playing"}
                  >
                    {isUsingHint ? "Usando pista..." : "Usar pista (-5)"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void advanceTurn(false)}
                    disabled={!round || round.status !== "playing" || isSkippingTurn}
                  >
                    {isSkippingTurn ? "Pasando..." : "Pasar turno"}
                  </button>
                </div>

                {me?.is_host ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void setTeamMode(!room?.team_mode)}
                    disabled={isChangingTeamMode || round?.status === "playing"}
                  >
                    {isChangingTeamMode
                      ? "Actualizando..."
                      : room?.team_mode
                        ? "Desactivar equipos"
                        : "Activar equipos"}
                  </button>
                ) : null}
              </div>
            </section>

            <section className="card scoreboard">
              <h2>Ranking</h2>
              {room?.team_mode ? (
                <p className="team-score">
                  Equipo A: <strong>{teamScores.teamA}</strong> | Equipo B: <strong>{teamScores.teamB}</strong>
                </p>
              ) : null}
              {players.length === 0 ? (
                <p className="muted">No hay jugadores activos.</p>
              ) : (
                <ul>
                  {players.map((player, index) => (
                    <li key={player.id} className={player.id === me?.id ? "me" : ""}>
                      <span>
                        {index + 1}. {player.display_name} {player.team ? `[${player.team}]` : ""}{" "}
                        {player.is_host ? "(Host)" : ""} {round?.active_turn_player_id === player.id ? "-> turno" : ""}
                      </span>
                      <strong>{player.score}</strong>
                    </li>
                  ))}
                </ul>
              )}

              <div className="votes">
                <p>
                  Votos revancha: <strong>{votes.rematch_votes}</strong> / {votes.needed}
                </p>
                <p>
                  Votos reset: <strong>{votes.reset_votes}</strong> / {votes.needed}
                </p>
                <div className="control-row">
                  <button type="button" onClick={() => void voteRematch()} disabled={isVotingRematch}>
                    {isVotingRematch ? "Votando..." : "Votar revancha"}
                  </button>
                  <button type="button" className="secondary" onClick={() => void voteResetScores()} disabled={isVotingReset}>
                    {isVotingReset ? "Votando..." : "Votar reset"}
                  </button>
                </div>
              </div>
            </section>
          </div>

          <section className="card keyboard">
            <h2>Teclado</h2>
            <p className="muted">{isMyTurn ? "Es tu turno" : "Espera tu turno para jugar una letra"}</p>
            <div className="keys">
              {ALPHABET.map((letter) => {
                const alreadyUsed = guessedLetters.has(letter);
                const isBusy = busyLetter === letter;
                const disabled =
                  round?.status !== "playing" || !isMyTurn || alreadyUsed || Boolean(busyLetter) || isSkippingTurn;

                return (
                  <button
                    key={letter}
                    type="button"
                    className={`key ${alreadyUsed ? "used" : ""}`}
                    disabled={disabled}
                    onClick={() => void guessLetter(letter)}
                  >
                    {isBusy ? "..." : letter}
                  </button>
                );
              })}
            </div>
          </section>

          {actionError ? <p className="error floating-error">{actionError}</p> : null}
        </section>
      )}
    </main>
  );
}
