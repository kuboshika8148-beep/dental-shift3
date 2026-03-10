-- =============================================
-- DentalShift PRO: 旧 app_data → 正規化テーブル データ移行
-- Supabase SQL Editor で supabase-migration.sql の後に実行
-- =============================================

DO $$
DECLARE
  _val jsonb;
  _row jsonb;
  _staff_id int;
  _rd jsonb;
  _key text;
  _parts text[];
  _year int;
  _month int;
  _is_preview boolean;
  _k text;
  _v text;
  _sem_id int;
  _vis_id int;
  _sid_val jsonb;
BEGIN
  RAISE NOTICE '=== データ移行開始 ===';

  -- ─────────────────────────────────────────────
  -- 1. スタッフ (ds_staff)
  -- ─────────────────────────────────────────────
  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_staff';
  IF _val IS NOT NULL THEN
    RAISE NOTICE 'スタッフ移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      INSERT INTO staff (id, name, role, leave_days, used_days, active,
                         kyosei_order, birth_date, join_year, employment,
                         weekly_days_off, login_id, pin)
      VALUES (
        (_row->>'id')::int,
        _row->>'name',
        _row->>'role',
        COALESCE((_row->>'leave')::int, 10),
        COALESCE((_row->>'used')::int, 0),
        COALESCE((_row->>'active')::boolean, true),
        (_row->>'kyoseiOrder')::int,
        COALESCE(_row->>'birthDate', ''),
        (_row->>'joinYear')::int,
        COALESCE(_row->>'employment', '正社員'),
        (_row->>'weeklyDaysOff')::numeric,
        NULLIF(_row->>'loginId', ''),
        NULLIF(_row->>'pin', '')
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, role = EXCLUDED.role,
        leave_days = EXCLUDED.leave_days, used_days = EXCLUDED.used_days,
        active = EXCLUDED.active, kyosei_order = EXCLUDED.kyosei_order,
        birth_date = EXCLUDED.birth_date, join_year = EXCLUDED.join_year,
        employment = EXCLUDED.employment, weekly_days_off = EXCLUDED.weekly_days_off,
        login_id = EXCLUDED.login_id, pin = EXCLUDED.pin;

      _staff_id := (_row->>'id')::int;
      IF _row->'restDays' IS NOT NULL AND jsonb_array_length(_row->'restDays') > 0 THEN
        DELETE FROM staff_rest_days WHERE staff_id = _staff_id;
        FOR _rd IN SELECT * FROM jsonb_array_elements(_row->'restDays')
        LOOP
          INSERT INTO staff_rest_days (staff_id, dow, type)
          VALUES (_staff_id, (_rd->>'dow')::int, _rd->>'type')
          ON CONFLICT (staff_id, dow) DO UPDATE SET type = EXCLUDED.type;
        END LOOP;
      END IF;
    END LOOP;
    PERFORM setval(pg_get_serial_sequence('staff', 'id'),
                   COALESCE((SELECT MAX(id) FROM staff), 1));
    RAISE NOTICE 'スタッフ移行完了';
  ELSE
    RAISE NOTICE 'ds_staff が見つかりません（スキップ）';
  END IF;

  -- ─────────────────────────────────────────────
  -- 2. シフト (ds_shifts_YEAR_MONTH / ds_shifts_nxt_YEAR_MONTH)
  -- 値の形状: {"staffId_day": "shiftType", ...}
  -- ─────────────────────────────────────────────
  RAISE NOTICE 'シフト移行中...';
  FOR _key IN
    SELECT ad.key FROM app_data ad WHERE ad.key LIKE 'ds\_shifts\_%' ESCAPE '\'
  LOOP
    SELECT (ad.value)::jsonb INTO _val FROM app_data ad WHERE ad.key = _key;
    IF _val IS NULL OR _val = '{}'::jsonb THEN
      CONTINUE;
    END IF;

    IF _key LIKE 'ds\_shifts\_nxt\_%' ESCAPE '\' THEN
      -- ds_shifts_nxt_2025_3 → year=2025, month=3, is_preview=true
      _parts := string_to_array(replace(_key, 'ds_shifts_nxt_', ''), '_');
      _year := _parts[1]::int;
      _month := _parts[2]::int;
      _is_preview := true;
    ELSE
      -- ds_shifts_2025_3 → year=2025, month=3, is_preview=false
      _parts := string_to_array(replace(_key, 'ds_shifts_', ''), '_');
      _year := _parts[1]::int;
      _month := _parts[2]::int;
      _is_preview := false;
    END IF;

    -- jsonb_each_text でKVペアをループ
    FOR _k, _v IN SELECT kv.key, kv.value FROM jsonb_each_text(_val) AS kv
    LOOP
      -- _k = "1_15" (staffId_day), _v = "出勤" (shift_type)
      INSERT INTO shifts (staff_id, year, month, day, shift_type, is_preview)
      VALUES (
        (split_part(_k, '_', 1))::int,
        _year,
        _month,
        (split_part(_k, '_', 2))::int,
        _v,
        _is_preview
      )
      ON CONFLICT (staff_id, year, month, day, is_preview)
      DO UPDATE SET shift_type = EXCLUDED.shift_type;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'シフト移行完了';

  -- ─────────────────────────────────────────────
  -- 3. 希望シフト (ds_wishes)
  -- 形状: {"staffId_day": "shiftType"} ← 月情報なし
  -- ─────────────────────────────────────────────
  RAISE NOTICE '希望シフト: 旧形式は月情報を含まないため自動移行スキップ';

  -- ─────────────────────────────────────────────
  -- 4. 設定
  -- ─────────────────────────────────────────────
  RAISE NOTICE '設定移行中...';

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_minSt';
  IF _val IS NOT NULL THEN
    UPDATE clinic_settings SET min_staff = _val WHERE id = 'default';
  END IF;

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_wh';
  IF _val IS NOT NULL THEN
    UPDATE clinic_settings SET
      wh_start = _val->>'start', wh_end = _val->>'end',
      wh_break_min = (_val->>'breakMin')::int
    WHERE id = 'default';
  END IF;

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_whSat';
  IF _val IS NOT NULL THEN
    UPDATE clinic_settings SET
      wh_sat_start = _val->>'start', wh_sat_end = _val->>'end',
      wh_sat_break_min = (_val->>'breakMin')::int
    WHERE id = 'default';
  END IF;

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_kyoseiTime';
  IF _val IS NOT NULL THEN
    UPDATE clinic_settings SET
      kyosei_sat_start = _val->'sat'->>'start',
      kyosei_sat_end   = _val->'sat'->>'end',
      kyosei_thu_start = _val->'thu'->>'start',
      kyosei_thu_end   = _val->'thu'->>'end'
    WHERE id = 'default';
  END IF;

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_calStart';
  IF _val IS NOT NULL THEN
    UPDATE clinic_settings SET cal_start = _val::int WHERE id = 'default';
  END IF;

  RAISE NOTICE '設定移行完了';

  -- ─────────────────────────────────────────────
  -- 5. 矯正オーバーライド
  -- ─────────────────────────────────────────────
  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_extraKyosei';
  IF _val IS NOT NULL AND jsonb_array_length(_val) > 0 THEN
    RAISE NOTICE '矯正追加日移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      INSERT INTO kyosei_overrides (year, month, day, action, type, label)
      VALUES (
        (_row->>'year')::int, (_row->>'month')::int, (_row->>'day')::int,
        'add', _row->>'type', _row->>'label'
      )
      ON CONFLICT (year, month, day) DO UPDATE SET
        action = 'add', type = EXCLUDED.type, label = EXCLUDED.label;
    END LOOP;
  END IF;

  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_deletedKyosei';
  IF _val IS NOT NULL AND jsonb_array_length(_val) > 0 THEN
    RAISE NOTICE '矯正削除日移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      _parts := string_to_array(_row#>>'{}', '-');
      INSERT INTO kyosei_overrides (year, month, day, action)
      VALUES (_parts[1]::int, _parts[2]::int, _parts[3]::int, 'delete')
      ON CONFLICT (year, month, day) DO UPDATE SET
        action = 'delete', type = NULL, label = NULL;
    END LOOP;
  END IF;
  RAISE NOTICE '矯正オーバーライド移行完了';

  -- ─────────────────────────────────────────────
  -- 6. 医院休診日
  -- ─────────────────────────────────────────────
  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_clinicHolidays';
  IF _val IS NOT NULL AND jsonb_array_length(_val) > 0 THEN
    RAISE NOTICE '休診日移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      INSERT INTO clinic_holidays (date, label)
      VALUES ((_row->>'date')::date, COALESCE(_row->>'label', ''))
      ON CONFLICT (date) DO UPDATE SET label = EXCLUDED.label;
    END LOOP;
    RAISE NOTICE '休診日移行完了';
  END IF;

  -- ─────────────────────────────────────────────
  -- 7. セミナー
  -- ─────────────────────────────────────────────
  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_seminars';
  IF _val IS NOT NULL AND jsonb_array_length(_val) > 0 THEN
    RAISE NOTICE 'セミナー移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      INSERT INTO seminars (name, date, start_time, end_time, break_min)
      VALUES (
        _row->>'name', (_row->>'date')::date,
        _row->>'start', _row->>'end',
        COALESCE((_row->>'breakMin')::int, 0)
      )
      RETURNING id INTO _sem_id;

      IF _row->'staffIds' IS NOT NULL AND jsonb_array_length(_row->'staffIds') > 0 THEN
        FOR _sid_val IN SELECT * FROM jsonb_array_elements(_row->'staffIds')
        LOOP
          INSERT INTO seminar_staff (seminar_id, staff_id)
          VALUES (_sem_id, (_sid_val#>>'{}')::int)
          ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;
    END LOOP;
    RAISE NOTICE 'セミナー移行完了';
  END IF;

  -- ─────────────────────────────────────────────
  -- 8. 訪問
  -- ─────────────────────────────────────────────
  SELECT (value)::jsonb INTO _val FROM app_data WHERE key = 'ds_visits';
  IF _val IS NOT NULL AND jsonb_array_length(_val) > 0 THEN
    RAISE NOTICE '訪問移行中... (% 件)', jsonb_array_length(_val);
    FOR _row IN SELECT * FROM jsonb_array_elements(_val)
    LOOP
      INSERT INTO visits (name, date, start_time, end_time, break_min)
      VALUES (
        COALESCE(_row->>'name', '訪問'), (_row->>'date')::date,
        _row->>'start', _row->>'end',
        COALESCE((_row->>'breakMin')::int, 0)
      )
      RETURNING id INTO _vis_id;

      IF _row->'staffIds' IS NOT NULL AND jsonb_array_length(_row->'staffIds') > 0 THEN
        FOR _sid_val IN SELECT * FROM jsonb_array_elements(_row->'staffIds')
        LOOP
          INSERT INTO visit_staff (visit_id, staff_id)
          VALUES (_vis_id, (_sid_val#>>'{}')::int)
          ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;
    END LOOP;
    RAISE NOTICE '訪問移行完了';
  END IF;

  RAISE NOTICE '=== データ移行完了 ===';
END $$;

-- 移行結果確認
SELECT 'staff' AS table_name, count(*) AS rows FROM staff
UNION ALL SELECT 'staff_rest_days', count(*) FROM staff_rest_days
UNION ALL SELECT 'shifts', count(*) FROM shifts
UNION ALL SELECT 'wishes', count(*) FROM wishes
UNION ALL SELECT 'clinic_holidays', count(*) FROM clinic_holidays
UNION ALL SELECT 'kyosei_overrides', count(*) FROM kyosei_overrides
UNION ALL SELECT 'seminars', count(*) FROM seminars
UNION ALL SELECT 'seminar_staff', count(*) FROM seminar_staff
UNION ALL SELECT 'visits', count(*) FROM visits
UNION ALL SELECT 'visit_staff', count(*) FROM visit_staff
ORDER BY table_name;
