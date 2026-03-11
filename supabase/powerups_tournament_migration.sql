-- Incremental migration: power-ups + tournament mode
-- Safe for existing projects (no table drops)

begin;

alter table public.rooms
  add column if not exists tournament_enabled boolean not null default false;

alter table public.rooms
  add column if not exists tournament_best_of int not null default 3;

alter table public.rooms
  alter column turn_seconds set default 10;

update public.rooms
set turn_seconds = 10
where turn_seconds <> 10;

alter table public.rooms drop constraint if exists rooms_tournament_best_of_check;
alter table public.rooms
  add constraint rooms_tournament_best_of_check check (tournament_best_of in (3, 5));

alter table public.rounds
  add column if not exists block_vowels boolean not null default false;

alter table public.rounds
  add column if not exists double_points_player_id uuid null references public.players(id);

alter table public.rounds
  add column if not exists double_points_consumed boolean not null default false;

alter table public.room_votes drop constraint if exists room_votes_vote_type_check;
alter table public.room_votes
  add constraint room_votes_vote_type_check
  check (vote_type in ('rematch', 'reset_scores', 'free_hint', 'ready_start'));

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

  delete from public.room_votes
  where room_id = v_room_id
    and vote_type = 'ready_start';

  return v_round_id;
end;
$$;

create or replace function public.set_tournament_mode(
  p_room_code text,
  p_enabled boolean,
  p_best_of int default 3
)
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
  v_best int := case when p_best_of in (3, 5) then p_best_of else 3 end;
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
    raise exception 'Only host can update tournament mode';
  end if;

  update public.rooms
  set tournament_enabled = p_enabled,
      tournament_best_of = v_best
  where id = v_room.id
  returning * into v_room;

  return v_room;
end;
$$;

create or replace function public.set_block_vowels(
  p_room_code text,
  p_enabled boolean
)
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
    raise exception 'Only host can toggle block vowels';
  end if;

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

  update public.rounds
  set block_vowels = p_enabled
  where id = v_round.id
  returning * into v_round;

  return v_round;
end;
$$;

create or replace function public.activate_double_points(p_room_code text)
returns table(
  activated boolean,
  consumed_for_player_id uuid
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
  v_round public.rounds%rowtype;
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

  if v_round.active_turn_player_id <> v_player_id then
    raise exception 'Only current player can activate double points';
  end if;

  if v_round.double_points_consumed then
    return query select false, v_round.double_points_player_id;
    return;
  end if;

  if v_round.double_points_player_id is not null and v_round.double_points_player_id <> v_player_id then
    return query select false, v_round.double_points_player_id;
    return;
  end if;

  update public.rounds
  set double_points_player_id = v_player_id
  where id = v_round.id;

  return query select true, v_player_id;
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

drop function if exists public.get_vote_status(text);

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

create or replace function public.vote_free_hint(p_room_code text)
returns table(
  resolved boolean,
  free_hint_votes int,
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
  v_round public.rounds%rowtype;
  v_votes int;
  v_active int;
  v_needed int;
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

  insert into public.room_votes(room_id, vote_type, player_id)
  values (v_room_id, 'free_hint', v_player_id)
  on conflict (room_id, vote_type, player_id) do nothing;

  select count(*)::int into v_active
  from public.players
  where room_id = v_room_id and is_active = true;

  v_needed := public.needed_votes(v_active);

  select count(*)::int into v_votes
  from public.room_votes
  where room_id = v_room_id and vote_type = 'free_hint';

  if v_votes >= v_needed and not v_round.hint_used then
    select coalesce(hint, 'Sin pista') into v_hint
    from public.round_secrets
    where round_id = v_round.id;

    update public.rounds
    set hint_used = true,
        hint_text = v_hint
    where id = v_round.id;

    delete from public.room_votes
    where room_id = v_room_id and vote_type = 'free_hint';

    return query
    select true, v_votes, v_needed;
    return;
  end if;

  return query
  select false, v_votes, v_needed;
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
  v_multiplier int := 1;
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

  if v_round.block_vowels and v_letter in ('A', 'E', 'I', 'O', 'U') then
    raise exception 'Vowels are blocked in this round';
  end if;

  if v_letter = any(v_round.correct_letters) or v_letter = any(v_round.wrong_letters) then
    return v_round;
  end if;

  select s.word into v_word
  from public.round_secrets s
  where s.round_id = v_round.id;

  v_hit := position(v_letter in v_word) > 0;

  if v_round.double_points_player_id = v_player.id and not v_round.double_points_consumed then
    v_multiplier := 2;
  end if;

  if v_hit then
    v_new_correct := array_append(v_round.correct_letters, v_letter);
    v_new_masked := public.build_masked_word(v_word, v_new_correct);

    update public.rounds
    set correct_letters = v_new_correct,
        masked_word = v_new_masked,
        status = case when v_new_masked = v_word then 'won' else status end,
        winner_player_id = case when v_new_masked = v_word then v_player.id else winner_player_id end,
        ended_at = case when v_new_masked = v_word then now() else ended_at end,
        double_points_consumed = case when v_multiplier = 2 then true else double_points_consumed end
    where id = v_round.id;

    update public.players
    set score = score + (
      case when v_new_masked = v_word then v_round.points_letter + v_round.points_solve else v_round.points_letter end
    ) * v_multiplier
    where id = v_player.id;
  else
    v_new_wrong := array_append(v_round.wrong_letters, v_letter);
    v_new_errors := v_round.errors_count + 1;

    update public.rounds
    set wrong_letters = v_new_wrong,
        errors_count = v_new_errors,
        status = case when v_new_errors >= max_errors then 'lost' else status end,
        ended_at = case when v_new_errors >= max_errors then now() else ended_at end,
        double_points_consumed = case when v_multiplier = 2 then true else double_points_consumed end
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

grant execute on function public.set_tournament_mode(text, boolean, int) to authenticated;
grant execute on function public.set_block_vowels(text, boolean) to authenticated;
grant execute on function public.activate_double_points(text) to authenticated;
grant execute on function public.set_ready_start(text, boolean) to authenticated;
grant execute on function public.vote_free_hint(text) to authenticated;

commit;
