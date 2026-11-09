-- =====================================================================
-- OnQuiz v1.1 — schema, RLS, RPC (server-authoritative), realtime broadcast
-- Thiết kế cho ~5.000 người chơi đồng thời:
--   * Người chơi KHÔNG dùng Supabase Auth (tránh giới hạn anonymous sign-in 30/giờ/IP).
--     Họ gọi RPC bằng anon key + (player_id, token) do join_game cấp.
--   * Người chơi KHÔNG có quyền truy cập bảng nào (RLS bật, không có policy cho anon).
--   * Đáp án đúng chỉ nằm trong game_questions (host đọc được), không bao giờ gửi cho player
--     trước khi reveal.
--   * Đồng bộ trạng thái bằng Realtime Broadcast (private channel, chia 10 shard),
--     phát từ DB qua realtime.send -> client không thể giả mạo sự kiện.
--   * Chấm điểm 1 lần/câu bằng 2 câu UPDATE set-based tại host_reveal (không update 5.000 dòng/giây).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Bảng dữ liệu
-- ---------------------------------------------------------------------
create table public.quizzes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index quizzes_owner_idx on public.quizzes(owner_id, updated_at desc);

create table public.questions (
  id            uuid primary key default gen_random_uuid(),
  quiz_id       uuid not null references public.quizzes(id) on delete cascade,
  position      int  not null check (position >= 0),
  text          text not null check (char_length(text) between 1 and 300),
  choices       jsonb not null check (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) between 2 and 4),
  -- v1.1: có thể đánh dấu 1 hoặc nhiều đáp án đúng; người chơi chọn 1 đáp án, trúng bất kỳ đáp án đúng nào đều được điểm
  correct_indexes int[] not null check (cardinality(correct_indexes) between 1 and 4 and correct_indexes <@ array[0,1,2,3]),
  time_limit    int  not null default 20 check (time_limit between 5 and 300),
  points        int  not null default 1000 check (points between 0 and 10000),
  speed_bonus   boolean not null default true,
  unique (quiz_id, position) deferrable initially deferred
);

-- Một phiên chơi. Câu hỏi được snapshot sang game_questions để sửa quiz giữa chừng không ảnh hưởng.
create table public.games (
  id                  uuid primary key default gen_random_uuid(),
  pin                 text not null check (pin ~ '^[0-9]{6}$'),
  host_id             uuid not null references auth.users(id) on delete cascade,
  quiz_id             uuid references public.quizzes(id) on delete set null,
  title               text not null,
  status              text not null default 'lobby'
                        check (status in ('lobby','question','reveal','leaderboard','ended')),
  current_idx         int  not null default -1,
  total_questions     int  not null check (total_questions > 0),
  question_started_at timestamptz,
  question_deadline   timestamptz,
  created_at          timestamptz not null default now(),
  ended_at            timestamptz
);
-- PIN chỉ phải duy nhất giữa các game chưa kết thúc
create unique index games_active_pin_uq on public.games(pin) where status <> 'ended';
create index games_host_idx on public.games(host_id, created_at desc);
create index games_active_idx on public.games(created_at) where status <> 'ended';

create table public.game_questions (
  game_id       uuid not null references public.games(id) on delete cascade,
  idx           int  not null,
  text          text not null,
  choices       jsonb not null,
  correct_indexes int[] not null,
  time_limit    int  not null,
  points        int  not null default 1000,
  speed_bonus   boolean not null default true,
  primary key (game_id, idx)
);

create table public.players (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games(id) on delete cascade,
  nickname      text not null,
  token         uuid not null default gen_random_uuid(),
  shard         smallint not null,
  score         int  not null default 0,
  streak        int  not null default 0,
  correct_count int  not null default 0,
  rank          int  not null default 0,   -- cập nhật 1 lần/câu tại host_reveal (0 = chưa xếp hạng)
  joined_at     timestamptz not null default now()
);
create unique index players_nick_uq   on public.players(game_id, lower(nickname));
create index        players_rank_idx  on public.players(game_id, score desc, joined_at);
create index        players_join_idx  on public.players(game_id, joined_at desc);

create table public.answers (
  player_id  uuid not null references public.players(id) on delete cascade,
  game_id    uuid not null references public.games(id) on delete cascade,
  q_idx      int  not null,
  choice     int  not null,
  is_correct boolean not null,
  elapsed_ms int  not null,
  points     int  not null default 0,
  created_at timestamptz not null default now(),
  primary key (player_id, q_idx)
);
create index answers_game_q_idx on public.answers(game_id, q_idx);

-- ---------------------------------------------------------------------
-- 2. RLS: host chỉ thấy dữ liệu của mình; anon không thấy gì
-- ---------------------------------------------------------------------
alter table public.quizzes        enable row level security;
alter table public.questions      enable row level security;
alter table public.games          enable row level security;
alter table public.game_questions enable row level security;
alter table public.players        enable row level security;
alter table public.answers        enable row level security;

create policy quizzes_owner on public.quizzes
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy questions_owner on public.questions
  for all to authenticated
  using (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()))
  with check (exists (select 1 from public.quizzes q where q.id = quiz_id and q.owner_id = auth.uid()));

create policy games_host_read on public.games
  for select to authenticated using (host_id = auth.uid());

create policy game_questions_host_read on public.game_questions
  for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id and g.host_id = auth.uid()));

-- players / answers: không có policy nào => chỉ truy cập được qua RPC security definer.

-- Gỡ quyền mặc định mà Supabase cấp cho anon/authenticated trên bảng
revoke all on public.players, public.answers, public.game_questions, public.games from anon;
revoke all on public.quizzes, public.questions from anon;
revoke insert, update, delete on public.games, public.game_questions from authenticated;
revoke all on public.players, public.answers from authenticated;

-- ---------------------------------------------------------------------
-- 3. Realtime: chỉ cho phép NHẬN broadcast topic game:*, không ai được GỬI từ client
-- ---------------------------------------------------------------------
create policy "onquiz_receive_game_broadcast" on realtime.messages
  for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'game:%');

-- ---------------------------------------------------------------------
-- 4. Hàm nội bộ
-- ---------------------------------------------------------------------
create or replace function public._shard_count() returns int
language sql immutable as $$ select 10 $$;

-- Phát 1 sự kiện tới toàn bộ shard của game (private channel, gửi từ DB)
create or replace function public._broadcast(p_game uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s int;
begin
  for s in 0 .. public._shard_count() - 1 loop
    perform realtime.send(p_payload, p_event, 'game:' || p_game::text || ':' || s, true);
  end loop;
end $$;

-- Lấy game của host hiện tại (khóa dòng để tuần tự hóa chuyển trạng thái)
create or replace function public._host_game(p_game uuid, p_lock boolean default true)
returns public.games language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_lock then
    select * into g from public.games where id = p_game and host_id = auth.uid() for update;
  else
    select * into g from public.games where id = p_game and host_id = auth.uid();
  end if;
  if not found then raise exception 'game_not_found' using errcode = 'P0002'; end if;
  return g;
end $$;

create or replace function public._top(p_game uuid, p_limit int)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(t order by t.rank), '[]'::jsonb) from (
    select row_number() over (order by score desc, joined_at) as rank,
           nickname, score, streak
    from public.players where game_id = p_game
    order by score desc, joined_at limit p_limit
  ) t
$$;

create or replace function public._counts(p_game uuid, p_idx int, p_n int)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(coalesce(c.n, 0) order by i), '[]'::jsonb)
  from generate_series(0, p_n - 1) i
  left join (select choice, count(*)::int n from public.answers
             where game_id = p_game and q_idx = p_idx group by choice) c on c.choice = i
$$;

create or replace function public._question_payload(p_game uuid, p_idx int, p_total int)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('idx', idx, 'total', p_total, 'text', text,
                            'choices', choices, 'time_limit', time_limit, 'points', points)
  from public.game_questions where game_id = p_game and idx = p_idx
$$;

create or replace function public._end_game(g public.games)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.games set status = 'ended', ended_at = now(), question_deadline = null where id = g.id;
  perform public._broadcast(g.id, 'ended', jsonb_build_object('top', public._top(g.id, 5)));
end $$;

-- ---------------------------------------------------------------------
-- 5. RPC cho HOST (authenticated)
-- ---------------------------------------------------------------------
create or replace function public.save_quiz(p_quiz_id uuid, p_title text, p_description text, p_questions jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid; q jsonb; i int := 0; n int; v_correct int[]; v_time int; v_points int;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 120 then raise exception 'invalid_title'; end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) not between 1 and 100 then
    raise exception 'invalid_question_count';
  end if;

  if p_quiz_id is null then
    insert into public.quizzes(owner_id, title, description)
    values (auth.uid(), btrim(p_title), coalesce(left(p_description, 500), '')) returning id into v_id;
  else
    update public.quizzes set title = btrim(p_title), description = coalesce(left(p_description, 500), ''), updated_at = now()
    where id = p_quiz_id and owner_id = auth.uid() returning id into v_id;
    if v_id is null then raise exception 'quiz_not_found'; end if;
    delete from public.questions where quiz_id = v_id;
  end if;

  for q in select * from jsonb_array_elements(p_questions) loop
    if q->>'text' is null or char_length(btrim(q->>'text')) not between 1 and 300 then raise exception 'invalid_question_text'; end if;
    if jsonb_typeof(q->'choices') <> 'array' then raise exception 'invalid_choices'; end if;
    n := jsonb_array_length(q->'choices');
    if n not between 2 and 4 then raise exception 'invalid_choices'; end if;
    if exists (select 1 from jsonb_array_elements(q->'choices') c
               where jsonb_typeof(c) <> 'string' or char_length(btrim(c #>> '{}')) not between 1 and 120) then
      raise exception 'invalid_choice_text';
    end if;
    if jsonb_typeof(q->'correct_indexes') <> 'array' then raise exception 'invalid_correct'; end if;
    select array_agg(distinct x::int order by x::int) into v_correct from jsonb_array_elements_text(q->'correct_indexes') x;
    if v_correct is null or v_correct[1] < 0 or v_correct[cardinality(v_correct)] >= n then raise exception 'invalid_correct'; end if;
    v_time := coalesce((q->>'time_limit')::int, 20);
    if v_time not between 5 and 300 then raise exception 'invalid_time'; end if;
    v_points := coalesce((q->>'points')::int, 1000);
    if v_points not between 0 and 10000 then raise exception 'invalid_points'; end if;
    insert into public.questions(quiz_id, position, text, choices, correct_indexes, time_limit, points, speed_bonus)
    values (v_id, i, btrim(q->>'text'), q->'choices', v_correct, v_time, v_points,
            coalesce((q->>'speed_bonus')::boolean, true));
    i := i + 1;
  end loop;
  return v_id;
end $$;

create or replace function public.create_game(p_quiz_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  qz public.quizzes; v_game uuid; v_pin text; tries int := 0; v_total int;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into qz from public.quizzes where id = p_quiz_id and owner_id = auth.uid();
  if not found then raise exception 'quiz_not_found'; end if;
  select count(*) into v_total from public.questions where quiz_id = qz.id;
  if v_total = 0 then raise exception 'quiz_empty'; end if;

  -- dọn game bỏ quên để giải phóng PIN
  update public.games set status = 'ended', ended_at = now()
   where status <> 'ended' and created_at < now() - interval '12 hours';

  loop
    v_pin := lpad(floor(random() * 1000000)::int::text, 6, '0');
    begin
      insert into public.games(pin, host_id, quiz_id, title, total_questions)
      values (v_pin, auth.uid(), qz.id, qz.title, v_total) returning id into v_game;
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 30 then raise exception 'pin_exhausted'; end if;
    end;
  end loop;

  insert into public.game_questions(game_id, idx, text, choices, correct_indexes, time_limit, points, speed_bonus)
  select v_game, (row_number() over (order by position)) - 1, text, choices, correct_indexes, time_limit, points, speed_bonus
  from public.questions where quiz_id = qz.id;

  return jsonb_build_object('game_id', v_game, 'pin', v_pin);
end $$;

-- Bắt đầu câu kế tiếp (từ lobby / reveal / leaderboard). Hết câu -> kết thúc game.
create or replace function public.host_start_question(p_game uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; v_next int; v_limit int; payload jsonb;
begin
  g := public._host_game(p_game);
  if g.status not in ('lobby','reveal','leaderboard') then raise exception 'invalid_state'; end if;
  v_next := g.current_idx + 1;
  if v_next >= g.total_questions then
    perform public._end_game(g);
    return jsonb_build_object('status', 'ended');
  end if;

  select time_limit into v_limit from public.game_questions where game_id = g.id and idx = v_next;
  update public.games
     set status = 'question', current_idx = v_next,
         question_started_at = clock_timestamp(),
         question_deadline   = clock_timestamp() + make_interval(secs => v_limit)
   where id = g.id;

  payload := public._question_payload(g.id, v_next, g.total_questions)
             || jsonb_build_object('ends_in_ms', v_limit * 1000);
  perform public._broadcast(g.id, 'question', payload);
  return jsonb_build_object('status', 'question', 'idx', v_next);
end $$;

-- Kết thúc câu hỏi: chấm điểm set-based, phát đáp án đúng + phân bố lựa chọn
create or replace function public.host_reveal(p_game uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; gq public.game_questions; v_counts jsonb; v_answered int; payload jsonb;
begin
  g := public._host_game(p_game);
  if g.status <> 'question' then raise exception 'invalid_state'; end if;
  select * into gq from public.game_questions where game_id = g.id and idx = g.current_idx;

  -- (1) điểm câu này = điểm câu hỏi (nếu bật speed_bonus: giảm tuyến tính 100% -> 50% theo thời gian trả lời)
  --     + thưởng chuỗi đúng = điểm câu x 10% x độ dài chuỗi trước đó (tối đa 50%)
  update public.answers a
     set points = case when a.is_correct then
           (case when gq.speed_bonus
                 then round(gq.points * (1 - 0.5 * least(a.elapsed_ms::numeric / (gq.time_limit * 1000), 1)))::int
                 else gq.points end)
           + round(gq.points * least(p.streak * 0.1, 0.5))::int
         else 0 end
    from public.players p
   where a.player_id = p.id and a.game_id = g.id and a.q_idx = g.current_idx;

  -- (2) cộng điểm, cập nhật chuỗi; người không trả lời bị reset chuỗi
  update public.players p
     set score         = p.score + coalesce(x.points, 0),
         streak        = case when x.is_correct is true then p.streak + 1 else 0 end,
         correct_count = p.correct_count + case when x.is_correct is true then 1 else 0 end
    from (select p2.id, a.points, a.is_correct
            from public.players p2
            left join public.answers a on a.player_id = p2.id and a.q_idx = g.current_idx
           where p2.game_id = g.id) x
   where p.id = x.id;

  -- (3) xếp hạng 1 lần cho cả game: get_my_result chỉ còn là đọc theo PK (không count 5.000 dòng/người)
  update public.players p set rank = r.rk
    from (select id, rank() over (order by score desc) as rk from public.players where game_id = g.id) r
   where p.id = r.id;

  v_counts   := public._counts(g.id, g.current_idx, jsonb_array_length(gq.choices));
  v_answered := (select coalesce(sum(v::int), 0) from jsonb_array_elements_text(v_counts) v);

  update public.games set status = 'reveal' where id = g.id;
  payload := jsonb_build_object('idx', g.current_idx, 'correct_indexes', to_jsonb(gq.correct_indexes),
                                'counts', v_counts, 'answered', v_answered);
  perform public._broadcast(g.id, 'reveal', payload);
  return payload;
end $$;

create or replace function public.host_show_leaderboard(p_game uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; payload jsonb;
begin
  g := public._host_game(p_game);
  if g.status <> 'reveal' then raise exception 'invalid_state'; end if;
  update public.games set status = 'leaderboard' where id = g.id;
  payload := jsonb_build_object('idx', g.current_idx, 'top', public._top(g.id, 5),
                                'is_last', g.current_idx + 1 >= g.total_questions);
  perform public._broadcast(g.id, 'leaderboard', payload);
  return payload;
end $$;

create or replace function public.host_end_game(p_game uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games;
begin
  g := public._host_game(p_game);
  if g.status = 'ended' then return; end if;
  perform public._end_game(g);
end $$;

-- Ảnh chụp trạng thái cho màn hình host (host poll ~1.5s)
create or replace function public.host_snapshot(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.games; v_players int; v_answered int; v_q jsonb; v_extra jsonb := '{}'::jsonb; v_n int;
begin
  g := public._host_game(p_game, false);
  select count(*) into v_players from public.players where game_id = g.id;
  if g.status = 'lobby' then
    v_extra := jsonb_build_object('recent', (
      select coalesce(jsonb_agg(nickname), '[]'::jsonb)
      from (select nickname from public.players where game_id = g.id order by joined_at desc limit 40) r));
  end if;
  if g.current_idx >= 0 and g.status <> 'ended' then
    v_q := public._question_payload(g.id, g.current_idx, g.total_questions);
    select count(*) into v_answered from public.answers where game_id = g.id and q_idx = g.current_idx;
  end if;
  if g.status in ('reveal','leaderboard') then
    select jsonb_array_length(choices) into v_n from public.game_questions where game_id = g.id and idx = g.current_idx;
    v_extra := v_extra || jsonb_build_object(
      'correct_indexes', (select to_jsonb(correct_indexes) from public.game_questions where game_id = g.id and idx = g.current_idx),
      'counts', public._counts(g.id, g.current_idx, v_n),
      'top', public._top(g.id, 5));
  end if;
  if g.status = 'ended' then v_extra := v_extra || jsonb_build_object('top', public._top(g.id, 5)); end if;
  return jsonb_build_object(
    'game_id', g.id, 'pin', g.pin, 'title', g.title, 'status', g.status,
    'idx', g.current_idx, 'total', g.total_questions,
    'players', v_players, 'answered', coalesce(v_answered, 0),
    'ms_left', case when g.status = 'question'
                    then greatest(0, (extract(epoch from (g.question_deadline - clock_timestamp())) * 1000)::int) end,
    'question', v_q) || v_extra;
end $$;

-- Kết quả đầy đủ để xuất CSV (chỉ host)
create or replace function public.host_results(p_game uuid)
returns table(rank bigint, nickname text, score int, correct_count int, total_questions int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.games;
begin
  g := public._host_game(p_game, false);
  return query
    select row_number() over (order by p.score desc, p.joined_at), p.nickname, p.score, p.correct_count, g.total_questions
    from public.players p where p.game_id = g.id order by p.score desc, p.joined_at;
end $$;

-- ---------------------------------------------------------------------
-- 6. RPC cho PLAYER (anon) — xác thực bằng (player_id, token)
-- ---------------------------------------------------------------------
create or replace function public.join_game(p_pin text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; v_nick text; v_player public.players; v_count int;
begin
  v_nick := btrim(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g'));
  if char_length(v_nick) not between 1 and 20 then raise exception 'invalid_nickname'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'game_not_found'; end if;

  select * into g from public.games where pin = p_pin and status <> 'ended';
  if not found then raise exception 'game_not_found'; end if;

  select count(*) into v_count from public.players where game_id = g.id;
  if v_count >= 6000 then raise exception 'game_full'; end if;

  begin
    insert into public.players(game_id, nickname, shard)
    values (g.id, v_nick, floor(random() * public._shard_count())::smallint)
    returning * into v_player;
  exception when unique_violation then
    raise exception 'nickname_taken';
  end;

  return jsonb_build_object('game_id', g.id, 'player_id', v_player.id, 'token', v_player.token,
                            'shard', v_player.shard, 'nickname', v_player.nickname, 'title', g.title);
end $$;

-- Rất nhẹ: polling dự phòng, chỉ đọc 1 dòng theo PK
create or replace function public.get_phase(p_game uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', status, 'idx', current_idx)
  from public.games where id = p_game
$$;

-- Hydrate trạng thái đầy đủ (vào lại sau refresh / mất kết nối)
create or replace function public.get_player_state(p_game uuid, p_player uuid, p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.games; p public.players; v_ans public.answers; v_gq public.game_questions; res jsonb;
begin
  select * into p from public.players where id = p_player and game_id = p_game and token = p_token;
  if not found then raise exception 'invalid_player'; end if;
  select * into g from public.games where id = p_game;

  res := jsonb_build_object('status', g.status, 'idx', g.current_idx, 'total', g.total_questions, 'title', g.title,
                            'score', p.score, 'streak', p.streak, 'rank', p.rank, 'nickname', p.nickname);

  if g.current_idx >= 0 then
    select * into v_gq from public.game_questions where game_id = g.id and idx = g.current_idx;
    select * into v_ans from public.answers where player_id = p.id and q_idx = g.current_idx;
    if v_ans.player_id is not null then
      res := res || jsonb_build_object('my_choice', v_ans.choice);
    end if;
  end if;

  if g.status = 'question' then
    res := res || jsonb_build_object(
      'question', public._question_payload(g.id, g.current_idx, g.total_questions),
      'ms_left', greatest(0, (extract(epoch from (g.question_deadline - clock_timestamp())) * 1000)::int));
  elsif g.status in ('reveal','leaderboard') then
    res := res || jsonb_build_object(
      'correct_indexes', to_jsonb(v_gq.correct_indexes),
      'counts', public._counts(g.id, g.current_idx, jsonb_array_length(v_gq.choices)),
      'last_points', coalesce(v_ans.points, 0),
      'last_correct', coalesce(v_ans.is_correct, false),
      'answered', v_ans.player_id is not null);
    if g.status = 'leaderboard' then res := res || jsonb_build_object('top', public._top(g.id, 5)); end if;
  elsif g.status = 'ended' then
    res := res || jsonb_build_object('top', public._top(g.id, 5), 'correct_count', p.correct_count);
  end if;
  return res;
end $$;

-- Kết quả cá nhân sau reveal / kết thúc (client gọi sau jitter ngẫu nhiên để dàn tải)
create or replace function public.get_my_result(p_game uuid, p_player uuid, p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.games; p public.players; v_ans public.answers;
begin
  select * into p from public.players where id = p_player and game_id = p_game and token = p_token;
  if not found then raise exception 'invalid_player'; end if;
  select * into g from public.games where id = p_game;
  select * into v_ans from public.answers where player_id = p.id and q_idx = g.current_idx;
  return jsonb_build_object(
    'score', p.score, 'streak', p.streak, 'rank', p.rank, 'correct_count', p.correct_count,
    'last_points', coalesce(v_ans.points, 0), 'last_correct', coalesce(v_ans.is_correct, false),
    'answered', v_ans.player_id is not null);
end $$;

-- Gửi đáp án: 1 lần/câu, server tính thời gian. Đường nóng nhất (~5.000 lần trong ~20s).
create or replace function public.submit_answer(p_game uuid, p_player uuid, p_token uuid, p_q_idx int, p_choice int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; gq public.game_questions; v_elapsed int; v_ok boolean; v_now timestamptz := clock_timestamp();
begin
  perform 1 from public.players where id = p_player and game_id = p_game and token = p_token;
  if not found then raise exception 'invalid_player'; end if;

  select * into g from public.games where id = p_game;
  if g.status <> 'question' or g.current_idx <> p_q_idx then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  -- cho phép trễ tối đa 1.5s do độ trễ mạng
  if v_now > g.question_deadline + interval '1500 milliseconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_late');
  end if;

  select * into gq from public.game_questions where game_id = g.id and idx = g.current_idx;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(gq.choices) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_choice');
  end if;

  v_elapsed := greatest(0, (extract(epoch from (v_now - g.question_started_at)) * 1000)::int);
  insert into public.answers(player_id, game_id, q_idx, choice, is_correct, elapsed_ms)
  values (p_player, g.id, g.current_idx, p_choice, p_choice = any(gq.correct_indexes), v_elapsed)
  on conflict (player_id, q_idx) do nothing;
  get diagnostics v_elapsed = row_count;           -- tái dùng biến: 1 = ghi mới, 0 = đã trả lời rồi
  return jsonb_build_object('ok', true, 'duplicate', v_elapsed = 0);
end $$;

-- ---------------------------------------------------------------------
-- 7. Phân quyền EXECUTE (mặc định Postgres cấp cho PUBLIC -> thu hồi hết rồi cấp lại có chọn lọc)
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.save_quiz(uuid, text, text, jsonb),
  public.create_game(uuid),
  public.host_start_question(uuid),
  public.host_reveal(uuid),
  public.host_show_leaderboard(uuid),
  public.host_end_game(uuid),
  public.host_snapshot(uuid),
  public.host_results(uuid)
to authenticated;

grant execute on function
  public.join_game(text, text),
  public.get_phase(uuid),
  public.get_player_state(uuid, uuid, uuid),
  public.get_my_result(uuid, uuid, uuid),
  public.submit_answer(uuid, uuid, uuid, int, int)
to anon, authenticated;
-- Các hàm _internal chỉ được gọi từ bên trong hàm security definer (owner), không cấp cho client.
