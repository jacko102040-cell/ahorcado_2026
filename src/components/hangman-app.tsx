"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SupabaseClient } from "@supabase/supabase-js";

import {
  ALPHABET,
  ACHIEVEMENTS_STORAGE_KEY,
  DEFAULT_ROOM_CODE,
  HEARTBEAT_MS,
  NAME_STORAGE_KEY,
  ROOM_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  TURN_TICK_MS
} from "@/lib/constants";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import {
  type ActivateDoublePointsResult,
  type Difficulty,
  type GameEventRow,
  type GuessRow,
  type LeaderboardEntry,
  type PlayerRow,
  type QuickChatRow,
  type RoomJoinResult,
  type RoomRow,
  type RoundStatus,
  type RoundRow,
  type Team,
  type VoteFreeHintResult,
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
type RoundOutcomeFx = "won" | "lost" | null;
type KeyboardTheme = "classic" | "neon" | "matrix";
type BoardTheme = "sunrise" | "dusk";
type AchievementCode = "first_win" | "score_50";
type SoundEvent = "hit" | "miss" | "win" | "loss";

type UserSettings = {
  musicEnabled: boolean;
  sfxEnabled: boolean;
  keyboardTheme: KeyboardTheme;
  boardTheme: BoardTheme;
};

type AchievementState = Record<AchievementCode, boolean>;

const EMPTY_VOTES: VoteStatus = {
  rematch_votes: 0,
  reset_votes: 0,
  free_hint_votes: 0,
  needed: 1
};

const DEFAULT_SETTINGS: UserSettings = {
  musicEnabled: true,
  sfxEnabled: true,
  keyboardTheme: "classic",
  boardTheme: "sunrise"
};

const DEFAULT_ACHIEVEMENTS: AchievementState = {
  first_win: false,
  score_50: false
};

const QUICK_CHAT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "hello", label: "Hola equipo" },
  { key: "goodluck", label: "Buena suerte" },
  { key: "nice", label: "Buena jugada" },
  { key: "oops", label: "Uy fallo" },
  { key: "gg", label: "GG" },
  { key: "rematch", label: "Revancha?" }
];

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

function parseSettings(input: string | null): UserSettings {
  if (!input) return DEFAULT_SETTINGS;
  try {
    const raw = JSON.parse(input) as Partial<UserSettings>;
    return {
      musicEnabled: raw.musicEnabled ?? DEFAULT_SETTINGS.musicEnabled,
      sfxEnabled: raw.sfxEnabled ?? DEFAULT_SETTINGS.sfxEnabled,
      keyboardTheme: raw.keyboardTheme ?? DEFAULT_SETTINGS.keyboardTheme,
      boardTheme: raw.boardTheme ?? DEFAULT_SETTINGS.boardTheme
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function parseAchievements(input: string | null): AchievementState {
  if (!input) return DEFAULT_ACHIEVEMENTS;
  try {
    const raw = JSON.parse(input) as Partial<AchievementState>;
    return {
      first_win: Boolean(raw.first_win),
      score_50: Boolean(raw.score_50)
    };
  } catch {
    return DEFAULT_ACHIEVEMENTS;
  }
}

function toFriendlyPowerupError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("could not find the function") || lower.includes("does not exist")) {
    return "Falta aplicar migracion SQL de power-ups/torneo en Supabase.";
  }
  return message;
}

function formatEventLabel(event: GameEventRow): string {
  switch (event.event_type) {
    case "join":
      return "se unio a la sala";
    case "leave":
      return "salio de la sala";
    case "start_round":
      return "inicio una nueva ronda";
    case "guess_hit":
      return `acerto ${String((event.payload?.letter as string) ?? "")}`;
    case "guess_miss":
      return `fallo ${String((event.payload?.letter as string) ?? "")}`;
    case "hint_used":
      return "uso una pista";
    case "round_won":
      return "gano la ronda";
    case "round_lost":
      return "ronda perdida";
    case "chat":
      return `chat: ${String((event.payload?.message_key as string) ?? "")}`;
    default:
      return event.event_type;
  }
}

type HangmanFigureProps = {
  errors: number;
  maxErrors: number;
  status: RoundStatus | null;
};

function HangmanFigure({ errors, maxErrors, status }: HangmanFigureProps) {
  const totalStages = 12;
  const safeMaxErrors = Math.max(1, maxErrors);
  const stage = Math.min(totalStages, Math.ceil((Math.max(0, errors) * totalStages) / safeMaxErrors));
  const progress = Math.min(100, (Math.max(0, errors) / safeMaxErrors) * 100);
  const showPart = (part: number) => `hangman-part ${stage >= part ? "visible" : ""}`;

  return (
    <div className="hangman-panel">
      <svg viewBox="0 0 160 150" aria-label="Estado del ahorcado" role="img" className="hangman-svg">
        <line x1="18" y1="136" x2="74" y2="136" className={showPart(1)} />
        <line x1="44" y1="136" x2="44" y2="20" className={showPart(2)} />
        <line x1="44" y1="20" x2="110" y2="20" className={showPart(3)} />
        <line x1="110" y1="20" x2="110" y2="36" className={showPart(4)} />
        <circle cx="110" cy="49" r="13" className={showPart(5)} />
        <line x1="110" y1="62" x2="110" y2="82" className={showPart(6)} />
        <line x1="110" y1="82" x2="110" y2="103" className={showPart(7)} />
        <line x1="110" y1="74" x2="92" y2="88" className={showPart(8)} />
        <line x1="110" y1="74" x2="128" y2="88" className={showPart(9)} />
        <line x1="110" y1="103" x2="95" y2="124" className={showPart(10)} />
        <line x1="110" y1="103" x2="125" y2="124" className={showPart(11)} />
        <path d="M104 47 L108 51 M108 47 L104 51 M112 47 L116 51 M116 47 L112 51" className={showPart(12)} />
      </svg>

      <div className="hangman-meter" aria-hidden="true">
        <div className="hangman-meter-fill" style={{ width: `${progress}%` }} />
      </div>
      <p className="muted hangman-caption">
        {status === "won" ? "Ronda ganada" : status === "lost" ? "Ahorcado completo" : `Errores ${errors}/${safeMaxErrors}`}
      </p>
    </div>
  );
}

function MaskedWordDisplay({ word }: { word: string }) {
  return (
    <p className="masked-word" aria-live="polite">
      {word.split("").map((char, index) => (
        <span key={`${index}-${char}`} className={`masked-char ${char !== "_" ? "reveal" : ""}`}>
          {char}
        </span>
      ))}
    </p>
  );
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
  const [guesses, setGuesses] = useState<GuessRow[]>([]);
  const [events, setEvents] = useState<GameEventRow[]>([]);
  const [quickChats, setQuickChats] = useState<QuickChatRow[]>([]);
  const [votes, setVotes] = useState<VoteStatus>(EMPTY_VOTES);
  const [roundOutcomeFx, setRoundOutcomeFx] = useState<RoundOutcomeFx>(null);
  const [tournamentRounds, setTournamentRounds] = useState<Array<{ id: string; winner_player_id: string | null }>>([]);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [achievements, setAchievements] = useState<AchievementState>(DEFAULT_ACHIEVEMENTS);
  const [leaderboards, setLeaderboards] = useState<{
    global: LeaderboardEntry[];
    weekly: LeaderboardEntry[];
    monthly: LeaderboardEntry[];
    season: LeaderboardEntry[];
  }>({ global: [], weekly: [], monthly: [], season: [] });
  const [profilesByUser, setProfilesByUser] = useState<Record<string, { rating: number; titles: string[] }>>({});
  const [quickChatKey, setQuickChatKey] = useState("hello");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [wordSuggestion, setWordSuggestion] = useState("");
  const [wordHint, setWordHint] = useState("");
  const [wordCategory, setWordCategory] = useState("general");
  const [wordDifficulty, setWordDifficulty] = useState<Difficulty>("medium");
  const [isSubmittingWord, setIsSubmittingWord] = useState(false);

  const [categoryFilter, setCategoryFilter] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<Difficulty | "">("");

  const [isJoining, setIsJoining] = useState(false);
  const [isStartingRound, setIsStartingRound] = useState(false);
  const [isUsingHint, setIsUsingHint] = useState(false);
  const [isChangingTeamMode, setIsChangingTeamMode] = useState(false);
  const [isVotingRematch, setIsVotingRematch] = useState(false);
  const [isVotingReset, setIsVotingReset] = useState(false);
  const [isVotingHint, setIsVotingHint] = useState(false);
  const [isSkippingTurn, setIsSkippingTurn] = useState(false);
  const [isActivatingDouble, setIsActivatingDouble] = useState(false);
  const [isTogglingBlockVowels, setIsTogglingBlockVowels] = useState(false);
  const [isUpdatingTournament, setIsUpdatingTournament] = useState(false);
  const [busyLetter, setBusyLetter] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingRoom, setLoadingRoom] = useState(false);

  const [turnTick, setTurnTick] = useState<number>(Date.now());
  const autoJoinTriedRef = useRef(false);
  const autoTurnGuardRef = useRef<string>("");
  const guessTurnGuardRef = useRef<string>("");
  const outcomeGuardRef = useRef<string>("");
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      setSupabase(getSupabaseBrowserClient());
    } catch (error) {
      setClientError(error instanceof Error ? error.message : "Failed to initialize Supabase client.");
      return;
    }

    const savedName = window.localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) setDisplayName(savedName);

    const roomFromQuery = new URLSearchParams(window.location.search).get("room");
    if (roomFromQuery) {
      setRoomCode(normalizeRoom(roomFromQuery));
    }

    const savedRoom = window.localStorage.getItem(ROOM_STORAGE_KEY);
    if (savedRoom && !roomFromQuery) setRoomCode(savedRoom);

    const savedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    setSettings(parseSettings(savedSettings));

    const savedAchievements = window.localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY);
    setAchievements(parseAchievements(savedAchievements));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify(achievements));
  }, [achievements]);

  useEffect(() => {
    setSettings((previous) => {
      let next = previous;
      if (!achievements.first_win && previous.boardTheme === "dusk") {
        next = { ...next, boardTheme: "sunrise" };
      }
      if (!achievements.first_win && previous.keyboardTheme === "neon") {
        next = { ...next, keyboardTheme: "classic" };
      }
      if (!achievements.score_50 && previous.keyboardTheme === "matrix") {
        next = { ...next, keyboardTheme: "classic" };
      }
      return next;
    });
  }, [achievements.first_win, achievements.score_50]);

  const loadRoom = useCallback(
    async (roomId: string) => {
      if (!supabase) return;

      const extendedRoomSelect =
        "id,code,team_mode,tournament_enabled,tournament_best_of,turn_seconds,max_errors,created_at,current_round_id";
      const basicRoomSelect = "id,code,team_mode,turn_seconds,max_errors,created_at,current_round_id";
      let { data, error } = await supabase.from("rooms").select(extendedRoomSelect).eq("id", roomId).limit(1);

      if (error && error.message.toLowerCase().includes("tournament_")) {
        const fallback = await supabase.from("rooms").select(basicRoomSelect).eq("id", roomId).limit(1);
        data = fallback.data as unknown as typeof data;
        error = fallback.error;
      }

      if (error) {
        setActionError(error.message);
        return;
      }

      const row = data?.[0] as RoomRow | undefined;
      if (!row) {
        setRoom(null);
        return;
      }
      setRoom({
        ...row,
        tournament_enabled: row.tournament_enabled ?? false,
        tournament_best_of: row.tournament_best_of ?? 3
      });
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

  const loadGuesses = useCallback(
    async (roundId: string | null) => {
      if (!supabase || !roundId) {
        setGuesses([]);
        return;
      }

      const { data, error } = await supabase
        .from("guesses")
        .select("id,round_id,player_id,letter,is_correct,created_at")
        .eq("round_id", roundId)
        .order("created_at", { ascending: false })
        .limit(25);

      if (error) {
        setActionError(error.message);
        return;
      }

      setGuesses((data ?? []) as GuessRow[]);
    },
    [supabase]
  );

  const loadRound = useCallback(
    async (roomId: string) => {
      if (!supabase) return;

      const extendedRoundSelect =
        "id,room_id,status,category,difficulty,masked_word,wrong_letters,correct_letters,max_errors,errors_count,points_letter,points_solve,active_turn_player_id,turn_started_at,hint_used,hint_text,created_by_player_id,winner_player_id,block_vowels,double_points_player_id,double_points_consumed,started_at,ended_at";
      const basicRoundSelect =
        "id,room_id,status,category,difficulty,masked_word,wrong_letters,correct_letters,max_errors,errors_count,points_letter,points_solve,active_turn_player_id,turn_started_at,hint_used,hint_text,created_by_player_id,winner_player_id,started_at,ended_at";
      let { data, error } = await supabase
        .from("rounds")
        .select(extendedRoundSelect)
        .eq("room_id", roomId)
        .order("started_at", { ascending: false })
        .limit(1);

      if (error && (error.message.toLowerCase().includes("block_vowels") || error.message.toLowerCase().includes("double_points"))) {
        const fallback = await supabase
          .from("rounds")
          .select(basicRoundSelect)
          .eq("room_id", roomId)
          .order("started_at", { ascending: false })
          .limit(1);
        data = fallback.data as unknown as typeof data;
        error = fallback.error;
      }

      if (error) {
        setActionError(error.message);
        return;
      }

      const latestRound = data?.[0] ? (data[0] as RoundRow) : null;
      if (!latestRound) {
        setRound(null);
        setGuesses([]);
        return;
      }
      setRound({
        ...latestRound,
        block_vowels: latestRound.block_vowels ?? false,
        double_points_player_id: latestRound.double_points_player_id ?? null,
        double_points_consumed: latestRound.double_points_consumed ?? false
      });
      await loadGuesses(latestRound?.id ?? null);
      setTurnTick(Date.now());
    },
    [loadGuesses, supabase]
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

  const loadLeaderboards = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("get_leaderboards", { p_limit: 10 });
    if (error) {
      return;
    }
    const payload = (Array.isArray(data) ? data[0] : data) as
      | {
          global?: LeaderboardEntry[];
          weekly?: LeaderboardEntry[];
          monthly?: LeaderboardEntry[];
          season?: LeaderboardEntry[];
        }
      | null;

    setLeaderboards({
      global: payload?.global ?? [],
      weekly: payload?.weekly ?? [],
      monthly: payload?.monthly ?? [],
      season: payload?.season ?? []
    });
  }, [supabase]);

  const loadRoomState = useCallback(
    async (state: JoinState): Promise<boolean> => {
      if (!supabase) return false;

      const { data, error } = await supabase.rpc("get_room_state", {
        p_room_code: state.roomCode
      });

      if (error) {
        if (error.message.toLowerCase().includes("could not find the function")) {
          return false;
        }
        setActionError(error.message);
        return false;
      }

      const payload = (Array.isArray(data) ? data[0] : data) as
        | {
            room?: RoomRow | null;
            players?: PlayerRow[];
            round?: RoundRow | null;
            guesses?: GuessRow[];
            votes?: VoteStatus;
            events?: GameEventRow[];
            quick_chats?: QuickChatRow[];
            profiles?: Array<{ auth_user_id: string; rating: number; titles: string[] }>;
          }
        | null;

      if (!payload) return false;

      setRoom(
        payload.room
          ? {
              ...payload.room,
              tournament_enabled: payload.room.tournament_enabled ?? false,
              tournament_best_of: payload.room.tournament_best_of ?? 3
            }
          : null
      );
      setPlayers(payload.players ?? []);
      setRound(
        payload.round
          ? {
              ...payload.round,
              block_vowels: payload.round.block_vowels ?? false,
              double_points_player_id: payload.round.double_points_player_id ?? null,
              double_points_consumed: payload.round.double_points_consumed ?? false
            }
          : null
      );
      setGuesses(payload.guesses ?? []);
      setVotes(payload.votes ?? EMPTY_VOTES);
      setEvents(payload.events ?? []);
      setQuickChats(payload.quick_chats ?? []);
      setProfilesByUser(
        (payload.profiles ?? []).reduce<Record<string, { rating: number; titles: string[] }>>((acc, profile) => {
          acc[profile.auth_user_id] = {
            rating: profile.rating ?? 1000,
            titles: profile.titles ?? []
          };
          return acc;
        }, {})
      );
      setTurnTick(Date.now());
      return true;
    },
    [supabase]
  );

  const loadTournamentRounds = useCallback(
    async (roomId: string) => {
      if (!supabase) return;
      const { data, error } = await supabase
        .from("rounds")
        .select("id,winner_player_id")
        .eq("room_id", roomId)
        .eq("status", "won")
        .order("started_at", { ascending: true })
        .limit(100);

      if (error) {
        setActionError(error.message);
        return;
      }

      setTournamentRounds((data ?? []) as Array<{ id: string; winner_player_id: string | null }>);
    },
    [supabase]
  );

  const refreshJoinedState = useCallback(
    async (state: JoinState) => {
      setLoadingRoom(true);
      setActionError(null);
      const loadedFromRpc = await loadRoomState(state);
      if (!loadedFromRpc) {
        await Promise.all([
          loadRoom(state.roomId),
          loadPlayers(state.roomId),
          loadRound(state.roomId),
          loadTournamentRounds(state.roomId),
          loadVotes(state.roomCode)
        ]);
      }
      await loadLeaderboards();
      setLoadingRoom(false);
    },
    [loadLeaderboards, loadPlayers, loadRoom, loadRoomState, loadRound, loadTournamentRounds, loadVotes]
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

  const unlockAchievement = useCallback((code: AchievementCode) => {
    setAchievements((previous) => {
      if (previous[code]) return previous;
      return { ...previous, [code]: true };
    });
  }, []);

  const playEventSound = useCallback(
    (event: SoundEvent) => {
      if (!settings.sfxEnabled) return;
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;

      const context = audioContextRef.current ?? new AudioContextClass();
      audioContextRef.current = context;

      const now = context.currentTime;
      const tones: Record<SoundEvent, number[]> = {
        hit: [740, 920],
        miss: [220, 170],
        win: [660, 840, 1040],
        loss: [240, 200, 160]
      };

      tones[event].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = event === "miss" || event === "loss" ? "triangle" : "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + index * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.08, now + index * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.08 + 0.16);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now + index * 0.08);
        oscillator.stop(now + index * 0.08 + 0.2);
      });
    },
    [settings.sfxEnabled]
  );

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
    setTournamentRounds([]);
    setGuesses([]);
    setEvents([]);
    setQuickChats([]);
    setLeaderboards({ global: [], weekly: [], monthly: [], season: [] });
    setProfilesByUser({});
    setVotes(EMPTY_VOTES);
    autoTurnGuardRef.current = "";
    guessTurnGuardRef.current = "";
    outcomeGuardRef.current = "";
    setRoundOutcomeFx(null);
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
      if (busyLetter) return;

      const turnKey = `${round.id}:${round.active_turn_player_id}:${round.turn_started_at}`;
      if (guessTurnGuardRef.current === turnKey) return;
      guessTurnGuardRef.current = turnKey;

      setBusyLetter(letter);
      setActionError(null);
      try {
        const { data, error } = await supabase.rpc("guess_letter", {
          p_room_code: joinState.roomCode,
          p_letter: letter
        });
        if (error) throw new Error(error.message);
        const updated = (Array.isArray(data) ? data[0] : data) as RoundRow | null;
        if (updated) {
          setRound({
            ...updated,
            block_vowels: updated.block_vowels ?? false,
            double_points_player_id: updated.double_points_player_id ?? null,
            double_points_consumed: updated.double_points_consumed ?? false
          });
          setTurnTick(Date.now());
          const isCorrect = updated.correct_letters.includes(letter);
          playEventSound(isCorrect ? "hit" : "miss");
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo enviar la letra.");
        guessTurnGuardRef.current = "";
        void refreshJoinedState(joinState);
      } finally {
        setBusyLetter(null);
      }
    },
    [busyLetter, joinState, playEventSound, refreshJoinedState, round, supabase]
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

  const voteFreeHint = useCallback(async () => {
    if (!supabase || !joinState || !round || round.status !== "playing") return;
    setIsVotingHint(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc("vote_free_hint", {
        p_room_code: joinState.roomCode
      });
      if (error) throw new Error(error.message);
      const result = (Array.isArray(data) ? data[0] : data) as VoteFreeHintResult | null;
      await loadVotes(joinState.roomCode);
      if (result?.resolved) {
        await loadRound(joinState.roomId);
      }
    } catch (error) {
      setActionError(toFriendlyPowerupError(error, "No se pudo votar pista gratis."));
    } finally {
      setIsVotingHint(false);
    }
  }, [joinState, loadRound, loadVotes, round, supabase]);

  const activateDoublePoints = useCallback(async () => {
    if (!supabase || !joinState || !round || round.status !== "playing") return;
    setIsActivatingDouble(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc("activate_double_points", {
        p_room_code: joinState.roomCode
      });
      if (error) throw new Error(error.message);
      const result = (Array.isArray(data) ? data[0] : data) as ActivateDoublePointsResult | null;
      if (result?.activated) {
        await loadRound(joinState.roomId);
      }
    } catch (error) {
      setActionError(toFriendlyPowerupError(error, "No se pudo activar doble puntaje."));
    } finally {
      setIsActivatingDouble(false);
    }
  }, [joinState, loadRound, round, supabase]);

  const setBlockVowels = useCallback(
    async (enabled: boolean) => {
      if (!supabase || !joinState || !round || round.status !== "playing") return;
      setIsTogglingBlockVowels(true);
      setActionError(null);
      try {
        const { error } = await supabase.rpc("set_block_vowels", {
          p_room_code: joinState.roomCode,
          p_enabled: enabled
        });
        if (error) throw new Error(error.message);
        await loadRound(joinState.roomId);
      } catch (error) {
        setActionError(toFriendlyPowerupError(error, "No se pudo cambiar bloqueo de vocales."));
      } finally {
        setIsTogglingBlockVowels(false);
      }
    },
    [joinState, loadRound, round, supabase]
  );

  const setTournamentMode = useCallback(
    async (enabled: boolean, bestOf: 3 | 5) => {
      if (!supabase || !joinState) return;
      setIsUpdatingTournament(true);
      setActionError(null);
      try {
        const { error } = await supabase.rpc("set_tournament_mode", {
          p_room_code: joinState.roomCode,
          p_enabled: enabled,
          p_best_of: bestOf
        });
        if (error) throw new Error(error.message);
        await Promise.all([loadRoom(joinState.roomId), loadTournamentRounds(joinState.roomId)]);
      } catch (error) {
        setActionError(toFriendlyPowerupError(error, "No se pudo actualizar torneo."));
      } finally {
        setIsUpdatingTournament(false);
      }
    },
    [joinState, loadRoom, loadTournamentRounds, supabase]
  );

  const sendQuickChat = useCallback(async () => {
    if (!supabase || !joinState) return;
    setIsSendingChat(true);
    setActionError(null);
    try {
      const { error } = await supabase.rpc("send_quick_chat", {
        p_room_code: joinState.roomCode,
        p_message_key: quickChatKey
      });
      if (error) throw new Error(error.message);
      await refreshJoinedState(joinState);
    } catch (error) {
      setActionError(toFriendlyPowerupError(error, "No se pudo enviar chat rapido."));
    } finally {
      setIsSendingChat(false);
    }
  }, [joinState, quickChatKey, refreshJoinedState, supabase]);

  const submitWordSuggestion = useCallback(async () => {
    if (!supabase || !joinState) return;
    setIsSubmittingWord(true);
    setActionError(null);
    try {
      const { error } = await supabase.rpc("submit_word_suggestion", {
        p_word: wordSuggestion,
        p_hint: wordHint || null,
        p_category: wordCategory,
        p_difficulty: wordDifficulty
      });
      if (error) throw new Error(error.message);
      setWordSuggestion("");
      setWordHint("");
      setActionError("Sugerencia enviada para moderacion.");
    } catch (error) {
      setActionError(toFriendlyPowerupError(error, "No se pudo enviar sugerencia."));
    } finally {
      setIsSubmittingWord(false);
    }
  }, [joinState, supabase, wordCategory, wordDifficulty, wordHint, wordSuggestion]);

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
    const bgm = bgmRef.current;
    if (!bgm) return;
    if (!joinState || !settings.musicEnabled) {
      bgm.pause();
      return;
    }

    bgm.volume = 0.28;
    void bgm.play().catch(() => {
      // Autoplay can fail until user interacts again.
    });
  }, [joinState, settings.musicEnabled]);

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

    const refresh = () => {
      void refreshJoinedState(joinState);
    };

    const channel = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "rounds", filter: `room_id=eq.${roomId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, refresh)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_votes", filter: `room_id=eq.${roomId}` },
        refresh
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "game_events", filter: `room_id=eq.${roomId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "quick_chats", filter: `room_id=eq.${roomId}` }, refresh)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [joinState, refreshJoinedState, supabase]);

  useEffect(() => {
    if (!joinState || !round || round.status !== "playing" || round.active_turn_player_id !== joinState.playerId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toUpperCase();
      if (!ALPHABET.includes(key)) return;
      if (round.block_vowels && ["A", "E", "I", "O", "U"].includes(key)) return;
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

  useEffect(() => {
    if (!round) {
      setRoundOutcomeFx(null);
      return;
    }
    if (round.status !== "won" && round.status !== "lost") {
      setRoundOutcomeFx(null);
      return;
    }

    const guard = `${round.id}:${round.status}`;
    if (outcomeGuardRef.current === guard) return;
    outcomeGuardRef.current = guard;
    setRoundOutcomeFx(round.status);
    playEventSound(round.status === "won" ? "win" : "loss");

    if (round.status === "won" && joinState && round.winner_player_id === joinState.playerId) {
      unlockAchievement("first_win");
    }

    const timer = window.setTimeout(() => {
      setRoundOutcomeFx(null);
    }, 2600);

    return () => window.clearTimeout(timer);
  }, [joinState, playEventSound, round, unlockAchievement]);

  const me = useMemo(() => {
    if (!joinState) return null;
    return players.find((player) => player.id === joinState.playerId || player.auth_user_id === authUserId) ?? null;
  }, [authUserId, joinState, players]);

  useEffect(() => {
    if (!me) return;
    if (me.score >= 50) {
      unlockAchievement("score_50");
    }
  }, [me, unlockAchievement]);

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
  const canActivateDouble = Boolean(
    isMyTurn &&
      round?.status === "playing" &&
      !round.double_points_consumed &&
      (!round.double_points_player_id || round.double_points_player_id === me?.id)
  );
  const guessedLetters = useMemo(() => {
    if (!round) return new Set<string>();
    return new Set([...round.correct_letters, ...round.wrong_letters]);
  }, [round]);

  const teamScores = useMemo(() => {
    const teamA = players.filter((p) => p.team === "A").reduce((acc, p) => acc + p.score, 0);
    const teamB = players.filter((p) => p.team === "B").reduce((acc, p) => acc + p.score, 0);
    return { teamA, teamB };
  }, [players]);
  const playerNameById = useMemo(() => {
    return new Map(players.map((player) => [player.id, player.display_name]));
  }, [players]);
  const inviteLink = useMemo(() => {
    if (!joinState || typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.searchParams.set("room", joinState.roomCode);
    return url.toString();
  }, [joinState]);

  const copyInviteLink = useCallback(async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setActionError("Link de invitacion copiado.");
    } catch {
      setActionError("No se pudo copiar el link.");
    }
  }, [inviteLink]);

  const tournamentTargetWins = useMemo(() => {
    const bestOf = room?.tournament_best_of ?? 3;
    return Math.ceil(bestOf / 2);
  }, [room?.tournament_best_of]);

  const tournamentStanding = useMemo(() => {
    if (!room?.tournament_enabled) return [] as Array<{ key: string; label: string; wins: number }>;

    const counters = new Map<string, number>();
    tournamentRounds.forEach((entry) => {
      if (!entry.winner_player_id) return;
      const winner = players.find((player) => player.id === entry.winner_player_id);
      if (room.team_mode) {
        const team = winner?.team;
        if (!team) return;
        counters.set(team, (counters.get(team) ?? 0) + 1);
        return;
      }
      counters.set(entry.winner_player_id, (counters.get(entry.winner_player_id) ?? 0) + 1);
    });

    return Array.from(counters.entries())
      .map(([key, wins]) => ({
        key,
        wins,
        label: room.team_mode ? `Equipo ${key}` : (playerNameById.get(key) ?? "Jugador")
      }))
      .sort((a, b) => b.wins - a.wins);
  }, [playerNameById, players, room?.team_mode, room?.tournament_enabled, tournamentRounds]);

  const tournamentChampion = useMemo(() => {
    const leader = tournamentStanding[0];
    if (!leader) return null;
    if (leader.wins < tournamentTargetWins) return null;
    return leader;
  }, [tournamentStanding, tournamentTargetWins]);

  const unlockedKeyboardThemes = useMemo(() => {
    return {
      classic: true,
      neon: achievements.first_win,
      matrix: achievements.score_50
    };
  }, [achievements]);

  const turnSecondsLeft = useMemo(() => {
    if (!round || !room || round.status !== "playing") return null;
    const elapsed = Math.floor((turnTick - new Date(round.turn_started_at).getTime()) / 1000);
    return Math.max(room.turn_seconds - elapsed, 0);
  }, [room, round, turnTick]);
  const isTurnCritical = Boolean(round?.status === "playing" && turnSecondsLeft !== null && turnSecondsLeft <= 5);
  const turnGuardKey = useMemo(
    () => (round ? `${round.id}:${round.active_turn_player_id ?? "none"}:${round.turn_started_at}` : ""),
    [round]
  );

  useEffect(() => {
    guessTurnGuardRef.current = "";
  }, [turnGuardKey]);

  useEffect(() => {
    if (!joinState || !round || round.status !== "playing" || turnSecondsLeft === null || !isMyTurn) return;
    if (turnSecondsLeft > 0) return;

    const guard = `${round.id}:${round.active_turn_player_id}:${round.turn_started_at}`;
    if (autoTurnGuardRef.current === guard) return;
    autoTurnGuardRef.current = guard;

    void advanceTurn(false);
  }, [advanceTurn, isMyTurn, joinState, round, turnSecondsLeft]);

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
    <main className={`page board-theme-${settings.boardTheme}`}>
      <audio ref={bgmRef} src="/music/bg-game.mp3" loop preload="auto" />
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
              <label className="inline setting-toggle">
                <input
                  type="checkbox"
                  checked={settings.musicEnabled}
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, musicEnabled: event.target.checked }))
                  }
                />
                Musica
              </label>
              <label className="inline setting-toggle">
                <input
                  type="checkbox"
                  checked={settings.sfxEnabled}
                  onChange={(event) =>
                    setSettings((previous) => ({ ...previous, sfxEnabled: event.target.checked }))
                  }
                />
                SFX
              </label>
              <select
                className="compact-select"
                value={settings.keyboardTheme}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    keyboardTheme: event.target.value as KeyboardTheme
                  }))
                }
              >
                <option value="classic">Teclado classic</option>
                <option value="neon" disabled={!unlockedKeyboardThemes.neon}>
                  Teclado neon {unlockedKeyboardThemes.neon ? "" : "(bloqueado)"}
                </option>
                <option value="matrix" disabled={!unlockedKeyboardThemes.matrix}>
                  Teclado matrix {unlockedKeyboardThemes.matrix ? "" : "(bloqueado)"}
                </option>
              </select>
              <select
                className="compact-select"
                value={settings.boardTheme}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    boardTheme: event.target.value as BoardTheme
                  }))
                }
              >
                <option value="sunrise">Tema sunrise</option>
                <option value="dusk" disabled={!achievements.first_win}>
                  Tema dusk {achievements.first_win ? "" : "(bloqueado)"}
                </option>
              </select>
              <button type="button" className="secondary" onClick={() => void copyInviteLink()}>
                Copiar invitacion
              </button>
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
                  {roundOutcomeFx ? (
                    <div className={`round-fx ${roundOutcomeFx}`}>
                      <span>{roundOutcomeFx === "won" ? `Victoria de ${winnerName ?? "jugador"}` : "Ronda perdida"}</span>
                      {roundOutcomeFx === "won" ? (
                        <div className="fx-confetti" aria-hidden="true">
                          {Array.from({ length: 14 }).map((_, index) => (
                            <i key={`confetti-${index}`} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <p className="status">
                    {round.status === "playing" && "Adivina la palabra por turnos"}
                    {round.status === "won" && `Ronda terminada. Gano ${winnerName ?? "alguien"}.`}
                    {round.status === "lost" && "Ronda terminada. Se agotaron los errores."}
                  </p>

                  <div className="round-stage">
                    <HangmanFigure errors={round.errors_count} maxErrors={round.max_errors} status={round.status} />
                    <div className="round-meta">
                      <p>
                        Categoria: <strong>{round.category}</strong>
                      </p>
                      <p>
                        Dificultad: <strong>{round.difficulty}</strong>
                      </p>
                      <p>
                        Vocales: <strong>{round.block_vowels ? "bloqueadas" : "libres"}</strong>
                      </p>
                      <p>
                        Letras falladas:{" "}
                        <strong>{round.wrong_letters.length ? round.wrong_letters.join(", ") : "-"}</strong>
                      </p>
                    </div>
                  </div>

                  <MaskedWordDisplay word={round.masked_word} />

                  <p className={`turn-indicator ${isTurnCritical ? "critical" : ""}`}>
                    Turno actual: <strong>{currentTurnPlayer?.display_name ?? "N/A"}</strong>{" "}
                    {turnSecondsLeft !== null ? `(${turnSecondsLeft}s)` : ""}
                  </p>
                  {round.hint_text ? (
                    <p>
                      Pista: <strong>{round.hint_text}</strong>
                    </p>
                  ) : null}

                  <section className="timeline">
                    <h3>Timeline</h3>
                    {guesses.length === 0 ? (
                      <p className="muted">Sin jugadas todavia.</p>
                    ) : (
                      <ul>
                        {guesses.map((guess) => (
                          <li key={guess.id} className={guess.is_correct ? "hit" : "miss"}>
                            <span className="timeline-icon">{guess.is_correct ? "OK" : "X"}</span>
                            <span>
                              <strong>{playerNameById.get(guess.player_id) ?? "Jugador"}</strong>{" "}
                              {guess.is_correct ? "acerto" : "fallo"} la letra <strong>{guess.letter}</strong>
                            </span>
                            <time dateTime={guess.created_at}>
                              {new Date(guess.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </time>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
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

                <section className="powerups">
                  <h3>Power-ups</h3>
                  <p className="muted">
                    {round?.double_points_player_id
                      ? `Doble puntaje activo: ${playerNameById.get(round.double_points_player_id) ?? "Jugador"}`
                      : "Doble puntaje disponible"}
                  </p>
                  {round?.block_vowels ? <p className="muted">Bloqueo de vocales: activo</p> : null}
                  <div className="control-row">
                    <button type="button" onClick={() => void activateDoublePoints()} disabled={!canActivateDouble || isActivatingDouble}>
                      {isActivatingDouble ? "Activando..." : "Doble puntaje x1 turno"}
                    </button>
                    <button type="button" onClick={() => void voteFreeHint()} disabled={isVotingHint || round?.status !== "playing"}>
                      {isVotingHint ? "Votando..." : "Votar pista gratis"}
                    </button>
                  </div>
                  {me?.is_host ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void setBlockVowels(!round?.block_vowels)}
                      disabled={isTogglingBlockVowels || round?.status !== "playing"}
                    >
                      {isTogglingBlockVowels
                        ? "Actualizando..."
                        : round?.block_vowels
                          ? "Desactivar bloqueo vocales"
                          : "Activar bloqueo vocales"}
                    </button>
                  ) : null}
                </section>

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
                        {profilesByUser[player.auth_user_id] ? (
                          <>
                            {" "}
                            | ELO <strong>{profilesByUser[player.auth_user_id].rating}</strong>
                          </>
                        ) : null}
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
                <p>
                  Votos pista gratis: <strong>{votes.free_hint_votes ?? 0}</strong> / {votes.needed}
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

              <section className="tournament">
                <h3>Torneo</h3>
                <p className="muted">
                  {room?.tournament_enabled
                    ? `Best-of-${room.tournament_best_of} (meta ${tournamentTargetWins} victorias)`
                    : "Torneo desactivado"}
                </p>
                {room?.tournament_enabled && tournamentStanding.length ? (
                  <ul className="tournament-list">
                    {tournamentStanding.map((entry) => (
                      <li key={entry.key}>
                        <span>{entry.label}</span>
                        <strong>
                          {entry.wins}/{tournamentTargetWins}
                        </strong>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tournamentChampion ? <p className="tournament-champion">Campeon: {tournamentChampion.label}</p> : null}
                {me?.is_host ? (
                  <div className="control-row">
                    <button
                      type="button"
                      onClick={() => void setTournamentMode(!(room?.tournament_enabled ?? false), room?.tournament_best_of ?? 3)}
                      disabled={isUpdatingTournament}
                    >
                      {isUpdatingTournament
                        ? "Actualizando..."
                        : room?.tournament_enabled
                          ? "Desactivar torneo"
                          : "Activar torneo"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void setTournamentMode(room?.tournament_enabled ?? true, room?.tournament_best_of === 5 ? 3 : 5)
                      }
                      disabled={isUpdatingTournament}
                    >
                      Cambiar a Bo{room?.tournament_best_of === 5 ? "3" : "5"}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="achievements">
                <h3>Logros</h3>
                <ul className="achievement-list">
                  <li className={achievements.first_win ? "done" : ""}>
                    {achievements.first_win ? "Desbloqueado" : "Pendiente"}: Ganar 1 ronda
                  </li>
                  <li className={achievements.score_50 ? "done" : ""}>
                    {achievements.score_50 ? "Desbloqueado" : "Pendiente"}: Llegar a 50 puntos
                  </li>
                </ul>
              </section>

              <section className="social-panel">
                <h3>Chat rapido</h3>
                <div className="control-row">
                  <select value={quickChatKey} onChange={(event) => setQuickChatKey(event.target.value)}>
                    {QUICK_CHAT_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void sendQuickChat()} disabled={isSendingChat}>
                    {isSendingChat ? "Enviando..." : "Enviar"}
                  </button>
                </div>
                <ul className="chat-list">
                  {quickChats.slice(0, 6).map((chat) => (
                    <li key={chat.id}>
                      <strong>{playerNameById.get(chat.player_id) ?? "Jugador"}:</strong>{" "}
                      {QUICK_CHAT_OPTIONS.find((option) => option.key === chat.message_key)?.label ?? chat.message_key}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="social-panel">
                <h3>Feed de sistema</h3>
                <ul className="event-list">
                  {events.slice(0, 8).map((event) => (
                    <li key={event.id}>
                      <strong>{event.actor_player_id ? (playerNameById.get(event.actor_player_id) ?? "Jugador") : "Sistema"}</strong>{" "}
                      {formatEventLabel(event)}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="social-panel">
                <h3>Leaderboards</h3>
                <div className="leaderboard-grid">
                  <div className="leaderboard-block">
                    <p className="muted">Global ELO</p>
                    <ul className="mini-list">
                      {leaderboards.global.slice(0, 5).map((entry) => (
                        <li key={`global-${entry.auth_user_id}`}>
                          <span>{entry.display_name}</span>
                          <strong>{entry.value}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="leaderboard-block">
                    <p className="muted">Semanal</p>
                    <ul className="mini-list">
                      {leaderboards.weekly.slice(0, 5).map((entry) => (
                        <li key={`weekly-${entry.auth_user_id}`}>
                          <span>{entry.display_name}</span>
                          <strong>{entry.value}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="leaderboard-block">
                    <p className="muted">Mensual</p>
                    <ul className="mini-list">
                      {leaderboards.monthly.slice(0, 5).map((entry) => (
                        <li key={`monthly-${entry.auth_user_id}`}>
                          <span>{entry.display_name}</span>
                          <strong>{entry.value}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="leaderboard-block">
                    <p className="muted">Temporada</p>
                    <ul className="mini-list">
                      {leaderboards.season.slice(0, 5).map((entry) => (
                        <li key={`season-${entry.auth_user_id}`}>
                          <span>{entry.display_name}</span>
                          <strong>{entry.value}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>

              <section className="social-panel">
                <h3>Sugerir palabra</h3>
                <div className="suggest-grid">
                  <input
                    type="text"
                    placeholder="PALABRA"
                    value={wordSuggestion}
                    onChange={(event) => setWordSuggestion(event.target.value.toUpperCase())}
                  />
                  <input
                    type="text"
                    placeholder="Pista"
                    value={wordHint}
                    onChange={(event) => setWordHint(event.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Categoria"
                    value={wordCategory}
                    onChange={(event) => setWordCategory(event.target.value.toLowerCase())}
                  />
                  <div className="suggest-actions">
                    <select value={wordDifficulty} onChange={(event) => setWordDifficulty(event.target.value as Difficulty)}>
                      <option value="easy">easy</option>
                      <option value="medium">medium</option>
                      <option value="hard">hard</option>
                    </select>
                    <button type="button" onClick={() => void submitWordSuggestion()} disabled={isSubmittingWord}>
                      {isSubmittingWord ? "Enviando..." : "Enviar"}
                    </button>
                  </div>
                </div>
              </section>
            </section>
          </div>

          <section className="card keyboard">
            <h2>Teclado</h2>
            <p className="muted">{isMyTurn ? "Es tu turno" : "Espera tu turno para jugar una letra"}</p>
            <div className={`keys theme-${settings.keyboardTheme}`}>
              {ALPHABET.map((letter) => {
                const alreadyUsed = guessedLetters.has(letter);
                const isBusy = busyLetter === letter;
                const blockedByVowel = Boolean(round?.block_vowels && ["A", "E", "I", "O", "U"].includes(letter));
                const disabled =
                  round?.status !== "playing" ||
                  !isMyTurn ||
                  alreadyUsed ||
                  Boolean(busyLetter) ||
                  isSkippingTurn ||
                  blockedByVowel;

                return (
                  <button
                    key={letter}
                    type="button"
                    className={`key ${alreadyUsed ? "used" : ""} ${blockedByVowel ? "blocked" : ""}`}
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
