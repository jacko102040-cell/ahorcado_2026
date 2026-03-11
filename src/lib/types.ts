export type Team = "A" | "B";
export type Difficulty = "easy" | "medium" | "hard";

export type RoomJoinResult = {
  room_id: string;
  player_id: string;
  is_host: boolean;
  team: Team | null;
  team_mode: boolean;
};

export type PlayerRow = {
  id: string;
  room_id: string;
  auth_user_id: string;
  display_name: string;
  team: Team | null;
  turn_order: number;
  score: number;
  is_host: boolean;
  is_active: boolean;
  joined_at: string;
  last_seen_at: string;
};

export type RoundStatus = "playing" | "won" | "lost";

export type RoundRow = {
  id: string;
  room_id: string;
  status: RoundStatus;
  category: string;
  difficulty: Difficulty;
  masked_word: string;
  wrong_letters: string[];
  correct_letters: string[];
  max_errors: number;
  errors_count: number;
  points_letter: number;
  points_solve: number;
  active_turn_player_id: string | null;
  turn_started_at: string;
  hint_used: boolean;
  hint_text: string | null;
  created_by_player_id: string;
  winner_player_id: string | null;
  block_vowels: boolean;
  double_points_player_id: string | null;
  double_points_consumed: boolean;
  started_at: string;
  ended_at: string | null;
};

export type RoomRow = {
  id: string;
  code: string;
  team_mode: boolean;
  tournament_enabled: boolean;
  tournament_best_of: 3 | 5;
  turn_seconds: number;
  max_errors: number;
  created_at: string;
  current_round_id: string | null;
};

export type GuessRow = {
  id: number;
  round_id: string;
  player_id: string;
  letter: string;
  is_correct: boolean;
  created_at: string;
};

export type GameEventRow = {
  id: number;
  room_id: string;
  round_id: string | null;
  actor_player_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type QuickChatRow = {
  id: number;
  room_id: string;
  player_id: string;
  message_key: string;
  created_at: string;
};

export type LeaderboardEntry = {
  auth_user_id: string;
  display_name: string;
  value: number;
};

export type VoteStatus = {
  rematch_votes: number;
  reset_votes: number;
  free_hint_votes?: number;
  needed: number;
};

export type VoteRematchResult = {
  resolved: boolean;
  round_id: string | null;
  rematch_votes: number;
  needed: number;
};

export type VoteResetResult = {
  resolved: boolean;
  reset_votes: number;
  needed: number;
};

export type VoteFreeHintResult = {
  resolved: boolean;
  free_hint_votes: number;
  needed: number;
};

export type ActivateDoublePointsResult = {
  activated: boolean;
  consumed_for_player_id: string | null;
};

export type TournamentRow = {
  room_id: string;
  enabled: boolean;
  best_of: 3 | 5;
  created_at: string;
  updated_at: string;
};
