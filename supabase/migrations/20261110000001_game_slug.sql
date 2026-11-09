-- =====================================================================
-- OnQuiz v1.2 — Link đơn giản cho game (vd https://<domain>/tet-2027)
--   * Host đặt / đổi / bỏ link cho game của mình khi game chưa kết thúc (host_set_slug).
--   * Người chơi mở link -> resolve_slug trả về PIN -> vào trang nhập biệt danh như cũ.
--   * Link chỉ duy nhất giữa các game chưa kết thúc: game kết thúc thì link được giải phóng.
-- Chạy SAU file 20261109000001_onquiz_v1_1.sql. Chạy một lần.
-- =====================================================================

-- 1. Cột slug + ràng buộc định dạng
--    3–40 ký tự: chữ thường a-z, số, dấu gạch ngang; không bắt đầu/kết thúc bằng gạch ngang;
--    không được toàn số (tránh nhầm với PIN 6 số ở /join/:pin).
alter table public.games add column slug text;
alter table public.games add constraint games_slug_format check (
  slug is null or (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and slug !~ '^[0-9]+$')
);
create unique index games_active_slug_uq on public.games(slug)
  where slug is not null and status <> 'ended';

-- Các đường dẫn hệ thống của web app, không cho dùng làm slug
create or replace function public._slug_reserved(p_slug text)
returns boolean language sql immutable as $$
  select p_slug = any (array['join','play','host','login','admin','api','assets','brand','app',
                             'game','games','quiz','quizzes','new','static','public','www',
                             'onquiz','help','about','settings'])
$$;

-- 2. HOST: đặt / đổi / bỏ link (p_slug rỗng hoặc null = bỏ link)
create or replace function public.host_set_slug(p_game uuid, p_slug text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.games; v_slug text;
begin
  g := public._host_game(p_game);                         -- kiểm tra quyền host + khóa dòng
  if g.status = 'ended' then raise exception 'game_ended'; end if;

  v_slug := nullif(lower(btrim(coalesce(p_slug, ''))), '');
  if v_slug is not null then
    if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug ~ '^[0-9]+$' then
      raise exception 'invalid_slug';
    end if;
    if public._slug_reserved(v_slug) then raise exception 'slug_reserved'; end if;
  end if;

  begin
    update public.games set slug = v_slug where id = g.id;
  exception when unique_violation then
    raise exception 'slug_taken';                         -- link đang được game khác (chưa kết thúc) dùng
  end;
  return jsonb_build_object('slug', v_slug);
end $$;

-- 3. PLAYER (anon): link -> PIN. Chỉ trả về PIN + tên game của game đang mở.
create or replace function public.resolve_slug(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select pin, title into r from public.games
   where slug = lower(btrim(coalesce(p_slug, ''))) and status <> 'ended';
  if not found then raise exception 'game_not_found'; end if;
  return jsonb_build_object('pin', r.pin, 'title', r.title);
end $$;

-- 4. host_snapshot: bổ sung trường 'slug' (giữ nguyên toàn bộ logic cũ)
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
    'game_id', g.id, 'pin', g.pin, 'slug', g.slug, 'title', g.title, 'status', g.status,
    'idx', g.current_idx, 'total', g.total_questions,
    'players', v_players, 'answered', coalesce(v_answered, 0),
    'ms_left', case when g.status = 'question'
                    then greatest(0, (extract(epoch from (g.question_deadline - clock_timestamp())) * 1000)::int) end,
    'question', v_q) || v_extra;
end $$;

-- 5. Phân quyền: thu hồi quyền mặc định của hàm mới rồi cấp lại có chọn lọc
revoke execute on function public._slug_reserved(text)        from public, anon, authenticated;
revoke execute on function public.host_set_slug(uuid, text)   from public, anon, authenticated;
revoke execute on function public.resolve_slug(text)          from public, anon, authenticated;

grant execute on function public.host_set_slug(uuid, text) to authenticated;
grant execute on function public.resolve_slug(text)        to anon, authenticated;
-- host_snapshot: "create or replace" giữ nguyên quyền cũ (chỉ authenticated).
