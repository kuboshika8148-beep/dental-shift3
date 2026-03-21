import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

// ─── 保存中カウンター ───
let _pendingSaves = 0;
const _saveListeners = new Set();
function _notifySave(n) { _pendingSaves = n; _saveListeners.forEach(fn => fn(n)); }
export function onSaveChange(fn) { _saveListeners.add(fn); return () => _saveListeners.delete(fn); }
export function getPendingSaves() { return _pendingSaves; }

function withSaveCount(promise) {
  _notifySave(_pendingSaves + 1);
  return promise.finally(() => _notifySave(Math.max(0, _pendingSaves - 1)));
}

// localStorage キャッシュヘルパー
function lsGet(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ═══════════════════════════════════════════════════════
// useStaff: staff テーブル + staff_rest_days
// 返り値: [staff[], setStaff, synced]
// staff の形状は旧 KV と同じ: [{id,name,role,...,restDays:[{dow,type}]}]
// ═══════════════════════════════════════════════════════
export function useStaff(initStaff) {
  const [staff, _setStaff] = useState(() => lsGet("db_staff", initStaff));
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("staff").select("*").order("id");
      if (cancelled || !rows || rows.length === 0) { setSynced(true); return; }
      const { data: rds } = await supabase.from("staff_rest_days").select("*");
      const rdMap = {};
      (rds || []).forEach(r => { (rdMap[r.staff_id] = rdMap[r.staff_id] || []).push({ dow: r.dow, type: r.type }); });
      const merged = rows.map(r => ({
        id: r.id, name: r.name, role: r.role,
        leave: r.leave_days, used: r.used_days, active: r.active,
        kyoseiOrder: r.kyosei_order, birthDate: r.birth_date || "",
        joinYear: r.join_year, employment: r.employment,
        weeklyDaysOff: r.weekly_days_off != null ? Number(r.weekly_days_off) : null,
        loginId: r.login_id || "", pin: r.pin || "",
        partAmStart: r.part_am_start || "", partAmEnd: r.part_am_end || "",
        partPmStart: r.part_pm_start || "", partPmEnd: r.part_pm_end || "",
        restDays: rdMap[r.id] || [],
      }));
      if (!cancelled) { _setStaff(merged); lsSet("db_staff", merged); }
      setSynced(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const setStaff = useCallback((v) => {
    _setStaff(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_staff", next);
      // 差分を Supabase に反映
      withSaveCount((async () => {
        for (const s of next) {
          await supabase.from("staff").upsert({
            id: s.id, name: s.name, role: s.role,
            leave_days: s.leave, used_days: s.used, active: s.active,
            kyosei_order: s.kyoseiOrder, birth_date: s.birthDate || "",
            join_year: s.joinYear, employment: s.employment,
            weekly_days_off: s.weeklyDaysOff, login_id: s.loginId || null, pin: s.pin || null,
            part_am_start: s.partAmStart || "", part_am_end: s.partAmEnd || "",
            part_pm_start: s.partPmStart || "", part_pm_end: s.partPmEnd || "",
            updated_at: new Date().toISOString(),
          }, { onConflict: "id" });
          // restDays 同期
          await supabase.from("staff_rest_days").delete().eq("staff_id", s.id);
          if (s.restDays && s.restDays.length > 0) {
            await supabase.from("staff_rest_days").insert(
              s.restDays.map(rd => ({ staff_id: s.id, dow: rd.dow, type: rd.type }))
            );
          }
        }
        // 削除されたスタッフを検出
        const ids = new Set(next.map(s => s.id));
        for (const s of prev) {
          if (!ids.has(s.id)) await supabase.from("staff").delete().eq("id", s.id);
        }
      })());
      return next;
    });
  }, []);

  return [staff, setStaff, synced];
}

// ═══════════════════════════════════════════════════════
// useShifts: shifts テーブル
// 返り値: [shiftsObj, setShifts, synced]
// shiftsObj は {"staffId_day": "shiftType"} 形式
// ═══════════════════════════════════════════════════════
export function useShifts(year, month, isPreview = false) {
  const key = isPreview ? `db_shifts_nxt_${year}_${month}` : `db_shifts_${year}_${month}`;
  const [shifts, _setShifts] = useState(() => lsGet(key, {}));
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    _setShifts(lsGet(key, {}));
    setSynced(false);
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("shifts")
        .select("staff_id, day, shift_type")
        .eq("year", year).eq("month", month).eq("is_preview", isPreview);
      if (cancelled) return;
      if (rows && rows.length > 0) {
        const obj = {};
        rows.forEach(r => { obj[`${r.staff_id}_${r.day}`] = r.shift_type; });
        _setShifts(obj);
        lsSet(key, obj);
      }
      setSynced(true);
    })();
    return () => { cancelled = true; };
  }, [year, month, isPreview, key]);

  const setShifts = useCallback((v) => {
    _setShifts(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet(key, next);
      withSaveCount((async () => {
        // 差分を計算して upsert/delete
        const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const k of allKeys) {
          const [sid, d] = k.split("_").map(Number);
          if (next[k] && next[k] !== prev[k]) {
            await supabase.from("shifts").upsert({
              staff_id: sid, year, month, day: d, shift_type: next[k], is_preview: isPreview,
            }, { onConflict: "staff_id,year,month,day,is_preview" });
          } else if (!next[k] && prev[k]) {
            await supabase.from("shifts").delete()
              .eq("staff_id", sid).eq("year", year).eq("month", month).eq("day", d).eq("is_preview", isPreview);
          }
        }
      })());
      return next;
    });
  }, [year, month, isPreview, key]);

  return [shifts, setShifts, synced];
}

// ═══════════════════════════════════════════════════════
// useWishes: wishes テーブル
// 返り値: [wishesObj, setWishes]
// wishesObj は {"staffId_day": "shiftType"} 形式
// ═══════════════════════════════════════════════════════
export function useWishes(year, month) {
  const key = `db_wishes_${year}_${month}`;
  const [wishes, _setWishes] = useState(() => lsGet(key, {}));

  useEffect(() => {
    _setWishes(lsGet(key, {}));
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("wishes")
        .select("staff_id, day, shift_type")
        .eq("year", year).eq("month", month);
      if (cancelled) return;
      if (rows && rows.length > 0) {
        const obj = {};
        rows.forEach(r => { obj[`${r.staff_id}_${r.day}`] = r.shift_type; });
        _setWishes(obj);
        lsSet(key, obj);
      }
    })();
    return () => { cancelled = true; };
  }, [year, month, key]);

  const setWishes = useCallback((v) => {
    _setWishes(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet(key, next);
      withSaveCount((async () => {
        const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const k of allKeys) {
          const [sid, d] = k.split("_").map(Number);
          if (next[k] && next[k] !== prev[k]) {
            await supabase.from("wishes").upsert({
              staff_id: sid, year, month, day: d, shift_type: next[k],
            }, { onConflict: "staff_id,year,month,day" });
          } else if (!next[k] && prev[k]) {
            await supabase.from("wishes").delete()
              .eq("staff_id", sid).eq("year", year).eq("month", month).eq("day", d);
          }
        }
      })());
      return next;
    });
  }, [year, month, key]);

  return [wishes, setWishes];
}

// ═══════════════════════════════════════════════════════
// useSettings: clinic_settings テーブル
// 返り値: {minSt, setMinSt, wh, setWh, whSat, setWhSat, kyoseiTime, setKyoseiTime, calStart, setCalStart}
// ═══════════════════════════════════════════════════════
const DEFAULT_MIN = { Dr: 1, Dh: 2, Da: 1, "CS/DA": 0, "受付": 1 };
const DEFAULT_WH = { start: "08:45", end: "18:30", breakMin: 90 };
const DEFAULT_WH_SAT = { start: "08:45", end: "15:30", breakMin: 30 };
const DEFAULT_KT = { sat: { start: "14:00", end: "17:30" }, thu: { start: "14:00", end: "18:30" } };

export function useSettings() {
  const [minSt, _setMinSt] = useState(() => lsGet("db_minSt", DEFAULT_MIN));
  const [wh, _setWh] = useState(() => lsGet("db_wh", DEFAULT_WH));
  const [whSat, _setWhSat] = useState(() => lsGet("db_whSat", DEFAULT_WH_SAT));
  const [kyoseiTime, _setKyoseiTime] = useState(() => lsGet("db_kyoseiTime", DEFAULT_KT));
  const [calStart, _setCalStart] = useState(() => lsGet("db_calStart", 11));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("clinic_settings").select("*").eq("id", "default").single();
      if (cancelled || !data) return;
      const ms = data.min_staff || DEFAULT_MIN;
      const w = { start: data.wh_start, end: data.wh_end, breakMin: data.wh_break_min };
      const ws = { start: data.wh_sat_start, end: data.wh_sat_end, breakMin: data.wh_sat_break_min };
      const kt = { sat: { start: data.kyosei_sat_start, end: data.kyosei_sat_end }, thu: { start: data.kyosei_thu_start, end: data.kyosei_thu_end } };
      const cs = data.cal_start;
      _setMinSt(ms); lsSet("db_minSt", ms);
      _setWh(w); lsSet("db_wh", w);
      _setWhSat(ws); lsSet("db_whSat", ws);
      _setKyoseiTime(kt); lsSet("db_kyoseiTime", kt);
      _setCalStart(cs); lsSet("db_calStart", cs);
    })();
    return () => { cancelled = true; };
  }, []);

  const updateSetting = useCallback((patch) => {
    withSaveCount(supabase.from("clinic_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", "default").then());
  }, []);

  const setMinSt = useCallback((v) => {
    _setMinSt(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_minSt", next);
      updateSetting({ min_staff: next });
      return next;
    });
  }, [updateSetting]);

  const setWh = useCallback((v) => {
    _setWh(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_wh", next);
      updateSetting({ wh_start: next.start, wh_end: next.end, wh_break_min: next.breakMin });
      return next;
    });
  }, [updateSetting]);

  const setWhSat = useCallback((v) => {
    _setWhSat(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_whSat", next);
      updateSetting({ wh_sat_start: next.start, wh_sat_end: next.end, wh_sat_break_min: next.breakMin });
      return next;
    });
  }, [updateSetting]);

  const setKyoseiTime = useCallback((v) => {
    _setKyoseiTime(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_kyoseiTime", next);
      updateSetting({
        kyosei_sat_start: next.sat.start, kyosei_sat_end: next.sat.end,
        kyosei_thu_start: next.thu.start, kyosei_thu_end: next.thu.end,
      });
      return next;
    });
  }, [updateSetting]);

  const setCalStart = useCallback((v) => {
    _setCalStart(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_calStart", next);
      updateSetting({ cal_start: next });
      return next;
    });
  }, [updateSetting]);

  return { minSt, setMinSt, wh, setWh, whSat, setWhSat, kyoseiTime, setKyoseiTime, calStart, setCalStart };
}

// ═══════════════════════════════════════════════════════
// useHolidays: clinic_holidays テーブル
// 返り値: [holidays[], setHolidays]
// holidays = [{date:"YYYY-MM-DD", label:"..."}]
// ═══════════════════════════════════════════════════════
export function useHolidays() {
  const [holidays, _setHolidays] = useState(() => lsGet("db_holidays", []));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("clinic_holidays").select("*").order("date");
      if (cancelled || !data) return;
      const arr = data.map(r => ({ date: r.date, label: r.label }));
      _setHolidays(arr);
      lsSet("db_holidays", arr);
    })();
    return () => { cancelled = true; };
  }, []);

  const setHolidays = useCallback((v) => {
    _setHolidays(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_holidays", next);
      withSaveCount((async () => {
        // 削除
        const nextDates = new Set(next.map(h => h.date));
        for (const h of prev) {
          if (!nextDates.has(h.date)) await supabase.from("clinic_holidays").delete().eq("date", h.date);
        }
        // 追加
        const prevDates = new Set(prev.map(h => h.date));
        for (const h of next) {
          if (!prevDates.has(h.date)) {
            await supabase.from("clinic_holidays").upsert({ date: h.date, label: h.label }, { onConflict: "date" });
          }
        }
      })());
      return next;
    });
  }, []);

  return [holidays, setHolidays];
}

// ═══════════════════════════════════════════════════════
// useKyoseiOverrides: kyosei_overrides テーブル
// 返り値: [extraKyosei, setExtraKyosei, deletedKyosei, setDeletedKyosei]
// extraKyosei = [{year, month, day, type, label}]
// deletedKyosei = ["year-month-day", ...]
// ═══════════════════════════════════════════════════════
export function useKyoseiOverrides() {
  const [extra, _setExtra] = useState(() => lsGet("db_extraKyosei", []));
  const [deleted, _setDeleted] = useState(() => lsGet("db_deletedKyosei", []));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("kyosei_overrides").select("*");
      if (cancelled || !data) return;
      const ext = data.filter(r => r.action === "add").map(r => ({
        year: r.year, month: r.month, day: r.day, type: r.type, label: r.label,
      }));
      const del = data.filter(r => r.action === "delete").map(r => `${r.year}-${r.month}-${r.day}`);
      _setExtra(ext); lsSet("db_extraKyosei", ext);
      _setDeleted(del); lsSet("db_deletedKyosei", del);
    })();
    return () => { cancelled = true; };
  }, []);

  const setExtra = useCallback((v) => {
    _setExtra(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_extraKyosei", next);
      withSaveCount((async () => {
        // 削除分
        for (const e of prev) {
          if (!next.some(n => n.year === e.year && n.month === e.month && n.day === e.day)) {
            await supabase.from("kyosei_overrides").delete()
              .eq("year", e.year).eq("month", e.month).eq("day", e.day).eq("action", "add");
          }
        }
        // 追加分
        for (const e of next) {
          if (!prev.some(p => p.year === e.year && p.month === e.month && p.day === e.day)) {
            await supabase.from("kyosei_overrides").upsert({
              year: e.year, month: e.month, day: e.day, action: "add", type: e.type, label: e.label,
            }, { onConflict: "year,month,day" });
          }
        }
      })());
      return next;
    });
  }, []);

  const setDeleted = useCallback((v) => {
    _setDeleted(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_deletedKyosei", next);
      withSaveCount((async () => {
        const prevSet = new Set(prev);
        const nextSet = new Set(next);
        for (const k of prev) {
          if (!nextSet.has(k)) {
            const [y, m, d] = k.split("-").map(Number);
            await supabase.from("kyosei_overrides").delete().eq("year", y).eq("month", m).eq("day", d).eq("action", "delete");
          }
        }
        for (const k of next) {
          if (!prevSet.has(k)) {
            const [y, m, d] = k.split("-").map(Number);
            await supabase.from("kyosei_overrides").upsert({
              year: y, month: m, day: d, action: "delete", type: null, label: null,
            }, { onConflict: "year,month,day" });
          }
        }
      })());
      return next;
    });
  }, []);

  return [extra, setExtra, deleted, setDeleted];
}

// ═══════════════════════════════════════════════════════
// useSeminars: seminars + seminar_staff
// 返り値: [seminars[], setSeminars]
// seminars = [{id, name, date, start, end, breakMin, staffIds:[]}]
// ═══════════════════════════════════════════════════════
export function useSeminars() {
  const [seminars, _setSeminars] = useState(() => lsGet("db_seminars", []));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("seminars").select("*, seminar_staff(staff_id)").order("date");
      if (cancelled || !rows) return;
      const arr = rows.map(r => ({
        id: r.id, name: r.name, date: r.date, start: r.start_time, end: r.end_time,
        breakMin: r.break_min, staffIds: (r.seminar_staff || []).map(ss => ss.staff_id),
      }));
      _setSeminars(arr);
      lsSet("db_seminars", arr);
    })();
    return () => { cancelled = true; };
  }, []);

  const setSeminars = useCallback((v) => {
    _setSeminars(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_seminars", next);
      withSaveCount((async () => {
        const prevIds = new Set(prev.map(s => s.id));
        const nextIds = new Set(next.map(s => s.id));
        // 削除
        for (const s of prev) {
          if (!nextIds.has(s.id)) await supabase.from("seminars").delete().eq("id", s.id);
        }
        // 追加・更新
        for (const s of next) {
          if (!prevIds.has(s.id)) {
            // 新規
            const { data } = await supabase.from("seminars").insert({
              name: s.name, date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
            }).select("id").single();
            if (data) {
              s.id = data.id; // DB生成ID に差し替え
              if (s.staffIds.length > 0) {
                await supabase.from("seminar_staff").insert(s.staffIds.map(sid => ({ seminar_id: data.id, staff_id: sid })));
              }
            }
          } else {
            // 更新
            const old = prev.find(p => p.id === s.id);
            if (!old || JSON.stringify(old) !== JSON.stringify(s)) {
              await supabase.from("seminars").update({
                name: s.name, date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
              }).eq("id", s.id);
              await supabase.from("seminar_staff").delete().eq("seminar_id", s.id);
              if (s.staffIds.length > 0) {
                await supabase.from("seminar_staff").insert(s.staffIds.map(sid => ({ seminar_id: s.id, staff_id: sid })));
              }
            }
          }
        }
      })());
      return next;
    });
  }, []);

  return [seminars, setSeminars];
}

// ═══════════════════════════════════════════════════════
// useVisits: visits + visit_staff
// 返り値: [visits[], setVisits]
// visits = [{id, name, date, start, end, breakMin, staffIds:[]}]
// ═══════════════════════════════════════════════════════
export function useVisits() {
  const [visits, _setVisits] = useState(() => lsGet("db_visits", []));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("visits").select("*, visit_staff(staff_id)").order("date");
      if (cancelled || !rows) return;
      const arr = rows.map(r => ({
        id: r.id, name: r.name, date: r.date, start: r.start_time, end: r.end_time,
        breakMin: r.break_min, staffIds: (r.visit_staff || []).map(vs => vs.staff_id),
      }));
      _setVisits(arr);
      lsSet("db_visits", arr);
    })();
    return () => { cancelled = true; };
  }, []);

  const setVisits = useCallback((v) => {
    _setVisits(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_visits", next);
      withSaveCount((async () => {
        const prevIds = new Set(prev.map(s => s.id));
        const nextIds = new Set(next.map(s => s.id));
        for (const s of prev) {
          if (!nextIds.has(s.id)) await supabase.from("visits").delete().eq("id", s.id);
        }
        for (const s of next) {
          if (!prevIds.has(s.id)) {
            const { data } = await supabase.from("visits").insert({
              name: s.name || "訪問", date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
            }).select("id").single();
            if (data) {
              s.id = data.id;
              if (s.staffIds.length > 0) {
                await supabase.from("visit_staff").insert(s.staffIds.map(sid => ({ visit_id: data.id, staff_id: sid })));
              }
            }
          } else {
            const old = prev.find(p => p.id === s.id);
            if (!old || JSON.stringify(old) !== JSON.stringify(s)) {
              await supabase.from("visits").update({
                name: s.name || "訪問", date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
              }).eq("id", s.id);
              await supabase.from("visit_staff").delete().eq("visit_id", s.id);
              if (s.staffIds.length > 0) {
                await supabase.from("visit_staff").insert(s.staffIds.map(sid => ({ visit_id: s.id, staff_id: sid })));
              }
            }
          }
        }
      })());
      return next;
    });
  }, []);

  return [visits, setVisits];
}

// ═══════════════════════════════════════════════════════
// useMeetings: meetings + meeting_staff
// 返り値: [meetings[], setMeetings]
// meetings = [{id, name, date, start, end, breakMin, staffIds:[]}]
// ═══════════════════════════════════════════════════════
export function useMeetings() {
  const [meetings, _setMeetings] = useState(() => lsGet("db_meetings", []));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase.from("meetings").select("*, meeting_staff(staff_id)").order("date");
      if (cancelled || !rows) return;
      const arr = rows.map(r => ({
        id: r.id, name: r.name, date: r.date, start: r.start_time, end: r.end_time,
        breakMin: r.break_min, staffIds: (r.meeting_staff || []).map(ms => ms.staff_id),
      }));
      _setMeetings(arr);
      lsSet("db_meetings", arr);
    })();
    return () => { cancelled = true; };
  }, []);

  const setMeetings = useCallback((v) => {
    _setMeetings(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      lsSet("db_meetings", next);
      withSaveCount((async () => {
        const prevIds = new Set(prev.map(s => s.id));
        const nextIds = new Set(next.map(s => s.id));
        for (const s of prev) {
          if (!nextIds.has(s.id)) await supabase.from("meetings").delete().eq("id", s.id);
        }
        for (const s of next) {
          if (!prevIds.has(s.id)) {
            const { data } = await supabase.from("meetings").insert({
              name: s.name || "院内ミーティング", date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
            }).select("id").single();
            if (data) {
              s.id = data.id;
              if (s.staffIds.length > 0) {
                await supabase.from("meeting_staff").insert(s.staffIds.map(sid => ({ meeting_id: data.id, staff_id: sid })));
              }
            }
          } else {
            const old = prev.find(p => p.id === s.id);
            if (!old || JSON.stringify(old) !== JSON.stringify(s)) {
              await supabase.from("meetings").update({
                name: s.name || "院内ミーティング", date: s.date, start_time: s.start, end_time: s.end, break_min: s.breakMin || 0,
              }).eq("id", s.id);
              await supabase.from("meeting_staff").delete().eq("meeting_id", s.id);
              if (s.staffIds.length > 0) {
                await supabase.from("meeting_staff").insert(s.staffIds.map(sid => ({ meeting_id: s.id, staff_id: sid })));
              }
            }
          }
        }
      })());
      return next;
    });
  }, []);

  return [meetings, setMeetings];
}
