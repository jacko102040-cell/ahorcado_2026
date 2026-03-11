
-- Ahorcado multiplayer avanzado (fase 1 + extras)
-- Ejecucion recomendada: proyecto Supabase nuevo o DB reset

create extension if not exists pgcrypto;

-- ===== Reset (desarrollo) =====
drop table if exists public.room_votes cascade;
drop table if exists public.guesses cascade;
drop table if exists public.round_secrets cascade;
drop table if exists public.rounds cascade;
drop table if exists public.players cascade;
drop table if exists public.rooms cascade;
drop table if exists public.words cascade;

-- ===== Helpers =====
create or replace function public.normalize_room_code(p_code text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(trim(coalesce(p_code, '')), '[^A-Z0-9_-]', '', 'g'));
$$;

create or replace function public.normalize_name(p_name text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
$$;

create or replace function public.normalize_letter(p_letter text)
returns text
language sql
immutable
as $$
  select upper(trim(coalesce(p_letter, '')));
$$;

create or replace function public.normalize_team(p_team text)
returns text
language sql
immutable
as $$
  select case
    when upper(trim(coalesce(p_team, ''))) in ('A', 'B') then upper(trim(p_team))
    else null
  end;
$$;

create or replace function public.normalize_difficulty(p_difficulty text)
returns text
language sql
immutable
as $$
  select case
    when lower(trim(coalesce(p_difficulty, ''))) in ('easy', 'medium', 'hard') then lower(trim(p_difficulty))
    else null
  end;
$$;

create or replace function public.build_masked_word(p_word text, p_hits text[])
returns text
language plpgsql
immutable
as $$
declare
  i int;
  ch text;
  out_word text := '';
  target text := upper(coalesce(p_word, ''));
  hits text[] := coalesce(p_hits, '{}');
begin
  for i in 1..char_length(target) loop
    ch := substr(target, i, 1);
    if ch ~ '[A-Z]' and not (ch = any(hits)) then
      out_word := out_word || '_';
    else
      out_word := out_word || ch;
    end if;
  end loop;
  return out_word;
end;
$$;

create or replace function public.needed_votes(p_total_players int)
returns int
language sql
immutable
as $$
  select greatest(1, ceil(greatest(0, p_total_players)::numeric / 2.0)::int);
$$;

-- ===== Tables =====
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) between 3 and 16),
  team_mode boolean not null default false,
  turn_seconds int not null default 10 check (turn_seconds between 8 and 90),
  max_errors int not null default 6 check (max_errors between 3 and 12),
  created_at timestamptz not null default now(),
  current_round_id uuid null
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  team text null check (team in ('A', 'B')),
  turn_order int not null,
  score int not null default 0,
  is_host boolean not null default false,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(room_id, auth_user_id)
);

create index idx_players_room on public.players(room_id);
create index idx_players_room_active on public.players(room_id, is_active);
create index idx_players_room_turn on public.players(room_id, turn_order);

create table public.words (
  id bigserial primary key,
  word text not null unique,
  hint text null,
  category text not null default 'general',
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  language text not null default 'es',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  status text not null check (status in ('playing', 'won', 'lost')),
  category text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  masked_word text not null,
  wrong_letters text[] not null default '{}',
  correct_letters text[] not null default '{}',
  max_errors int not null default 6 check (max_errors between 3 and 12),
  errors_count int not null default 0 check (errors_count >= 0),
  points_letter int not null,
  points_solve int not null,
  active_turn_player_id uuid null references public.players(id),
  turn_started_at timestamptz not null default now(),
  hint_used boolean not null default false,
  hint_text text null,
  created_by_player_id uuid not null references public.players(id),
  winner_player_id uuid null references public.players(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz null
);

create index idx_rounds_room on public.rounds(room_id);
create index idx_rounds_room_status on public.rounds(room_id, status);

create table public.round_secrets (
  round_id uuid primary key references public.rounds(id) on delete cascade,
  word text not null,
  hint text null
);

create table public.guesses (
  id bigserial primary key,
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  letter text not null check (char_length(letter) = 1),
  is_correct boolean not null,
  created_at timestamptz not null default now(),
  unique(round_id, letter)
);

create index idx_guesses_round on public.guesses(round_id);

create table public.room_votes (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  vote_type text not null check (vote_type in ('rematch', 'reset_scores', 'free_hint', 'ready_start')),
  player_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(room_id, vote_type, player_id)
);

create index idx_room_votes_room on public.room_votes(room_id, vote_type);

alter table public.rooms
  add constraint rooms_current_round_fk
  foreign key (current_round_id) references public.rounds(id) on delete set null;

-- ===== Internal helpers =====
create or replace function public.get_next_turn_player(p_room_id uuid, p_after_player_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after_order int;
  v_next uuid;
begin
  if p_after_player_id is not null then
    select turn_order into v_after_order
    from public.players
    where id = p_after_player_id
      and room_id = p_room_id;
  end if;

  if v_after_order is not null then
    select id into v_next
    from public.players
    where room_id = p_room_id
      and is_active = true
      and (
        turn_order > v_after_order
        or (turn_order = v_after_order and id > p_after_player_id)
      )
    order by turn_order asc, id asc
    limit 1;
  end if;

  if v_next is null then
    select id into v_next
    from public.players
    where room_id = p_room_id
      and is_active = true
      and (p_after_player_id is null or id <> p_after_player_id)
    order by turn_order asc, id asc
    limit 1;
  end if;

  if v_next is null and p_after_player_id is not null then
    select id into v_next
    from public.players
    where room_id = p_room_id
      and is_active = true
    order by turn_order asc, id asc
    limit 1;
  end if;

  return v_next;
end;
$$;

create or replace function public.ensure_host(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_host uuid;
begin
  select id into v_host
  from public.players
  where room_id = p_room_id
    and is_active = true
    and is_host = true
  limit 1;

  if v_host is null then
    select id into v_host
    from public.players
    where room_id = p_room_id
      and is_active = true
    order by joined_at asc
    limit 1;

    if v_host is not null then
      update public.players
      set is_host = (id = v_host)
      where room_id = p_room_id
        and is_active = true;
    end if;
  end if;
end;
$$;

create or replace function public.start_round_internal(
  p_room_id uuid,
  p_created_by uuid,
  p_category text default null,
  p_difficulty text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word text;
  v_hint text;
  v_category text;
  v_difficulty text;
  v_round_id uuid;
  v_masked text;
  v_points_letter int;
  v_points_solve int;
  v_turn_player uuid;
  v_room public.rooms%rowtype;
begin
  select * into v_room
  from public.rooms
  where id = p_room_id
  for update;

  if exists (
    select 1
    from public.rounds
    where room_id = p_room_id
      and status = 'playing'
  ) then
    raise exception 'Round already in progress';
  end if;

  select upper(word), hint, lower(category), difficulty
  into v_word, v_hint, v_category, v_difficulty
  from public.words
  where is_active = true
    and language = 'es'
    and (p_category is null or lower(category) = lower(p_category))
    and (p_difficulty is null or difficulty = normalize_difficulty(p_difficulty))
  order by random()
  limit 1;

  if v_word is null then
    raise exception 'No words for the selected filters';
  end if;

  if v_difficulty = 'easy' then
    v_points_letter := 2;
    v_points_solve := 10;
  elsif v_difficulty = 'hard' then
    v_points_letter := 4;
    v_points_solve := 20;
  else
    v_points_letter := 3;
    v_points_solve := 15;
  end if;

  v_turn_player := public.get_next_turn_player(p_room_id, null);
  if v_turn_player is null then
    raise exception 'No active players in room';
  end if;

  v_masked := public.build_masked_word(v_word, '{}');

  insert into public.rounds(
    room_id,
    status,
    category,
    difficulty,
    masked_word,
    max_errors,
    points_letter,
    points_solve,
    active_turn_player_id,
    created_by_player_id
  )
  values (
    p_room_id,
    'playing',
    coalesce(v_category, 'general'),
    v_difficulty,
    v_masked,
    v_room.max_errors,
    v_points_letter,
    v_points_solve,
    v_turn_player,
    p_created_by
  )
  returning id into v_round_id;

  insert into public.round_secrets(round_id, word, hint)
  values (v_round_id, v_word, v_hint);

  update public.rooms
  set current_round_id = v_round_id
  where id = p_room_id;

  delete from public.room_votes
  where room_id = p_room_id
    and vote_type in ('rematch', 'ready_start');

  return v_round_id;
end;
$$;

create or replace function public.prune_inactive_players(p_room_code text, p_stale_seconds int default 75)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_round public.rounds%rowtype;
  v_next_turn uuid;
begin
  select id into v_room_id
  from public.rooms
  where code = v_code;

  if v_room_id is null then
    return;
  end if;

  update public.players
  set is_active = false,
      is_host = false
  where room_id = v_room_id
    and is_active = true
    and last_seen_at < now() - make_interval(secs => greatest(10, p_stale_seconds));

  delete from public.room_votes v
  using public.players p
  where v.room_id = v_room_id
    and v.vote_type = 'ready_start'
    and v.player_id = p.id
    and p.room_id = v_room_id
    and p.is_active = false;

  perform public.ensure_host(v_room_id);

  select * into v_round
  from public.rounds
  where room_id = v_room_id
    and status = 'playing'
  order by started_at desc
  limit 1
  for update;

  if v_round.id is null then
    return;
  end if;

  if v_round.active_turn_player_id is null or not exists (
    select 1
    from public.players p
    where p.id = v_round.active_turn_player_id
      and p.is_active = true
  ) then
    v_next_turn := public.get_next_turn_player(v_room_id, v_round.active_turn_player_id);

    if v_next_turn is null then
      update public.rounds
      set status = 'lost',
          ended_at = now()
      where id = v_round.id;
    else
      update public.rounds
      set active_turn_player_id = v_next_turn,
          turn_started_at = now()
      where id = v_round.id;
    end if;
  end if;
end;
$$;

-- ===== RLS =====
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.rounds enable row level security;
alter table public.round_secrets enable row level security;
alter table public.guesses enable row level security;
alter table public.words enable row level security;
alter table public.room_votes enable row level security;

drop policy if exists rooms_select_member on public.rooms;
drop policy if exists players_select_same_room on public.players;
drop policy if exists rounds_select_same_room on public.rounds;
drop policy if exists guesses_select_same_room on public.guesses;
drop policy if exists room_votes_select_same_room on public.room_votes;
drop policy if exists deny_words_all on public.words;
drop policy if exists deny_round_secrets_all on public.round_secrets;

create or replace function public.is_room_member(p_room_id uuid, p_uid uuid default auth.uid())
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.players p
    where p.room_id = p_room_id
      and p.auth_user_id = p_uid
      and p.is_active = true
  );
$$;

create policy rooms_select_member
on public.rooms
for select
to authenticated
using (
  public.is_room_member(rooms.id)
);

create policy players_select_same_room
on public.players
for select
to authenticated
using (
  public.is_room_member(players.room_id)
);

create policy rounds_select_same_room
on public.rounds
for select
to authenticated
using (
  public.is_room_member(rounds.room_id)
);

create policy guesses_select_same_room
on public.guesses
for select
to authenticated
using (
  exists (
    select 1
    from public.rounds r
    where r.id = guesses.round_id
      and public.is_room_member(r.room_id)
  )
);

create policy room_votes_select_same_room
on public.room_votes
for select
to authenticated
using (
  public.is_room_member(room_votes.room_id)
);

create policy deny_words_all
on public.words
for all
to authenticated
using (false)
with check (false);

create policy deny_round_secrets_all
on public.round_secrets
for all
to authenticated
using (false)
with check (false);

revoke insert, update, delete on public.rooms from authenticated;
revoke insert, update, delete on public.players from authenticated;
revoke insert, update, delete on public.rounds from authenticated;
revoke insert, update, delete on public.guesses from authenticated;
revoke insert, update, delete on public.room_votes from authenticated;
revoke all on public.round_secrets from authenticated;
revoke all on public.words from authenticated;

-- ===== Public RPC =====
create or replace function public.join_room(
  p_room_code text,
  p_display_name text,
  p_requested_team text default null
)
returns table(
  room_id uuid,
  player_id uuid,
  is_host boolean,
  team text,
  team_mode boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_name text := public.normalize_name(p_display_name);
  v_req_team text := public.normalize_team(p_requested_team);
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_turn_order int;
  v_team text;
  v_count_a int;
  v_count_b int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if char_length(v_code) < 3 or char_length(v_code) > 16 then
    raise exception 'Room code must be 3..16 chars';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 24 then
    raise exception 'Name must be 2..24 chars';
  end if;

  insert into public.rooms(code)
  values (v_code)
  on conflict (code) do nothing;

  select * into v_room
  from public.rooms
  where code = v_code
  for update;

  perform public.prune_inactive_players(v_code, 75);

  select p.* into v_player
  from public.players p
  where p.room_id = v_room.id
    and p.auth_user_id = v_uid;

  if v_player.id is null then
    select coalesce(max(turn_order), 0) + 1 into v_turn_order
    from public.players p
    where p.room_id = v_room.id;
  else
    v_turn_order := v_player.turn_order;
  end if;

  v_team := v_player.team;

  if v_room.team_mode then
    if v_team is null then
      select count(*)::int into v_count_a
      from public.players p
      where p.room_id = v_room.id and p.is_active = true and p.team = 'A';

      select count(*)::int into v_count_b
      from public.players p
      where p.room_id = v_room.id and p.is_active = true and p.team = 'B';

      if v_req_team is not null and abs(v_count_a - v_count_b) <= 1 then
        v_team := v_req_team;
      elsif v_count_a <= v_count_b then
        v_team := 'A';
      else
        v_team := 'B';
      end if;
    end if;
  else
    v_team := null;
  end if;

  insert into public.players(room_id, auth_user_id, display_name, team, turn_order, is_active, last_seen_at)
  values (v_room.id, v_uid, v_name, v_team, v_turn_order, true, now())
  on conflict on constraint players_room_id_auth_user_id_key
  do update
     set display_name = excluded.display_name,
         team = excluded.team,
         turn_order = excluded.turn_order,
         is_active = true,
         last_seen_at = now()
  returning * into v_player;

  perform public.ensure_host(v_room.id);

  select * into v_player
  from public.players
  where id = v_player.id;

  return query
  select v_room.id, v_player.id, v_player.is_host, v_player.team, v_room.team_mode;
end;
$$;

create or replace function public.set_team_mode(p_room_code text, p_enabled boolean)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.* into v_room
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  select p.* into v_player
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room.id is null then
    raise exception 'Player not in room';
  end if;
  if not v_player.is_host then
    raise exception 'Only host can change team mode';
  end if;
  if exists (
    select 1 from public.rounds
    where room_id = v_room.id and status = 'playing'
  ) then
    raise exception 'Cannot change team mode during a round';
  end if;

  update public.rooms
  set team_mode = p_enabled
  where id = v_room.id
  returning * into v_room;

  if p_enabled then
    with ordered as (
      select id, row_number() over (order by joined_at asc, turn_order asc) as rn
      from public.players
      where room_id = v_room.id
        and is_active = true
    )
    update public.players p
    set team = case when (o.rn % 2) = 1 then 'A' else 'B' end
    from ordered o
    where p.id = o.id;
  else
    update public.players
    set team = null
    where room_id = v_room.id;
  end if;

  return v_room;
end;
$$;

create or replace function public.start_round(
  p_room_code text,
  p_category text default null,
  p_difficulty text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_is_host boolean;
  v_round_id uuid;
  v_ready int;
  v_total int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id, p.id, p.is_host
  into v_room_id, v_player_id, v_is_host
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;
  if not v_is_host then
    raise exception 'Only host can start rounds';
  end if;

  perform public.prune_inactive_players(v_code, 75);

  select count(*)::int into v_total
  from public.players
  where room_id = v_room_id
    and is_active = true;

  select count(*)::int into v_ready
  from public.room_votes v
  join public.players p on p.id = v.player_id
  where v.room_id = v_room_id
    and v.vote_type = 'ready_start'
    and p.is_active = true;

  if v_total = 0 or v_ready <> v_total then
    raise exception 'All active players must be ready';
  end if;

  v_round_id := public.start_round_internal(v_room_id, v_player_id, p_category, p_difficulty);
  return v_round_id;
end;
$$;

create or replace function public.advance_turn(p_room_code text, p_force boolean default false)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_round public.rounds%rowtype;
  v_next_turn uuid;
  v_elapsed int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.* into v_room
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  select p.* into v_player
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room.id is null then
    raise exception 'Player not in room';
  end if;

  perform public.prune_inactive_players(v_code, 75);

  select * into v_round
  from public.rounds
  where room_id = v_room.id
    and status = 'playing'
  order by started_at desc
  limit 1
  for update;

  if v_round.id is null then
    raise exception 'No active round';
  end if;

  v_elapsed := extract(epoch from now() - v_round.turn_started_at)::int;

  if p_force then
    if not v_player.is_host then
      raise exception 'Only host can force skip';
    end if;
  else
    if v_elapsed < v_room.turn_seconds
       and v_player.id <> v_round.active_turn_player_id then
      raise exception 'Cannot skip turn before timeout';
    end if;
  end if;

  v_next_turn := public.get_next_turn_player(v_room.id, v_round.active_turn_player_id);
  if v_next_turn is null then
    raise exception 'No active players available';
  end if;

  update public.rounds
  set active_turn_player_id = v_next_turn,
      turn_started_at = now()
  where id = v_round.id;

  select * into v_round
  from public.rounds
  where id = v_round.id;

  return v_round;
end;
$$;

create or replace function public.set_ready_start(
  p_room_code text,
  p_ready boolean default true
)
returns table(
  ready_start_votes int,
  total_active int,
  all_ready boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_ready int;
  v_total int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id, p.id
  into v_room_id, v_player_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;

  if exists (
    select 1 from public.rounds
    where room_id = v_room_id and status = 'playing'
  ) then
    raise exception 'Cannot change ready status during a round';
  end if;

  if p_ready then
    insert into public.room_votes(room_id, vote_type, player_id)
    values (v_room_id, 'ready_start', v_player_id)
    on conflict (room_id, vote_type, player_id) do nothing;
  else
    delete from public.room_votes
    where room_id = v_room_id
      and vote_type = 'ready_start'
      and player_id = v_player_id;
  end if;

  select count(*)::int into v_total
  from public.players
  where room_id = v_room_id and is_active = true;

  select count(*)::int into v_ready
  from public.room_votes v
  join public.players p on p.id = v.player_id
  where v.room_id = v_room_id
    and v.vote_type = 'ready_start'
    and p.is_active = true;

  return query
  select v_ready, v_total, (v_total > 0 and v_ready = v_total);
end;
$$;

create or replace function public.use_hint(p_room_code text)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_round public.rounds%rowtype;
  v_hint text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id, p.id
  into v_room_id, v_player_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;

  select * into v_round
  from public.rounds
  where room_id = v_room_id
    and status = 'playing'
  order by started_at desc
  limit 1
  for update;

  if v_round.id is null then
    raise exception 'No active round';
  end if;
  if v_round.hint_used then
    raise exception 'Hint already used';
  end if;
  if v_round.active_turn_player_id <> v_player_id then
    raise exception 'Only current player can use hint';
  end if;

  select coalesce(hint, 'Sin pista') into v_hint
  from public.round_secrets
  where round_id = v_round.id;

  update public.rounds
  set hint_used = true,
      hint_text = v_hint
  where id = v_round.id;

  update public.players
  set score = greatest(0, score - 5)
  where id = v_player_id;

  select * into v_round
  from public.rounds
  where id = v_round.id;

  return v_round;
end;
$$;

create or replace function public.guess_letter(p_room_code text, p_letter text)
returns public.rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_letter text := public.normalize_letter(p_letter);
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_round public.rounds%rowtype;
  v_word text;
  v_hit boolean := false;
  v_new_correct text[];
  v_new_wrong text[];
  v_new_masked text;
  v_new_errors int;
  v_next_turn uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if char_length(v_letter) <> 1 or v_letter !~ '^[A-Z]$' then
    raise exception 'Invalid letter';
  end if;

  select r.* into v_room
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  select p.* into v_player
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room.id is null then
    raise exception 'Player not in room';
  end if;

  perform public.prune_inactive_players(v_code, 75);

  select * into v_round
  from public.rounds
  where room_id = v_room.id
    and status = 'playing'
  order by started_at desc
  limit 1
  for update;

  if v_round.id is null then
    raise exception 'No active round';
  end if;
  if v_round.active_turn_player_id <> v_player.id then
    raise exception 'Not your turn';
  end if;

  if v_letter = any(v_round.correct_letters) or v_letter = any(v_round.wrong_letters) then
    return v_round;
  end if;

  select s.word into v_word
  from public.round_secrets s
  where s.round_id = v_round.id;

  v_hit := position(v_letter in v_word) > 0;

  if v_hit then
    v_new_correct := array_append(v_round.correct_letters, v_letter);
    v_new_masked := public.build_masked_word(v_word, v_new_correct);

    update public.rounds
    set correct_letters = v_new_correct,
        masked_word = v_new_masked,
        status = case when v_new_masked = v_word then 'won' else status end,
        winner_player_id = case when v_new_masked = v_word then v_player.id else winner_player_id end,
        ended_at = case when v_new_masked = v_word then now() else ended_at end
    where id = v_round.id;

    update public.players
    set score = score + case when v_new_masked = v_word then v_round.points_letter + v_round.points_solve else v_round.points_letter end
    where id = v_player.id;
  else
    v_new_wrong := array_append(v_round.wrong_letters, v_letter);
    v_new_errors := v_round.errors_count + 1;

    update public.rounds
    set wrong_letters = v_new_wrong,
        errors_count = v_new_errors,
        status = case when v_new_errors >= max_errors then 'lost' else status end,
        ended_at = case when v_new_errors >= max_errors then now() else ended_at end
    where id = v_round.id;
  end if;

  insert into public.guesses(round_id, player_id, letter, is_correct)
  values (v_round.id, v_player.id, v_letter, v_hit)
  on conflict do nothing;

  select * into v_round
  from public.rounds
  where id = v_round.id;

  if v_round.status = 'playing' then
    v_next_turn := public.get_next_turn_player(v_room.id, v_round.active_turn_player_id);
    if v_next_turn is not null then
      update public.rounds
      set active_turn_player_id = v_next_turn,
          turn_started_at = now()
      where id = v_round.id;

      select * into v_round
      from public.rounds
      where id = v_round.id;
    end if;
  end if;

  return v_round;
end;
$$;

create or replace function public.get_vote_status(p_room_code text)
returns table(
  rematch_votes int,
  reset_votes int,
  free_hint_votes int,
  ready_start_votes int,
  total_active int,
  all_ready boolean,
  needed int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_active int;
  v_rematch int;
  v_reset int;
  v_hint int;
  v_ready int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id into v_room_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;

  select count(*)::int into v_active
  from public.players
  where room_id = v_room_id
    and is_active = true;

  select count(*)::int into v_rematch
  from public.room_votes
  where room_id = v_room_id and vote_type = 'rematch';

  select count(*)::int into v_reset
  from public.room_votes
  where room_id = v_room_id and vote_type = 'reset_scores';

  select count(*)::int into v_hint
  from public.room_votes
  where room_id = v_room_id and vote_type = 'free_hint';

  select count(*)::int into v_ready
  from public.room_votes v
  join public.players p on p.id = v.player_id
  where v.room_id = v_room_id
    and v.vote_type = 'ready_start'
    and p.is_active = true;

  return query
  select v_rematch, v_reset, v_hint, v_ready, v_active, (v_active > 0 and v_ready = v_active), public.needed_votes(v_active);
end;
$$;

create or replace function public.vote_rematch(p_room_code text)
returns table(
  resolved boolean,
  round_id uuid,
  rematch_votes int,
  needed int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_round_active boolean;
  v_votes int;
  v_active int;
  v_needed int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id, p.id
  into v_room_id, v_player_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;

  insert into public.room_votes(room_id, vote_type, player_id)
  values (v_room_id, 'rematch', v_player_id)
  on conflict (room_id, vote_type, player_id) do nothing;

  select count(*)::int into v_active
  from public.players
  where room_id = v_room_id and is_active = true;

  v_needed := public.needed_votes(v_active);

  select count(*)::int into v_votes
  from public.room_votes
  where room_id = v_room_id and vote_type = 'rematch';

  select exists (
    select 1 from public.rounds
    where room_id = v_room_id and status = 'playing'
  ) into v_round_active;

  if v_votes >= v_needed and not v_round_active then
    return query
    select true, null::uuid, v_votes, v_needed;
    return;
  end if;

  return query
  select false, null::uuid, v_votes, v_needed;
end;
$$;

create or replace function public.vote_reset_scores(p_room_code text)
returns table(
  resolved boolean,
  reset_votes int,
  needed int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_votes int;
  v_active int;
  v_needed int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id, p.id
  into v_room_id, v_player_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
    and p.is_active = true
  limit 1;

  if v_room_id is null then
    raise exception 'Player not in room';
  end if;

  insert into public.room_votes(room_id, vote_type, player_id)
  values (v_room_id, 'reset_scores', v_player_id)
  on conflict (room_id, vote_type, player_id) do nothing;

  select count(*)::int into v_active
  from public.players
  where room_id = v_room_id and is_active = true;

  v_needed := public.needed_votes(v_active);

  select count(*)::int into v_votes
  from public.room_votes
  where room_id = v_room_id and vote_type = 'reset_scores';

  if v_votes >= v_needed then
    update public.players
    set score = 0
    where room_id = v_room_id;

    delete from public.room_votes
    where room_id = v_room_id and vote_type = 'reset_scores';

    return query
    select true, v_votes, v_needed;
  end if;

  return query
  select false, v_votes, v_needed;
end;
$$;

create or replace function public.heartbeat(p_room_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  update public.players p
  set last_seen_at = now(),
      is_active = true
  from public.rooms r
  where r.id = p.room_id
    and r.code = v_code
    and p.auth_user_id = v_uid;

  perform public.prune_inactive_players(v_code, 75);
end;
$$;

create or replace function public.leave_room(p_room_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select r.id into v_room_id
  from public.rooms r
  join public.players p on p.room_id = r.id
  where r.code = v_code
    and p.auth_user_id = v_uid
  limit 1;

  if v_room_id is null then
    return;
  end if;

  update public.players
  set is_active = false,
      is_host = false,
      last_seen_at = now()
  where room_id = v_room_id
    and auth_user_id = v_uid;

  delete from public.room_votes v
  using public.players p
  where v.room_id = v_room_id
    and v.vote_type = 'ready_start'
    and v.player_id = p.id
    and p.room_id = v_room_id
    and p.auth_user_id = v_uid;

  perform public.ensure_host(v_room_id);
end;
$$;

grant execute on function public.join_room(text, text, text) to authenticated;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;
grant execute on function public.set_team_mode(text, boolean) to authenticated;
grant execute on function public.start_round(text, text, text) to authenticated;
grant execute on function public.set_ready_start(text, boolean) to authenticated;
grant execute on function public.guess_letter(text, text) to authenticated;
grant execute on function public.use_hint(text) to authenticated;
grant execute on function public.advance_turn(text, boolean) to authenticated;
grant execute on function public.get_vote_status(text) to authenticated;
grant execute on function public.vote_rematch(text) to authenticated;
grant execute on function public.vote_reset_scores(text) to authenticated;
grant execute on function public.heartbeat(text) to authenticated;
grant execute on function public.leave_room(text) to authenticated;

-- ===== Seed words =====
insert into public.words(word, hint, category, difficulty, language)
values
  ('OFICINA', 'Lugar de trabajo', 'trabajo', 'easy', 'es'),
  ('PROYECTO', 'Conjunto de tareas con objetivo', 'trabajo', 'medium', 'es'),
  ('REUNION', 'Encuentro de equipo', 'trabajo', 'easy', 'es'),
  ('PIZARRA', 'Superficie para escribir ideas', 'trabajo', 'easy', 'es'),
  ('TECLADO', 'Dispositivo para escribir', 'tecnologia', 'easy', 'es'),
  ('SUPABASE', 'Backend del juego', 'tecnologia', 'medium', 'es'),
  ('VERCEL', 'Plataforma de deploy', 'tecnologia', 'easy', 'es'),
  ('AHORCADO', 'Nombre del juego', 'juegos', 'easy', 'es'),
  ('CONTENEDOR', 'Se usa para empacar apps', 'tecnologia', 'hard', 'es'),
  ('ALGORITMO', 'Serie de pasos para resolver algo', 'tecnologia', 'medium', 'es'),
  ('DOCUMENTACION', 'Guia escrita del sistema', 'trabajo', 'hard', 'es')
on conflict (word) do nothing;
