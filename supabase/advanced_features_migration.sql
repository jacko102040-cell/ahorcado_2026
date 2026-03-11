-- Incremental migration: UX/social/competitive/performance bundle
-- Safe for existing projects

begin;

create extension if not exists pgcrypto;

create table if not exists public.player_profiles (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Jugador',
  rating int not null default 1000,
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  titles text[] not null default '{}',
  cosmetics text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_seasons_single_active
on public.seasons (is_active)
where is_active = true;

create table if not exists public.season_results (
  id bigserial primary key,
  season_id uuid not null references public.seasons(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  rating_delta int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  title_awarded text null,
  updated_at timestamptz not null default now(),
  unique (season_id, auth_user_id)
);

create table if not exists public.user_word_submissions (
  id bigserial primary key,
  submitted_by uuid not null references auth.users(id) on delete cascade,
  word text not null,
  hint text null,
  category text not null default 'general',
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  language text not null default 'es',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  moderation_note text null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz null
);

create table if not exists public.game_events (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_id uuid null references public.rounds(id) on delete set null,
  actor_player_id uuid null references public.players(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_game_events_room_created
on public.game_events(room_id, created_at desc);

create table if not exists public.quick_chats (
  id bigserial primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  message_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_quick_chats_room_created
on public.quick_chats(room_id, created_at desc);

alter table public.player_profiles enable row level security;
alter table public.seasons enable row level security;
alter table public.season_results enable row level security;
alter table public.user_word_submissions enable row level security;
alter table public.game_events enable row level security;
alter table public.quick_chats enable row level security;

drop policy if exists player_profiles_select_all on public.player_profiles;
drop policy if exists seasons_select_all on public.seasons;
drop policy if exists season_results_select_all on public.season_results;
drop policy if exists word_submissions_insert_own on public.user_word_submissions;
drop policy if exists word_submissions_select_own on public.user_word_submissions;
drop policy if exists game_events_select_same_room on public.game_events;
drop policy if exists quick_chats_select_same_room on public.quick_chats;
drop policy if exists quick_chats_insert_same_room on public.quick_chats;

create policy player_profiles_select_all
on public.player_profiles
for select
to authenticated
using (true);

create policy seasons_select_all
on public.seasons
for select
to authenticated
using (true);

create policy season_results_select_all
on public.season_results
for select
to authenticated
using (true);

create policy word_submissions_insert_own
on public.user_word_submissions
for insert
to authenticated
with check (submitted_by = auth.uid());

create policy word_submissions_select_own
on public.user_word_submissions
for select
to authenticated
using (submitted_by = auth.uid());

create policy game_events_select_same_room
on public.game_events
for select
to authenticated
using (public.is_room_member(game_events.room_id));

create policy quick_chats_select_same_room
on public.quick_chats
for select
to authenticated
using (public.is_room_member(quick_chats.room_id));

create policy quick_chats_insert_same_room
on public.quick_chats
for insert
to authenticated
with check (
  exists (
    select 1
    from public.players p
    where p.id = quick_chats.player_id
      and p.room_id = quick_chats.room_id
      and p.auth_user_id = auth.uid()
      and p.is_active = true
  )
);

create or replace function public.sync_profile_from_player()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.player_profiles(auth_user_id, display_name)
  values (new.auth_user_id, new.display_name)
  on conflict (auth_user_id)
  do update set
    display_name = excluded.display_name,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists trg_sync_profile_from_player on public.players;
create trigger trg_sync_profile_from_player
after insert or update of display_name on public.players
for each row execute function public.sync_profile_from_player();

create or replace function public.log_player_presence_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_active then
      insert into public.game_events(room_id, actor_player_id, event_type, payload)
      values (new.room_id, new.id, 'join', jsonb_build_object('display_name', new.display_name));
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.is_active is distinct from new.is_active then
      insert into public.game_events(room_id, actor_player_id, event_type, payload)
      values (
        new.room_id,
        new.id,
        case when new.is_active then 'join' else 'leave' end,
        jsonb_build_object('display_name', new.display_name)
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_log_player_presence_event on public.players;
create trigger trg_log_player_presence_event
after insert or update of is_active on public.players
for each row execute function public.log_player_presence_event();

create or replace function public.log_round_events_and_update_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner_uid uuid;
  v_active_season uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.game_events(room_id, round_id, actor_player_id, event_type, payload)
    values (
      new.room_id,
      new.id,
      new.created_by_player_id,
      'start_round',
      jsonb_build_object('difficulty', new.difficulty, 'category', new.category)
    );
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if (old.hint_used is distinct from true) and new.hint_used = true then
      insert into public.game_events(room_id, round_id, actor_player_id, event_type)
      values (new.room_id, new.id, new.active_turn_player_id, 'hint_used');
    end if;

    if old.status = 'playing' and new.status in ('won', 'lost') then
      insert into public.game_events(room_id, round_id, actor_player_id, event_type)
      values (new.room_id, new.id, new.winner_player_id, case when new.status = 'won' then 'round_won' else 'round_lost' end);

      if new.winner_player_id is not null then
        select p.auth_user_id into v_winner_uid
        from public.players p
        where p.id = new.winner_player_id;

        if v_winner_uid is not null then
          update public.player_profiles
          set wins = wins + 1,
              games_played = games_played + 1,
              rating = rating + 16,
              updated_at = now()
          where auth_user_id = v_winner_uid;
        end if;

        update public.player_profiles pp
        set losses = losses + 1,
            games_played = games_played + 1,
            rating = greatest(800, rating - 8),
            updated_at = now()
        where pp.auth_user_id in (
          select p.auth_user_id
          from public.players p
          where p.room_id = new.room_id
            and p.is_active = true
            and p.id <> new.winner_player_id
        );

        select id into v_active_season
        from public.seasons
        where is_active = true
          and now() between starts_at and ends_at
        limit 1;

        if v_active_season is not null then
          insert into public.season_results(season_id, auth_user_id, wins, rating_delta, updated_at)
          values (v_active_season, v_winner_uid, 1, 16, now())
          on conflict (season_id, auth_user_id)
          do update set
            wins = public.season_results.wins + 1,
            rating_delta = public.season_results.rating_delta + 16,
            updated_at = now();

          insert into public.season_results(season_id, auth_user_id, losses, rating_delta, updated_at)
          select v_active_season, p.auth_user_id, 1, -8, now()
          from public.players p
          where p.room_id = new.room_id
            and p.is_active = true
            and p.id <> new.winner_player_id
          on conflict (season_id, auth_user_id)
          do update set
            losses = public.season_results.losses + 1,
            rating_delta = public.season_results.rating_delta - 8,
            updated_at = now();
        end if;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_log_round_events_and_update_rating on public.rounds;
create trigger trg_log_round_events_and_update_rating
after insert or update on public.rounds
for each row execute function public.log_round_events_and_update_rating();

create or replace function public.log_guess_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
begin
  select room_id into v_room_id
  from public.rounds
  where id = new.round_id;

  insert into public.game_events(room_id, round_id, actor_player_id, event_type, payload)
  values (
    v_room_id,
    new.round_id,
    new.player_id,
    case when new.is_correct then 'guess_hit' else 'guess_miss' end,
    jsonb_build_object('letter', new.letter)
  );

  return new;
end;
$$;

drop trigger if exists trg_log_guess_event on public.guesses;
create trigger trg_log_guess_event
after insert on public.guesses
for each row execute function public.log_guess_event();

create or replace function public.send_quick_chat(p_room_code text, p_message_key text)
returns public.quick_chats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room_id uuid;
  v_player_id uuid;
  v_chat public.quick_chats%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_message_key not in ('hello', 'goodluck', 'nice', 'oops', 'gg', 'rematch') then
    raise exception 'Invalid quick chat message';
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

  insert into public.quick_chats(room_id, player_id, message_key)
  values (v_room_id, v_player_id, p_message_key)
  returning * into v_chat;

  insert into public.game_events(room_id, actor_player_id, event_type, payload)
  values (v_room_id, v_player_id, 'chat', jsonb_build_object('message_key', p_message_key));

  return v_chat;
end;
$$;

create or replace function public.submit_word_suggestion(
  p_word text,
  p_hint text,
  p_category text,
  p_difficulty text default 'medium'
)
returns public.user_word_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_word text := upper(trim(coalesce(p_word, '')));
  v_hint text := trim(coalesce(p_hint, ''));
  v_category text := lower(trim(coalesce(p_category, 'general')));
  v_difficulty text := coalesce(public.normalize_difficulty(p_difficulty), 'medium');
  v_row public.user_word_submissions%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if char_length(v_word) < 3 or char_length(v_word) > 24 or v_word !~ '^[A-ZÑÁÉÍÓÚÜ]+$' then
    raise exception 'Invalid word format';
  end if;

  insert into public.user_word_submissions(
    submitted_by,
    word,
    hint,
    category,
    difficulty,
    language
  )
  values (
    v_uid,
    v_word,
    nullif(v_hint, ''),
    v_category,
    v_difficulty,
    'es'
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.get_public_profile(p_auth_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.player_profiles%rowtype;
  v_recent_wins int;
begin
  select * into v_profile
  from public.player_profiles
  where auth_user_id = p_auth_user_id;

  if v_profile.auth_user_id is null then
    return jsonb_build_object('found', false);
  end if;

  select count(*)::int into v_recent_wins
  from public.rounds r
  join public.players p on p.id = r.winner_player_id
  where p.auth_user_id = p_auth_user_id
    and r.status = 'won'
    and r.ended_at >= now() - interval '30 days';

  return jsonb_build_object(
    'found', true,
    'auth_user_id', v_profile.auth_user_id,
    'display_name', v_profile.display_name,
    'rating', v_profile.rating,
    'games_played', v_profile.games_played,
    'wins', v_profile.wins,
    'losses', v_profile.losses,
    'win_rate', case when v_profile.games_played > 0 then round((v_profile.wins::numeric / v_profile.games_played::numeric) * 100, 2) else 0 end,
    'recent_wins', v_recent_wins,
    'titles', v_profile.titles,
    'cosmetics', v_profile.cosmetics,
    'achievements', jsonb_build_array(
      jsonb_build_object('code', 'first_win', 'unlocked', v_profile.wins >= 1),
      jsonb_build_object('code', 'score_50', 'unlocked', v_profile.rating >= 1050),
      jsonb_build_object('code', 'veteran', 'unlocked', v_profile.games_played >= 50)
    )
  );
end;
$$;

create or replace function public.get_leaderboards(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit int := greatest(5, least(100, coalesce(p_limit, 20)));
  v_active_season uuid;
  v_global jsonb;
  v_weekly jsonb;
  v_monthly jsonb;
  v_season jsonb;
begin
  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_global
  from (
    select jsonb_build_object(
      'auth_user_id', pp.auth_user_id,
      'display_name', pp.display_name,
      'value', pp.rating
    ) as item
    from public.player_profiles pp
    order by pp.rating desc, pp.wins desc
    limit v_limit
  ) t;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_weekly
  from (
    select jsonb_build_object(
      'auth_user_id', p.auth_user_id,
      'display_name', max(p.display_name),
      'value', count(*)::int
    ) as item
    from public.rounds r
    join public.players p on p.id = r.winner_player_id
    where r.status = 'won'
      and r.ended_at >= now() - interval '7 days'
    group by p.auth_user_id
    order by count(*) desc
    limit v_limit
  ) t;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_monthly
  from (
    select jsonb_build_object(
      'auth_user_id', p.auth_user_id,
      'display_name', max(p.display_name),
      'value', count(*)::int
    ) as item
    from public.rounds r
    join public.players p on p.id = r.winner_player_id
    where r.status = 'won'
      and r.ended_at >= now() - interval '30 days'
    group by p.auth_user_id
    order by count(*) desc
    limit v_limit
  ) t;

  select id into v_active_season
  from public.seasons
  where is_active = true
    and now() between starts_at and ends_at
  limit 1;

  if v_active_season is null then
    v_season := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(item), '[]'::jsonb) into v_season
    from (
      select jsonb_build_object(
        'auth_user_id', sr.auth_user_id,
        'display_name', pp.display_name,
        'value', sr.wins
      ) as item
      from public.season_results sr
      join public.player_profiles pp on pp.auth_user_id = sr.auth_user_id
      where sr.season_id = v_active_season
      order by sr.wins desc, sr.rating_delta desc
      limit v_limit
    ) t;
  end if;

  return jsonb_build_object(
    'global', coalesce(v_global, '[]'::jsonb),
    'weekly', coalesce(v_weekly, '[]'::jsonb),
    'monthly', coalesce(v_monthly, '[]'::jsonb),
    'season', coalesce(v_season, '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_room_state(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.normalize_room_code(p_room_code);
  v_room public.rooms%rowtype;
  v_round public.rounds%rowtype;
  v_needed int;
  v_votes jsonb;
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

  if v_room.id is null then
    raise exception 'Player not in room';
  end if;

  perform public.prune_inactive_players(v_code, 75);

  select * into v_round
  from public.rounds
  where room_id = v_room.id
  order by started_at desc
  limit 1;

  select public.needed_votes(count(*)::int) into v_needed
  from public.players
  where room_id = v_room.id and is_active = true;

  select jsonb_build_object(
    'rematch_votes', count(*) filter (where vote_type = 'rematch'),
    'reset_votes', count(*) filter (where vote_type = 'reset_scores'),
    'free_hint_votes', count(*) filter (where vote_type = 'free_hint'),
    'needed', v_needed
  ) into v_votes
  from public.room_votes
  where room_id = v_room.id;

  return jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.score desc, p.turn_order asc)
      from public.players p
      where p.room_id = v_room.id
        and p.is_active = true
    ), '[]'::jsonb),
    'round', case when v_round.id is null then null else to_jsonb(v_round) end,
    'votes', coalesce(v_votes, jsonb_build_object('rematch_votes', 0, 'reset_votes', 0, 'free_hint_votes', 0, 'needed', 1)),
    'guesses', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.created_at desc)
      from public.guesses g
      where v_round.id is not null
        and g.round_id = v_round.id
      limit 25
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at desc)
      from public.game_events e
      where e.room_id = v_room.id
      limit 40
    ), '[]'::jsonb),
    'quick_chats', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.created_at desc)
      from public.quick_chats c
      where c.room_id = v_room.id
      limit 40
    ), '[]'::jsonb),
    'profiles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'auth_user_id', p.auth_user_id,
          'display_name', pp.display_name,
          'rating', pp.rating,
          'wins', pp.wins,
          'losses', pp.losses,
          'titles', pp.titles,
          'cosmetics', pp.cosmetics
        )
      )
      from public.players p
      left join public.player_profiles pp on pp.auth_user_id = p.auth_user_id
      where p.room_id = v_room.id
        and p.is_active = true
    ), '[]'::jsonb),
    'tournament', jsonb_build_object(
      'enabled', coalesce(v_room.tournament_enabled, false),
      'best_of', coalesce(v_room.tournament_best_of, 3),
      'standing', coalesce((
        select jsonb_agg(item) from (
          select jsonb_build_object(
            'key', case when v_room.team_mode then coalesce(w.team, '?') else w.player_id::text end,
            'wins', count(*)::int
          ) as item
          from (
            select r.winner_player_id as player_id, p.team
            from public.rounds r
            left join public.players p on p.id = r.winner_player_id
            where r.room_id = v_room.id
              and r.status = 'won'
              and r.winner_player_id is not null
          ) w
          group by case when v_room.team_mode then coalesce(w.team, '?') else w.player_id::text end
          order by count(*) desc
        ) q
      ), '[]'::jsonb)
    )
  );
end;
$$;

grant execute on function public.send_quick_chat(text, text) to authenticated;
grant execute on function public.submit_word_suggestion(text, text, text, text) to authenticated;
grant execute on function public.get_public_profile(uuid) to authenticated;
grant execute on function public.get_leaderboards(int) to authenticated;
grant execute on function public.get_room_state(text) to authenticated;

commit;
