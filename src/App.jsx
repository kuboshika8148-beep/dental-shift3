import { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "./supabase.js";
import { useStaff, useShifts, useWishes, useSettings, useHolidays, useKyoseiOverrides, useSeminars, useVisits, useMeetings, onSaveChange, getPendingSaves } from "./db.js";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════
const ROLES = {
  Dr:      { label:"歯科医師",   short:"Dr",    color:"#b91c1c", bg:"#fee2e2" },
  Dh:      { label:"歯科衛生士", short:"Dh",    color:"#1d4ed8", bg:"#dbeafe" },
  Da:      { label:"歯科助手",   short:"Da",    color:"#15803d", bg:"#dcfce7" },
  "CS/DA": { label:"CS/DA",     short:"CS/DA", color:"#d97706", bg:"#fef9c3" },
  受付:    { label:"受付",       short:"受付",   color:"#7c3aed", bg:"#ede9fe" },
  技工士:  { label:"技工士",     short:"技工",   color:"#b45309", bg:"#fef3c7" },
  TC:      { label:"TC",        short:"TC",    color:"#0e7490", bg:"#cffafe" },
};

// 矯正当番対象役職
const KYOSEI_ROLES = new Set(["Dh","Da","CS/DA","受付","TC"]);

// シフト種別 ── 就業規則（第34条）に基づく正確な時間
// 平日:    8:55〜19:00 休憩12:30〜14:00(90分) = 8h05m
// 通常土曜: 8:55〜15:00 休憩30分 = 5h35m
// 第2土曜: 8:55〜17:00 休憩12:30〜14:00(90分) = 6h35m
// 矯正(土): 8:55〜12:30+14:00〜17:30 = 7h05m
// 矯正(木): 8:55〜12:30+14:00〜18:30 = 8h05m
const SHIFT_TYPES = {
  出勤:        { label:"出勤",              color:"#1d4ed8", bg:"#dbeafe",  hours:8.25 },
  訪問:        { label:"訪問",              color:"#7c3aed", bg:"#ede9fe",  hours:8.25 },
  AM_MT:       { label:"AMセミナー出勤",    color:"#0891b2", bg:"#cffafe",  hours:4.125 },
  土曜出勤:    { label:"土曜出勤",          color:"#0369a1", bg:"#e0f2fe",  hours:6.25 },
  第2土曜出勤: { label:"第2土曜",           color:"#6d28d9", bg:"#ede9fe",  hours:6.25 },
  矯正当番_土:  { label:"矯正当番(土)",     color:"#0f766e", bg:"#ccfbf1",  hours:5.5  },
  矯正当番_木:  { label:"矯正当番(木)",     color:"#065f46", bg:"#a7f3d0",  hours:6.5  },
  休み:        { label:"休み",              color:"#9ca3af", bg:"#f3f4f6",  hours:0    },
  有給:        { label:"有給",              color:"#d97706", bg:"#fef3c7",  hours:0    },
  午前半休:    { label:"午後出勤（午前休）", color:"#c2410c", bg:"#ffedd5",  hours:4.125 },
  午後半休:    { label:"午前出勤（午後休）", color:"#a16207", bg:"#fef9c3",  hours:4.125 },
  "17時まで":  { label:"17時まで勤務",      color:"#4338ca", bg:"#e0e7ff",  hours:7.25  },
};

const DAYS_JP = ["日","月","火","水","木","金","土"];

// 祝日 2025-2026
const HOLIDAYS = new Set([
  "2025-01-01","2025-01-13","2025-02-11","2025-02-23","2025-03-20",
  "2025-04-29","2025-05-03","2025-05-04","2025-05-05","2025-07-21",
  "2025-08-11","2025-09-15","2025-09-23","2025-10-13","2025-11-03",
  "2025-11-23","2025-12-23",
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20",
  "2026-04-29","2026-05-03","2026-05-04","2026-05-05","2026-07-20",
  "2026-08-11","2026-09-21","2026-09-22","2026-09-23","2026-10-12",
  "2026-11-03","2026-11-23","2026-12-23",
]);

function isHoliday(y,m,d) {
  return HOLIDAYS.has(`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
}
function dim(y,m)     { return new Date(y,m+1,0).getDate(); }
function fdow(y,m)    { return new Date(y,m,1).getDay(); }
function wkey(y,m,d)  { return Math.floor((d+fdow(y,m)-1)/7); }

// 第N曜日を求める (1-indexed: n=1→第1, n=2→第2...)
function nthWeekday(y,m,dow,n) {
  let count=0;
  const days=dim(y,m);
  for(let d=1;d<=days;d++){
    if(new Date(y,m,d).getDay()===dow){
      count++;
      if(count===n) return d;
    }
  }
  return -1;
}

// 矯正日かどうか＋種別判定
function kyoseiInfo(y,m,d) {
  const dow=new Date(y,m,d).getDay();
  if(isHoliday(y,m,d)) return null;
  // 第2土曜
  if(dow===6 && nthWeekday(y,m,6,2)===d) return { type:"土", label:"第2土" };
  // 第4木曜
  if(dow===4 && nthWeekday(y,m,4,4)===d) return { type:"木", label:"第4木" };
  return null;
}

// ═══════════════════════════════════════════════════════
// INITIAL DATA
// ═══════════════════════════════════════════════════════
const INIT_STAFF = [
  // ── Dh 正社員 ──
  { id: 1, name:"西本 由美",   role:"Dh", leave:27, used:0, active:true, kyoseiOrder:1, birthDate:"", joinYear:2012, employment:"正社員", weeklyDaysOff:3, restDays:[] },
  { id: 2, name:"福山 奈々",   role:"Dh", leave:47, used:0, active:true, kyoseiOrder:2, birthDate:"", joinYear:2018, employment:"正社員", weeklyDaysOff:3, restDays:[] },
  { id: 3, name:"宮下 真菜",   role:"Dh", leave:26, used:0, active:true, kyoseiOrder:3, birthDate:"", joinYear:2023, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id: 4, name:"濱田 淑恵",   role:"Dh", leave:9,  used:0, active:true, kyoseiOrder:4, birthDate:"", joinYear:2023, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id: 5, name:"奥 祐佳里",   role:"Dh", leave:17, used:0, active:true, kyoseiOrder:5, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id: 6, name:"西森 遥香",   role:"Dh", leave:24, used:0, active:true, kyoseiOrder:6, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id: 7, name:"堀川 真菜",   role:"Dh", leave:0,  used:0, active:true, kyoseiOrder:7, birthDate:"", joinYear:2025, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id: 8, name:"橋村 優華",   role:"Dh", leave:2,  used:0, active:true, kyoseiOrder:8, birthDate:"", joinYear:2025, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  // ── Dh パート ──
  { id: 9, name:"岩本 真理",   role:"Dh", leave:23, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2021, employment:"パート", weeklyDaysOff:null, restDays:[] },
  { id:10, name:"楓 かおり",   role:"Dh", leave:28, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2023, employment:"パート", weeklyDaysOff:null, restDays:[] },
  { id:11, name:"井上 彩花",   role:"Dh", leave:9,  used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2025, employment:"パート", weeklyDaysOff:null, restDays:[] },
  // ── Da ──
  { id:12, name:"村山 由身子", role:"Da", leave:16, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2020, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:13, name:"谷 めぐみ",   role:"Da", leave:24, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:14, name:"佐々木 美佳", role:"Da", leave:13, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2023, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:15, name:"平野 翔一",   role:"Da", leave:27, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2023, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  // ── 受付 ──
  { id:16, name:"中田 麻悠",   role:"受付", leave:33, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2022, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:17, name:"西田 まどか", role:"受付", leave:24, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2022, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:18, name:"松本 梨帆",   role:"受付", leave:30, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  // ── Dr ──
  { id:19, name:"岡崎 絵涼依", role:"Dr", leave:17, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:20, name:"伊賀 利香",   role:"Dr", leave:13, used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
  { id:21, name:"嶋津 恵加",   role:"Dr", leave:1,  used:0, active:true, kyoseiOrder:null, birthDate:"", joinYear:2024, employment:"正社員", weeklyDaysOff:2, restDays:[] },
];

const DEFAULT_MIN = { Dr:1, Dh:2, Da:1, 受付:1 };
const DEFAULT_WH     = { start:"08:45", end:"18:30", breakMin:90 };
const DEFAULT_WH_SAT = { start:"08:45", end:"15:30", breakMin:30 };

// 月間所定労働時間 (週40h変形)
function monthlyStd(y,m) {
  return Math.round(40*dim(y,m)/7*10)/10;
}
// 1日所定時間 (h)
function dailyH(wh) {
  const [sh,sm]=wh.start.split(":").map(Number);
  const [eh,em]=wh.end.split(":").map(Number);
  return Math.max(0,((eh*60+em)-(sh*60+sm)-wh.breakMin)/60);
}

// ═══════════════════════════════════════════════════════
// AUTO SCHEDULER
// ═══════════════════════════════════════════════════════
function autoSchedule(y,m,staff,minStaff,kyoseiAssignedManual={},kyoseiRestManual={},customKyoseiDays={}) {
  const total=dim(y,m);
  const shifts={};

  // ── 矯正日 ──
  const kyoseiDays = Object.keys(customKyoseiDays).length > 0
    ? customKyoseiDays
    : (() => {
        const map={};
        for(let d=1;d<=total;d++){
          const ki=kyoseiInfo(y,m,d);
          if(ki) map[d]=ki;
        }
        return map;
      })();

  // ── 矯正当番アサイン ──
  const kyoseiStaff=staff.filter(s=>KYOSEI_ROLES.has(s.role)&&s.kyoseiOrder!=null)
    .sort((a,b)=>a.kyoseiOrder-b.kyoseiOrder);
  let kyoseiRotIdx=0;
  const kyoseiAssigned={};
  Object.keys(kyoseiDays).forEach(ds=>{
    const d=Number(ds);
    if(kyoseiAssignedManual[d]) kyoseiAssigned[d]=kyoseiAssignedManual[d];
    else if(kyoseiStaff.length>0){
      kyoseiAssigned[d]=kyoseiStaff[kyoseiRotIdx%kyoseiStaff.length].id;
      kyoseiRotIdx++;
    }
  });

  // ── 月曜基準の週キー ──
  function mwkey(d){
    const dow=new Date(y,m,d).getDay();
    return d-(dow===0?6:dow-1);
  }

  // ── 週ごとの営業日リスト（日曜・祝日除く） ──
  const weekAllDays={}; // weekKey -> [d, ...]  土曜含む
  for(let d=1;d<=total;d++){
    const dow=new Date(y,m,d).getDay();
    if(dow===0||isHoliday(y,m,d)) continue;
    const wk=mwkey(d);
    if(!weekAllDays[wk]) weekAllDays[wk]=[];
    weekAllDays[wk].push(d);
  }

  // ── シフト生成（休みは固定休みのみ） ──
  for(let d=1;d<=total;d++){
    const dow=new Date(y,m,d).getDay();
    const hol=isHoliday(y,m,d);
    if(dow===0||hol) continue;

    const ki=kyoseiDays[d];

    staff.forEach(s=>{
      const restEntry=(s.restDays||[]).find(r=>r.dow===dow);
      const isHalfAM=restEntry?.type==="午前";
      const isHalfPM=restEntry?.type==="午後";

      // 定休（全日）
      if(restEntry?.type==="全日"){ shifts[`${s.id}_${d}`]="休み"; return; }

      // 矯正日（当番なし：出勤者全員に矯正シフトを適用）
      if(ki){
        if(isHalfAM){ shifts[`${s.id}_${d}`]="午前半休"; return; }
        if(isHalfPM){ shifts[`${s.id}_${d}`]="午後半休"; return; }
        shifts[`${s.id}_${d}`]=ki.type==="土"?"矯正当番_土":"矯正当番_木"; return;
      }

      // 通常日（土曜含む）
      if(isHalfAM){
        shifts[`${s.id}_${d}`]="午前半休";
      } else if(isHalfPM){
        shifts[`${s.id}_${d}`]="午後半休";
      } else {
        shifts[`${s.id}_${d}`]=dow===6?"土曜出勤":"出勤";
      }
    });
  }
  return shifts;
}

// ═══════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700;900&family=JetBrains+Mono:wght@400;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#eef1f7;--surf:#fff;--bdr:#e2e8f2;
  --txt:#0c1a2e;--mut:#64748b;
  --ac:#0f4c8a;--ac2:#065f46;
  --red:#dc2626;--ora:#d97706;--grn:#16a34a;
  --r:12px;--sh:0 2px 10px rgba(12,26,46,.07);
}
body{font-family:'Noto Sans JP',sans-serif;background:var(--bg);color:var(--txt);}

/* LOGIN */
.lp{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(150deg,#0c1a2e 0%,#0f4c8a 55%,#065f46 100%);
  position:relative;overflow:hidden;}
.lp::before{content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse 70% 50% at 65% 25%,rgba(255,255,255,.07),transparent 70%);}
.lcard{background:rgba(255,255,255,.08);backdrop-filter:blur(20px);
  border:1px solid rgba(255,255,255,.15);border-radius:22px;
  padding:42px 38px;width:100%;max-width:410px;position:relative;z-index:1;}
.lico{text-align:center;font-size:38px;margin-bottom:10px;}
.lttl{color:#fff;font-size:20px;font-weight:900;text-align:center;letter-spacing:-.4px;}
.lsub{color:rgba(255,255,255,.38);font-size:11px;text-align:center;
  margin:4px 0 26px;font-family:'JetBrains Mono',monospace;}
.ltabs{display:flex;gap:4px;background:rgba(0,0,0,.22);padding:3px;border-radius:8px;margin-bottom:20px;}
.ltab{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-size:12px;
  font-family:'Noto Sans JP',sans-serif;font-weight:600;
  color:rgba(255,255,255,.45);background:transparent;transition:all .2s;}
.ltab.on{background:#fff;color:#0c1a2e;}
.lf{margin-bottom:13px;}
.lf label{display:block;color:rgba(255,255,255,.5);font-size:9px;font-weight:800;
  margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px;}
.lf input,.lf select{width:100%;padding:10px 12px;background:rgba(255,255,255,.1);
  border:1px solid rgba(255,255,255,.18);border-radius:8px;color:#fff;
  font-size:13px;font-family:'Noto Sans JP',sans-serif;outline:none;}
.lf input:focus,.lf select:focus{border-color:#38bdf8;}
.lf select option{color:#0c1a2e;background:#fff;}
.lbtn{width:100%;padding:12px;background:linear-gradient(135deg,#38bdf8,#0f4c8a);
  border:none;border-radius:9px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;
  font-family:'Noto Sans JP',sans-serif;margin-top:5px;
  box-shadow:0 4px 16px rgba(56,189,248,.33);transition:transform .1s;}
.lbtn:hover{transform:translateY(-1px);}
.lhint{color:rgba(255,255,255,.2);font-size:10px;text-align:center;
  margin-top:10px;font-family:'JetBrains Mono',monospace;}

/* HEADER */
.hdr{background:#0c1a2e;height:54px;padding:0 18px;display:flex;align-items:center;gap:10px;
  position:sticky;top:0;z-index:200;border-bottom:1px solid #1a3050;}
.hlogo{color:#fff;font-size:14px;font-weight:900;display:flex;align-items:center;gap:6px;}
.hlogo em{color:#38bdf8;font-style:normal;}
.hnav{display:flex;gap:2px;margin-left:14px;}
.hnb{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:11px;
  font-family:'Noto Sans JP',sans-serif;font-weight:600;
  color:rgba(255,255,255,.45);background:transparent;transition:all .15s;}
.hnb:hover{color:#fff;background:rgba(255,255,255,.07);}
.hnb.on{background:#38bdf8;color:#0c1a2e;}
.hr{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11px;}
.hbadge{background:rgba(56,189,248,.15);color:#38bdf8;padding:2px 7px;
  border-radius:20px;font-size:9px;font-weight:800;}
.halert{padding:2px 9px;border-radius:20px;font-size:10px;font-weight:700;cursor:pointer;}
.halert.red{background:#fee2e2;color:#b91c1c;}
.halert.ora{background:#fffbeb;color:#92400e;}
.hbtn{padding:4px 10px;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.13);border-radius:6px;
  color:rgba(255,255,255,.5);cursor:pointer;font-size:10px;
  font-family:'Noto Sans JP',sans-serif;}
.hbtn:hover{color:#fff;background:rgba(255,255,255,.13);}

/* LAYOUT */
.main{padding:20px;max-width:1800px;margin:0 auto;}
.ph{display:flex;align-items:center;justify-content:space-between;
  margin-bottom:16px;flex-wrap:wrap;gap:8px;}
.ptitle{font-size:17px;font-weight:900;letter-spacing:-.3px;}
.ptitle small{font-size:11px;color:var(--mut);font-weight:400;margin-left:6px;}

/* MONTH NAV */
.mnav{display:flex;align-items:center;gap:7px;background:var(--surf);
  border:1px solid var(--bdr);border-radius:8px;padding:4px 8px;box-shadow:var(--sh);}
.mnav button{background:none;border:none;font-size:15px;cursor:pointer;color:var(--mut);
  width:22px;height:22px;display:flex;align-items:center;justify-content:center;
  border-radius:4px;transition:background .15s;}
.mnav button:hover{background:var(--bg);}
.mlbl{font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;
  min-width:68px;text-align:center;color:var(--txt);}

/* CONTROL PANEL */
.cp{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:16px 18px;margin-bottom:16px;box-shadow:var(--sh);}
.cpt{font-size:11px;font-weight:800;color:var(--txt);margin-bottom:12px;
  text-transform:uppercase;letter-spacing:.4px;}
.cpg{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:9px;}
.cpi{background:var(--bg);border-radius:8px;padding:11px 12px;}
.cpi label{display:block;font-size:9px;font-weight:800;color:var(--mut);
  margin-bottom:7px;text-transform:uppercase;letter-spacing:.3px;}
.cpr{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--mut);margin-bottom:4px;}
.cpr:last-child{margin-bottom:0;}
.cpr span{font-size:9px;font-weight:600;min-width:38px;}
.ni{width:44px;padding:3px 6px;border:1.5px solid var(--bdr);border-radius:5px;
  font-size:12px;font-family:'JetBrains Mono',monospace;font-weight:700;
  text-align:center;outline:none;background:#fff;}
.ni:focus{border-color:var(--ac);}
.ti{width:76px;padding:3px 6px;border:1.5px solid var(--bdr);border-radius:5px;
  font-size:11px;font-family:'JetBrains Mono',monospace;outline:none;background:#fff;}
.ti:focus{border-color:var(--ac);}
.abtn{padding:9px 16px;background:linear-gradient(135deg,#0f4c8a,#065f46);
  border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;
  font-family:'Noto Sans JP',sans-serif;box-shadow:0 3px 10px rgba(15,76,138,.28);
  transition:transform .1s;display:flex;align-items:center;gap:5px;}
.abtn:hover{transform:translateY(-1px);}
.cbtn{padding:9px 13px;background:var(--bg);border:1.5px solid var(--bdr);
  border-radius:8px;color:var(--mut);font-size:11px;font-weight:600;cursor:pointer;
  font-family:'Noto Sans JP',sans-serif;}
.pbtn{padding:9px 13px;background:#0c1a2e;border:none;border-radius:8px;
  color:#fff;font-size:11px;font-weight:600;cursor:pointer;
  font-family:'Noto Sans JP',sans-serif;}

/* KYOSEI INFO CARD */
.kinfo{background:linear-gradient(135deg,#f0fdfa,#ecfdf5);border:1px solid #6ee7b7;
  border-radius:10px;padding:12px 16px;margin-bottom:14px;}
.kinfo-title{font-size:11px;font-weight:800;color:#065f46;margin-bottom:8px;
  text-transform:uppercase;letter-spacing:.3px;}
.kinfo-grid{display:flex;gap:20px;flex-wrap:wrap;}
.kinfo-item{font-size:12px;color:#047857;}
.kinfo-item strong{font-weight:800;}

/* ALERT BARS */
.alertbar{background:#fef2f2;border:1px solid #fecaca;border-left:4px solid var(--red);
  border-radius:9px;padding:10px 13px;margin-bottom:12px;
  font-size:11px;color:#991b1b;display:flex;align-items:flex-start;gap:8px;}
.alist{list-style:none;display:flex;flex-wrap:wrap;gap:5px;flex:1;}
.alist li{background:#fee2e2;padding:2px 8px;border-radius:20px;
  font-size:10px;font-weight:700;color:#b91c1c;}
.hrsbar{background:#fffbeb;border:1px solid #fde68a;border-left:4px solid var(--ora);
  border-radius:9px;padding:10px 13px;margin-bottom:12px;font-size:11px;color:#92400e;
  display:flex;align-items:flex-start;gap:8px;}

/* LEGEND */
.legend{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:11px;}
.leg{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--mut);}
.ld{width:24px;height:16px;border-radius:3px;display:flex;align-items:center;
  justify-content:center;font-size:8px;font-weight:800;}

/* SHIFT TABLE */
.twrap{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  overflow:auto;box-shadow:var(--sh);}
.stbl{border-collapse:collapse;font-size:10.5px;min-width:100%;}
.stbl th{padding:6px 3px;text-align:center;font-weight:700;font-size:9px;
  border-bottom:2px solid var(--bdr);white-space:nowrap;
  background:#f7f9fc;color:var(--mut);position:sticky;top:0;z-index:2;}
.stbl th.sc{text-align:left;padding-left:11px;min-width:115px;
  position:sticky;left:0;z-index:3;background:#f7f9fc;}
.stbl td{padding:4px 3px;border-bottom:1px solid #f1f5f9;text-align:center;}
.stbl td.sn{text-align:left;padding-left:11px;background:#fff;
  position:sticky;left:0;z-index:1;border-right:2px solid var(--bdr);min-width:115px;}
.stbl td.sn .nm{font-weight:700;font-size:11px;color:var(--txt);}
.stbl td.sn .rb{display:inline-block;padding:1px 5px;border-radius:7px;
  font-size:8px;font-weight:800;margin-top:1px;}
.stbl tr:hover td{background:#f8fafc;}
.stbl tr:hover td.sn{background:#f8fafc;}

/* column types */
.th-sun{color:#ef4444!important;}
.th-sat{color:#3b82f6!important;}
.th-hol{background:#fffbeb!important;color:#b45309!important;}
.th-k2sat{background:#f0fdfa!important;color:#065f46!important;border-top:2px solid #6ee7b7!important;}
.th-k4thu{background:#ecfdf5!important;color:#065f46!important;border-top:2px solid #6ee7b7!important;}
.td-sun{background:#fff8f8!important;}
.td-sat{background:#f8f9ff!important;}
.td-hol{background:#fffbeb!important;}
.td-k{background:#f0fdfa!important;}
.today-mark{background:#fef3c7;color:#92400e;border-radius:3px;padding:0 2px;display:inline-block;}
.k-mark{display:block;font-size:7px;color:#065f46;font-weight:900;margin-top:1px;}
.k-sub{display:block;font-size:6px;color:#059669;font-weight:600;}

/* shift cells */
.scl{display:inline-flex;align-items:center;justify-content:center;
  padding:2px 4px;border-radius:4px;font-size:9px;font-weight:800;
  cursor:pointer;min-width:28px;height:19px;border:none;
  font-family:'Noto Sans JP',sans-serif;transition:opacity .15s,transform .1s;white-space:nowrap;}
.scl:hover{opacity:.75;transform:scale(1.06);}
.scl-e{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:19px;border-radius:4px;border:1.5px dashed #d1d5db;
  cursor:pointer;transition:all .15s;}
.scl-e:hover{border-color:#6b7280;background:#f9fafb;}

/* role header */
.rhr td{background:#f1f5f9!important;padding:2px 4px;font-size:9px;font-weight:900;
  color:var(--mut);letter-spacing:.4px;border-bottom:1px solid var(--bdr);
  vertical-align:middle;text-align:center;}
.rhr td:first-child{position:sticky;left:0;padding:4px 11px;z-index:2;text-align:left;}
/* count row */
.crow td{background:#f8fafc!important;font-size:9px;}
.crow td.sn{font-size:9px;color:var(--mut);font-weight:800;}
.cok{background:#dcfce7;color:#15803d;font-family:'JetBrains Mono',monospace;
  font-size:9px;font-weight:700;border-radius:3px;padding:1px 3px;display:inline-block;}
.cng{background:#fee2e2;color:#b91c1c;font-family:'JetBrains Mono',monospace;
  font-size:9px;font-weight:700;border-radius:3px;padding:1px 3px;display:inline-block;}
/* hours col */
.hcol{font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;}
.hok{color:#15803d;}.hover{color:#dc2626;}.hund{color:#d97706;}

/* PAID LEAVE */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
  gap:11px;margin-bottom:16px;}
.card{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:14px 16px;box-shadow:var(--sh);}
.card-t{font-size:9px;color:var(--mut);font-weight:700;text-transform:uppercase;
  letter-spacing:.3px;margin-bottom:2px;}
.card-v{font-size:26px;font-weight:900;font-family:'JetBrains Mono',monospace;line-height:1.1;}
.card-v small{font-size:12px;font-weight:400;color:var(--mut);}
.card-s{font-size:9px;color:#94a3b8;margin-top:2px;}
.ptwrap{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  overflow:hidden;box-shadow:var(--sh);}
.ptbl{width:100%;border-collapse:collapse;font-size:12px;}
.ptbl th{background:#f7f9fc;padding:8px 13px;text-align:left;font-size:9px;
  font-weight:800;color:var(--mut);border-bottom:2px solid var(--bdr);
  text-transform:uppercase;letter-spacing:.3px;}
.ptbl td{padding:10px 13px;border-bottom:1px solid #f1f5f9;color:#334155;}
.ptbl tr:last-child td{border-bottom:none;}
.ptbl tr:hover td{background:#f8fafc;}
.rb2{display:inline-block;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:800;}
.rbar-w{display:flex;align-items:center;gap:6px;}
.rbar{flex:1;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden;}
.rbar-f{height:100%;border-radius:3px;transition:width .4s;}
.lo{background:linear-gradient(90deg,#10b981,#34d399);}
.md{background:linear-gradient(90deg,#f59e0b,#fbbf24);}
.hi{background:linear-gradient(90deg,#ef4444,#f97316);}
.lnum{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;}
.pa{padding:3px 8px;border-radius:5px;border:none;cursor:pointer;font-size:10px;
  font-family:'Noto Sans JP',sans-serif;font-weight:700;}
.pa:hover{opacity:.75;}
.pa.g{background:#dcfce7;color:#15803d;}
.pa.r{background:#fee2e2;color:#b91c1c;}

/* 変形労働 */
.fwrap{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:16px 18px;margin-bottom:16px;box-shadow:var(--sh);}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;}
.fcard{background:var(--bg);border-radius:8px;padding:12px 14px;}
.fcard .fn{font-size:11px;font-weight:800;color:var(--txt);margin-bottom:2px;}
.fcard .fr{display:inline-block;padding:1px 6px;border-radius:7px;
  font-size:8px;font-weight:800;margin-bottom:7px;}
.fst{display:flex;gap:11px;margin-bottom:6px;}
.fs{text-align:center;}
.fs .v{font-size:16px;font-weight:900;font-family:'JetBrains Mono',monospace;line-height:1;}
.fs .l{font-size:8px;color:var(--mut);font-weight:600;margin-top:1px;}
.fbar{height:5px;background:#e2e8f0;border-radius:3px;overflow:hidden;margin-top:6px;}
.fbar-f{height:100%;border-radius:3px;transition:width .4s;}
.fok{background:linear-gradient(90deg,#10b981,#34d399);}
.fover{background:linear-gradient(90deg,#ef4444,#f97316);}
.fund{background:linear-gradient(90deg,#f59e0b,#fbbf24);}

/* KYOSEI ROTATION */
.krot-wrap{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:16px 18px;box-shadow:var(--sh);}
.krot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:9px;margin-top:12px;}
.krot-card{background:var(--bg);border-radius:8px;padding:11px 13px;
  display:flex;align-items:center;gap:10px;cursor:grab;}
.krot-card:hover{background:#e2e8f0;}
.krot-num{width:24px;height:24px;border-radius:50%;background:#0f4c8a;color:#fff;
  display:flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:800;font-family:'JetBrains Mono',monospace;flex-shrink:0;}
.krot-info .n{font-size:12px;font-weight:700;color:var(--txt);}
.krot-info .r{font-size:9px;color:var(--mut);}
.krot-add{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap;}
.krot-sel{padding:6px 10px;border:1.5px solid var(--bdr);border-radius:7px;
  font-size:12px;font-family:'Noto Sans JP',sans-serif;background:#fff;outline:none;}
.krot-sel:focus{border-color:var(--ac);}

/* WISH */
.wcal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
.wdh{text-align:center;font-size:9px;font-weight:800;padding:5px;color:var(--mut);}
.wdh.sun{color:#ef4444;}.wdh.sat{color:#3b82f6;}.wdh.k{color:#065f46;}
.wdc{background:var(--bg);border:1.5px solid var(--bdr);border-radius:7px;
  padding:4px 3px;text-align:center;cursor:pointer;transition:all .15s;min-height:52px;}
.wdc.emp{background:transparent;border-color:transparent;cursor:default;}
.wdc.kd{background:#f0fdfa;border-color:#6ee7b7;}
.wdc:not(.emp):hover{border-color:#94a3b8;background:#fff;}
.wdn{font-size:10px;font-weight:700;color:var(--txt);margin-bottom:2px;}
.wdn.sun{color:#ef4444;}.wdn.sat{color:#3b82f6;}.wdn.hol{color:#d97706;}
.wtag{font-size:8px;font-weight:800;padding:1px 4px;border-radius:3px;display:inline-block;}

/* STAFF */
.sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:11px;}
.scard{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:13px 15px;box-shadow:var(--sh);}
.st{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:9px;}
.snm{font-size:12px;font-weight:800;}
.srl{display:inline-block;padding:2px 6px;border-radius:10px;font-size:8px;font-weight:800;margin-top:2px;}
.sst{display:flex;gap:12px;margin-bottom:9px;}
.si{text-align:center;}
.si .v{font-size:15px;font-weight:900;font-family:'JetBrains Mono',monospace;}
.si .l{font-size:8px;color:var(--mut);font-weight:600;}
.sact{display:flex;gap:4px;flex-wrap:wrap;}
.sb{padding:3px 8px;border-radius:5px;border:1.5px solid var(--bdr);cursor:pointer;
  font-size:9px;font-family:'Noto Sans JP',sans-serif;font-weight:700;
  background:var(--bg);color:var(--mut);transition:all .15s;}
.sb:hover{background:#fff;border-color:#94a3b8;color:var(--txt);}
.sb.del{border-color:#fecaca;color:#ef4444;background:#fef2f2;}
.aform{background:var(--surf);border:1.5px solid var(--bdr);border-radius:var(--r);
  padding:14px;margin-bottom:14px;}
.afr{display:flex;gap:7px;flex-wrap:wrap;align-items:flex-end;}
.aff{flex:1;min-width:90px;}
.aff label{display:block;font-size:8px;font-weight:800;color:var(--mut);
  margin-bottom:3px;text-transform:uppercase;}
.aff input,.aff select{width:100%;padding:7px 9px;border:1.5px solid var(--bdr);
  border-radius:6px;font-size:12px;font-family:'Noto Sans JP',sans-serif;
  outline:none;background:#fff;}
.aff input:focus,.aff select:focus{border-color:var(--ac);}
.svbtn{padding:7px 14px;background:var(--ac);border:none;border-radius:6px;
  color:#fff;font-size:12px;font-weight:700;cursor:pointer;
  font-family:'Noto Sans JP',sans-serif;white-space:nowrap;}

/* MODAL */
.ov{position:fixed;inset:0;background:rgba(0,0,0,.42);
  display:flex;align-items:center;justify-content:center;z-index:1000;padding:14px;overflow-y:auto;}
.modal{background:#fff;border-radius:15px;padding:22px;
  width:100%;max-width:360px;box-shadow:0 18px 50px rgba(0,0,0,.18);
  max-height:90vh;overflow-y:auto;}
.modal h3{font-size:13px;font-weight:900;color:var(--txt);margin-bottom:3px;}
.modal p{font-size:11px;color:var(--mut);margin-bottom:14px;}
.mbtns{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.mbtn{padding:10px 6px;border-radius:8px;border:2px solid;cursor:pointer;
  font-size:10px;font-weight:800;font-family:'Noto Sans JP',sans-serif;
  text-align:center;background:#fff;transition:all .15s;}
.mbtn:hover{transform:translateY(-1px);}
.mbtn small{display:block;font-size:8px;font-weight:400;margin-top:1px;opacity:.75;}
.mcan{width:100%;margin-top:7px;padding:7px;background:var(--bg);border:none;
  border-radius:6px;cursor:pointer;font-size:10px;
  font-family:'Noto Sans JP',sans-serif;color:var(--mut);}
.mclr{width:100%;margin-top:4px;padding:7px;background:#fef2f2;
  border:1px solid #fecaca;border-radius:6px;cursor:pointer;
  font-size:10px;font-family:'Noto Sans JP',sans-serif;color:#b91c1c;font-weight:700;}

/* TOAST */
.toast{position:fixed;bottom:20px;right:20px;background:#0c1a2e;color:#fff;
  padding:10px 16px;border-radius:8px;font-size:12px;font-weight:600;
  z-index:3000;box-shadow:0 6px 24px rgba(0,0,0,.2);animation:su .3s ease;}
@keyframes su{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}

.sdiv{font-size:10px;font-weight:800;color:var(--mut);margin-bottom:9px;
  padding-bottom:6px;border-bottom:2px solid #f1f5f9;
  text-transform:uppercase;letter-spacing:.4px;}

@media print{
  .hdr,.cp,.ph>*:not(.ptitle),.legend,.kinfo{display:none!important;}
  .twrap{box-shadow:none;}body{background:#fff;}
}
@media (max-width:640px){
  .main{padding:12px 8px;padding-bottom:80px;}
  .hnav{display:none;}
  .hlogo{font-size:12px;}
  .hr .hbadge,.hr span{display:none;}
  .ptitle{font-size:14px;}
  .cp{padding:12px 10px;}
  .cpg{grid-template-columns:1fr 1fr;}
  .fgrid{grid-template-columns:1fr 1fr;}
  .sgrid{grid-template-columns:1fr;}
  .cards{grid-template-columns:1fr 1fr;}
  .krot-grid{grid-template-columns:1fr;}
  .lcard{padding:28px 18px;margin:12px;}
  .mob-nav{display:flex!important;}
}
.mob-nav{display:none;position:fixed;bottom:0;left:0;right:0;
  background:#0c1a2e;border-top:1px solid #1a3050;z-index:300;
  padding-bottom:env(safe-area-inset-bottom,0);}
.mob-nav button{flex:1;padding:8px 2px 6px;border:none;background:transparent;
  color:rgba(255,255,255,.4);font-size:9px;font-family:'Noto Sans JP',sans-serif;
  font-weight:600;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;gap:2px;transition:color .15s;}
.mob-nav button.on{color:#38bdf8;}
.mob-nav button span{font-size:20px;line-height:1;}

/* 定休曜日ピッカー */
.rdpick{position:relative;display:inline-block;}
.rdpop{position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);
  background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;
  box-shadow:0 8px 24px rgba(0,0,0,.13);z-index:200;padding:8px 10px;
  min-width:130px;white-space:nowrap;}
.rdpop::before{content:"";position:absolute;top:-7px;left:50%;transform:translateX(-50%);
  border:6px solid transparent;border-top:none;border-bottom-color:#e2e8f0;}
.rdpop::after{content:"";position:absolute;top:-5px;left:50%;transform:translateX(-50%);
  border:5px solid transparent;border-top:none;border-bottom-color:#fff;}
.rdpop-title{font-size:9px;font-weight:800;color:var(--mut);margin-bottom:6px;text-align:center;}
.rdpop-opts{display:flex;flex-direction:column;gap:4px;}
.rdpop-opt{padding:5px 10px;border-radius:6px;border:1.5px solid #e2e8f0;
  background:#f8fafc;color:#374151;font-size:11px;font-weight:700;
  cursor:pointer;text-align:center;font-family:inherit;transition:all .1s;}
.rdpop-opt:hover{background:#f0f9ff;border-color:#38bdf8;}
.rdpop-opt.sel{background:#0f4c8a;border-color:#0f4c8a;color:#fff;}
.rdpop-opt.sel-am{background:#0891b2;border-color:#0891b2;color:#fff;}
.rdpop-opt.sel-pm{background:#7c3aed;border-color:#7c3aed;color:#fff;}
.rdpop-opt.none{color:#94a3b8;}
.kot-wrap{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  padding:18px 20px;margin-bottom:14px;box-shadow:var(--sh);}
.kot-step{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;}
.kot-num{width:24px;height:24px;border-radius:50%;background:#0f4c8a;color:#fff;
  font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.kot-body{flex:1;}
.kot-body h4{font-size:12px;font-weight:800;color:var(--txt);margin-bottom:3px;}
.kot-body p{font-size:11px;color:var(--mut);line-height:1.6;}
.kot-body code{background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:10px;
  font-family:'JetBrains Mono',monospace;color:#0f4c8a;}
.drop-zone{border:2px dashed #cbd5e1;border-radius:10px;padding:28px;text-align:center;
  cursor:pointer;transition:all .2s;background:#f8fafc;margin-top:8px;}
.drop-zone:hover,.drop-zone.drag{border-color:#38bdf8;background:#f0f9ff;}
.drop-zone .dico{font-size:28px;margin-bottom:6px;}
.drop-zone p{font-size:12px;color:var(--mut);}
.drop-zone small{font-size:10px;color:#94a3b8;}
.kot-result{background:var(--surf);border-radius:var(--r);border:1px solid var(--bdr);
  overflow:hidden;box-shadow:var(--sh);}
.kot-tbl{width:100%;border-collapse:collapse;font-size:11px;}
.kot-tbl th{background:#0c1a2e;color:#fff;padding:8px 10px;font-size:9px;
  font-weight:800;text-align:left;white-space:nowrap;}
.kot-tbl td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}
.kot-tbl tr:hover td{background:#f8fafc;}
.diff-ok{color:#15803d;font-weight:700;font-family:'JetBrains Mono',monospace;}
.diff-late{color:#dc2626;font-weight:700;}
.diff-early{color:#d97706;font-weight:700;}
.diff-over{color:#7c3aed;font-weight:700;}
.diff-badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:9px;font-weight:800;margin:1px;}
.sum-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px;}
.sum-card{background:var(--surf);border-radius:10px;border:1px solid var(--bdr);
  padding:12px 14px;box-shadow:var(--sh);}
.sum-card .sv{font-size:22px;font-weight:900;font-family:'JetBrains Mono',monospace;line-height:1.1;}
.sum-card .sl{font-size:9px;color:var(--mut);font-weight:600;margin-top:2px;}
/* セミナー */
.sem-banner{background:linear-gradient(90deg,#fdf4ff,#fae8ff);border:1.5px solid #d8b4fe;
  border-radius:9px;padding:8px 12px;margin-bottom:8px;}
.sem-banner .sh{display:flex;align-items:center;gap:7px;}
.sem-banner .sn{font-weight:800;font-size:12px;color:#7e22ce;}
.sem-banner .st{font-size:10px;color:#9333ea;}
.sem-banner .sp{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;}
.sem-badge{background:#ede9fe;color:#6d28d9;font-size:9px;font-weight:700;
  padding:1px 6px;border-radius:10px;display:inline-block;}
.sem-dot{width:6px;height:6px;border-radius:50%;background:#a855f7;display:inline-block;vertical-align:middle;margin-left:2px;}
.sem-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;
  align-items:center;justify-content:center;z-index:300;}
.sem-modal{background:#fff;border-radius:14px;padding:22px 24px;max-width:500px;
  width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.2);max-height:90vh;overflow-y:auto;}
.sem-modal h3{font-size:14px;font-weight:800;margin-bottom:14px;color:#7e22ce;}
.sem-form{display:flex;flex-direction:column;gap:11px;}
.sem-form label{font-size:10px;font-weight:700;color:var(--mut);display:block;margin-bottom:3px;}
.sem-form input{width:100%;padding:7px 10px;border:1.5px solid #e2e8f0;
  border-radius:7px;font-size:12px;font-family:inherit;box-sizing:border-box;}
.sem-row{display:flex;gap:8px;}
.sem-row>div{flex:1;}
.sem-staff-grid{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;}
.sem-staff-btn{padding:4px 10px;border-radius:6px;border:1.5px solid #e2e8f0;
  background:#f8fafc;color:#374151;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .1s;}
.sem-staff-btn.on{background:#7e22ce;border-color:#7e22ce;color:#fff;}
.sem-item{background:#fdf4ff;border:1.5px solid #e9d5ff;border-radius:9px;
  padding:10px 12px;display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.sem-item .sb{flex:1;}
.sem-item .sn{font-weight:800;font-size:12px;color:#7e22ce;}
.sem-item .st{font-size:10px;color:#9333ea;margin-top:1px;}
`;


// ═══════════════════════════════════════════════════════
// SHIFT LABEL HELPER
// ═══════════════════════════════════════════════════════
function shiftLabel(key) {
  if(!key) return "";
  if(key==="矯正当番_土") return "矯土";
  if(key==="矯正当番_木") return "矯木";
  if(key==="土曜出勤")    return "土勤";
  if(key==="訪問")        return "訪問";
  if(key==="AM_MT")       return "AMセミ";
  if(key==="午前のみ")    return "午前";
  if(key==="午前半休")    return "午後出";
  if(key==="午後半休")    return "午前出";
  if(key==="17時まで")   return "17時";
  return key[0];
}

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════════════════
// ─── Supabase クライアント・データ層は db.js に移動済み ───

// ═══════════════════════════════════════════════════════
export default function App() {
  const today=new Date();
  const [user,    setUser]    = useState(null);
  const [tab,     setTab]     = useState("shift");
  const [year,    setYear]    = useState(today.getFullYear());
  const [month,   setMonth]   = useState(today.getMonth());
  const [staff,   setStaff,   staffSynced]  = useStaff(INIT_STAFF);
  // 月別シフト
  const [shifts,  setShifts,  shiftsSynced] = useShifts(year, month, false);
  // 翌月シフト（11〜10表示モード用）
  const nxtDispY = month===11?year+1:year;
  const nxtDispM = month===11?0:month+1;
  const [nxtShifts, setNxtShifts] = useShifts(year, month, true);
  const [wishes,  setWishes]  = useWishes(year, month);
  const settings = useSettings();
  const {minSt, setMinSt, wh, setWh, whSat, setWhSat, kyoseiTime, setKyoseiTime, calStart, setCalStart} = settings;
  const [toast,   setToast]   = useState(null);
  const [modal,   setModal]   = useState(null);
  const [wModal,  setWModal]  = useState(null);
  const [addSt,   setAddSt]   = useState(false);
  const [newSt,   setNewSt]   = useState({name:"",role:"Dh",leave:10,birthDate:"",joinYear:new Date().getFullYear(),employment:"正社員",weeklyDaysOff:2,restDays:[]});
  const [kotData, setKotData] = useState(null);
  const [kotDrag, setKotDrag] = useState(false);
  const [apptData, setApptData] = useState(null);
  const [apptDrag, setApptDrag] = useState(false);
  const [drExtra, setDrExtra] = useState({});// key: "chair_time" -> staffId
  const [rdPop,   setRdPop]   = useState(null);
  const [extraKyosei,   setExtraKyosei, deletedKyosei, setDeletedKyosei] = useKyoseiOverrides();
  const [clinicHolidays, setClinicHolidays] = useHolidays();
  const [seminars, setSeminars] = useSeminars();
  const [semModal, setSemModal] = useState(null);
  const [visits, setVisits] = useVisits();
  const [visitModal, setVisitModal] = useState(null);
  const [meetings, setMeetings] = useMeetings();
  const [mtgModal, setMtgModal] = useState(null);
  const [idModal, setIdModal] = useState(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [ctxMenu, setCtxMenu] = useState(null); // {staffId, x, y}

  useEffect(()=>{
    const unsub = onSaveChange((n)=>setPendingSaves(n));
    return unsub;
  },[]); // staffId for ID/PIN setting modal

  // 月移動後にshiftsが空なら自動生成
  useEffect(()=>{
    if(!staffSynced) return;
    if(staff.filter(s=>s.active).length===0) return;
    if(shifts && Object.keys(shifts).length > 0) return; // データあり
    handleAuto();
  },[year, month, staffSynced]);

  // ポップアップ外クリックで閉じる
  useEffect(()=>{
    if(!rdPop) return;
    const close=()=>setRdPop(null);
    document.addEventListener("click", close);
    return ()=>document.removeEventListener("click", close);
  },[rdPop]);

  const D=dim(year,month);
  const dH=useMemo(()=>dailyH(wh),[wh]);
  const satDH=useMemo(()=>dailyH(whSat),[whSat]);
  const stdH=useMemo(()=>monthlyStd(year,month),[year,month]);

  function toast_(msg){ setToast(msg); setTimeout(()=>setToast(null),2500); }

  // 医院休診日チェック（祝日 or 医院独自休診）
  function isClinicHoliday(y,m,d){
    if(isHoliday(y,m,d)) return true;
    const key=`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    return clinicHolidays.some(h=>h.date===key);
  }
  function clinicHolidayLabel(y,m,d){
    const key=`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const ch=clinicHolidays.find(h=>h.date===key);
    return ch?.label||null;
  }

  // 矯正日一覧 (this month) - カスタム追加・削除を反映
  const kyoseiDays=useMemo(()=>{
    const map={};
    for(let d=1;d<=D;d++){
      const key=`${year}-${month}-${d}`;
      if(deletedKyosei.includes(key)) continue; // 削除済みはスキップ
      const ki=kyoseiInfo(year,month,d);
      if(ki) map[d]=ki;
    }
    // 追加分
    extraKyosei.filter(k=>k.year===year&&k.month===month).forEach(k=>{
      map[k.day]={type:k.type, label:k.label};
    });
    return map;
  },[year,month,D,extraKyosei,deletedKyosei]);

  function applyShift(sid, day, type, y=year, m=month){
    // 月別ストレージ: 当月ならshifts, 翌月ならnxtShifts
    const key=`${sid}_${day}`;
    const isNxt=(y===nxtDispY&&m===nxtDispM);
    const setter=isNxt?setNxtShifts:setShifts;
    setter(prev=>{
      const next={...prev};
      const cur=prev[key];
      if(cur==="有給"&&type!=="有給")
        setStaff(ps=>ps.map(s=>s.id===sid?{...s,used:Math.max(0,s.used-1)}:s));
      if(type===null) delete next[key];
      else next[key]=type;
      return next;
    });
    if(type==="有給"&&(isNxt?nxtShifts:shifts)[key]!=="有給")
      setStaff(ps=>ps.map(s=>s.id===sid?{...s,used:Math.min(s.leave,s.used+1)}:s));
    setModal(null);
    toast_("シフトを更新しました");
  }

  function handleAuto(){
    const activeStaff=staff.filter(s=>s.active);
    if(activeStaff.length===0) return;

    // 矯正日
    const targetKyoseiDays={...kyoseiDays};
    for(let d=1;d<=D;d++){
      const ki=kyoseiInfo(year,month,d);
      if(ki) targetKyoseiDays[d]=ki;
    }

    // 矯正日の手動設定を保持
    const kyoseiAssignedManual={};
    const kyoseiRestManual={};
    Object.keys(targetKyoseiDays).forEach(ds=>{
      const d=Number(ds);
      activeStaff.forEach(s=>{
        const sh=shifts[`${s.id}_${d}`];
        if(sh==="矯正当番_土"||sh==="矯正当番_木") kyoseiAssignedManual[d]=s.id;
        else if(sh==="休み"){
          if(!kyoseiRestManual[s.id]) kyoseiRestManual[s.id]=new Set();
          kyoseiRestManual[s.id].add(d);
        }
      });
    });

    // 当月シフト生成
    const newShifts=autoSchedule(year,month,activeStaff,minSt,kyoseiAssignedManual,kyoseiRestManual,targetKyoseiDays);

    // 翌月1〜10日も生成（11〜10表示用）
    const nxtKD={};
    for(let d=1;d<=10;d++){ const ki=kyoseiInfo(nxtDispY,nxtDispM,d); if(ki) nxtKD[d]=ki; }
    const nxtNew=autoSchedule(nxtDispY,nxtDispM,activeStaff,minSt,{},{},nxtKD);
    const nxtOnly={};
    activeStaff.forEach(s=>{
      for(let d=1;d<=10;d++) if(nxtNew[`${s.id}_${d}`]) nxtOnly[`${s.id}_${d}`]=nxtNew[`${s.id}_${d}`];
    });

    setShifts(newShifts);
    setNxtShifts(nxtOnly);
    toast_("✨ シフトを自動作成しました");
  }

  // 月移動：未入力の月は自動生成
  function changeMonth(newYear, newMonth){
    setYear(newYear);
    setMonth(newMonth);
  }

  // 日別・役職別 出勤数（セミナー参加者を除外）
  const dayCounts=useMemo(()=>{
    const map={};
    for(let d=1;d<=D;d++){
      // この日のセミナー参加者IDセット
      const semStaff=new Set(
        seminars.filter(sm=>{
          const sd=new Date(sm.date);
          return sd.getFullYear()===year&&sd.getMonth()===month&&sd.getDate()===d;
        }).flatMap(sm=>sm.staffIds)
      );
      map[d]={};
      Object.keys(ROLES).forEach(role=>{
        map[d][role]=staff.filter(s=>s.role===role&&s.active&&!semStaff.has(s.id)).filter(s=>{
          const sh=shifts[`${s.id}_${d}`];
          return sh&&sh!=="休み"&&sh!=="有給";
        }).length;
      });
    }
    return map;
  },[shifts,staff,D,seminars,year,month]);

  // スタッフ別 月間労働時間
  const staffH=useMemo(()=>{
    const map={};
    staff.forEach(s=>{
      let h=0;
      for(let d=1;d<=D;d++){
        const sh=shifts[`${s.id}_${d}`];
        if(sh&&SHIFT_TYPES[sh]) h+=SHIFT_TYPES[sh].hours;
      }
      map[s.id]=Math.round(h*10)/10;
    });
    return map;
  },[shifts,staff,D]);

  // アラート
  const alerts=useMemo(()=>{
    const res=[];
    for(let d=1;d<=D;d++){
      const dow=new Date(year,month,d).getDay();
      if(dow===0||isClinicHoliday(year,month,d)) continue;
      Object.keys(ROLES).forEach(role=>{
        const req=minSt[role]||0;
        const cnt=dayCounts[d]?.[role]||0;
        if(cnt<req) res.push({day:d,role,req,cnt});
      });
    }
    return res;
  },[dayCounts,minSt,D,year,month]);

  const overAlerts=useMemo(()=>
    staff.filter(s=>s.active&&staffH[s.id]>stdH+0.5),
  [staffH,stdH,staff]);

  if(!user) return <LoginScreen onLogin={setUser} staff={staff}/>;
  const isA=user.role==="admin";
  const mySt=!isA?staff.find(s=>s.id===user.staffId):null;

  // ── SHIFT TAB ──────────────────────────────
  const ShiftTab=()=>{
    // 11始まり対応: 11〜末日 + 翌月(前月)1〜10 の順で日付リストを生成
    const days=(()=>{
      if(calStart===1) return Array.from({length:D},(_,i)=>i+1);
      // 11日始まり: 当月11〜末日, 翌月1〜10
      const arr=[];
      for(let d=11;d<=D;d++) arr.push({y:year,m:month,d});
      const ny=month===11?year+1:year;
      const nm=month===11?0:month+1;
      const nd=dim(ny,nm);
      for(let d=1;d<=10&&d<=nd;d++) arr.push({y:ny,m:nm,d});
      return arr;
    })();
    // 後方互換: calStart===1のときはdがnumber、11のときはオブジェクト
    const dayObj=(d)=>typeof d==="object"?d:{y:year,m:month,d};
    const active=staff.filter(s=>s.active);
    const tStaff=isA?active:[mySt].filter(Boolean);
    const byRole={};
    Object.keys(ROLES).forEach(r=>{byRole[r]=tStaff.filter(s=>s.role===r);});

    return (
      <div>
        <div className="ph">
          <div className="ptitle">シフト表 <small>{calStart===11?`${year}年${month+1}月11日〜${month===11?year+1:year}年${month===11?1:month+2}月10日`:`${year}年${month+1}月`}</small></div>
          <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
            <div className="mnav">
              <button onClick={()=>changeMonth(month===0?year-1:year, month===0?11:month-1)}>‹</button>
              <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
              <button onClick={()=>changeMonth(month===11?year+1:year, month===11?0:month+1)}>›</button>
            </div>
            {/* 今月ボタン */}
            {(year!==today.getFullYear()||month!==today.getMonth())&&(
              <button className="pbtn" style={{background:"#f0fdf4",color:"#16a34a",border:"1px solid #86efac",fontWeight:800}}
                onClick={()=>changeMonth(today.getFullYear(),today.getMonth())}>
                今月
              </button>
            )}
            {isA&&<button className="pbtn" style={{background:"#7e22ce",color:"#fff"}} onClick={()=>setSemModal("add")}>🎓 セミナー追加</button>}
            {isA&&<button className="pbtn" style={{background:"#0d9488",color:"#fff"}} onClick={()=>setMtgModal("add")}>🏥 ミーティング追加</button>}
            {isA&&<button className="pbtn" style={{background:"#0369a1",color:"#fff"}} onClick={()=>setVisitModal("add")}>🏠 訪問追加</button>}
            {isA&&<button className="pbtn" style={{background:calStart===11?"#f59e0b":"#e2e8f0",color:calStart===11?"#fff":"#374151"}}
              onClick={()=>setCalStart(c=>c===1?11:1)}>
              {calStart===11?"📅 11〜10日表示中":"📅 1〜末日表示中"}
            </button>}
            {isA&&<button className="pbtn" onClick={()=>window.print()}>🖨 印刷</button>}
          </div>
        </div>

        {/* セミナーカード（今月分） */}
        {(()=>{
          const semItems=seminars.filter(sm=>{const sd=new Date(sm.date);return sd.getFullYear()===year&&sd.getMonth()===month;}).sort((a,b)=>new Date(a.date)-new Date(b.date));
          if(semItems.length===0) return null;
          return semItems.map(item=>{
            const d=new Date(item.date).getDate();
            const dow=DAYS_JP[new Date(item.date).getDay()];
            const participants=staff.filter(s=>item.staffIds.includes(s.id));
            return (
              <div key={item.id} style={{background:"#faf5ff",border:"1.5px solid #d8b4fe",borderRadius:10,
                padding:"8px 12px",marginBottom:6,display:"flex",flexDirection:"column",gap:4}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontSize:13}}>🎓</span>
                  <span style={{fontWeight:800,fontSize:11,color:"#9333ea"}}>{item.name}</span>
                  <span style={{fontSize:10,color:"#64748b",marginLeft:4}}>{month+1}/{d}（{dow}）{item.start}〜{item.end}</span>
                  {isA&&(
                    <span style={{marginLeft:"auto",display:"flex",gap:4}}>
                      <button style={{fontSize:8,padding:"1px 6px",borderRadius:4,border:"1px solid #d8b4fe",background:"#fff",color:"#9333ea",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                        onClick={()=>setSemModal(item.id)}>編集</button>
                      <button style={{fontSize:8,padding:"1px 6px",borderRadius:4,border:"1px solid #fca5a5",background:"#fff",color:"#dc2626",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                        onClick={()=>{if(window.confirm("削除しますか？")){setSeminars(ps=>ps.filter(x=>x.id!==item.id));}}}>削除</button>
                    </span>
                  )}
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:3,alignItems:"center"}}>
                  <span style={{fontSize:9,color:"#9333ea",fontWeight:700}}>参加：</span>
                  {participants.map(s=>(
                    <span key={s.id} style={{fontSize:9,background:"#fff",border:"1px solid #d8b4fe",
                      color:"#9333ea",borderRadius:10,padding:"1px 6px",fontWeight:600}}>{s.name}</span>
                  ))}
                </div>
              </div>
            );
          });
        })()}

        {/* ミーティングカード（今月分） */}
        {(()=>{
          const mtgItems=meetings.filter(mt=>{const md=new Date(mt.date);return md.getFullYear()===year&&md.getMonth()===month;}).sort((a,b)=>new Date(a.date)-new Date(b.date));
          if(mtgItems.length===0) return null;
          return mtgItems.map(item=>{
            const d=new Date(item.date).getDate();
            const dow=DAYS_JP[new Date(item.date).getDay()];
            const participants=staff.filter(s=>item.staffIds.includes(s.id));
            return (
              <div key={item.id} style={{background:"#f0fdfa",border:"1.5px solid #5eead4",borderRadius:10,
                padding:"8px 12px",marginBottom:6,display:"flex",flexDirection:"column",gap:4}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontSize:13}}>🏥</span>
                  <span style={{fontWeight:800,fontSize:11,color:"#0d9488"}}>{item.name}</span>
                  <span style={{fontSize:10,color:"#64748b",marginLeft:4}}>{month+1}/{d}（{dow}）{item.start}〜{item.end}</span>
                  {isA&&(
                    <span style={{marginLeft:"auto",display:"flex",gap:4}}>
                      <button style={{fontSize:8,padding:"1px 6px",borderRadius:4,border:"1px solid #5eead4",background:"#fff",color:"#0d9488",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                        onClick={()=>setMtgModal(item.id)}>編集</button>
                      <button style={{fontSize:8,padding:"1px 6px",borderRadius:4,border:"1px solid #fca5a5",background:"#fff",color:"#dc2626",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                        onClick={()=>{if(window.confirm("削除しますか？")){setMeetings(ps=>ps.filter(x=>x.id!==item.id));}}}>削除</button>
                    </span>
                  )}
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:3,alignItems:"center"}}>
                  <span style={{fontSize:9,color:"#0d9488",fontWeight:700}}>参加：</span>
                  {participants.map(s=>(
                    <span key={s.id} style={{fontSize:9,background:"#fff",border:"1px solid #5eead4",
                      color:"#0d9488",borderRadius:10,padding:"1px 6px",fontWeight:600}}>{s.name}</span>
                  ))}
                </div>
              </div>
            );
          });
        })()}

        {/* 📋 欄外特記：矯正・セミナー・訪問サマリー */}
        {(()=>{
          const monthKyosei=Object.entries(kyoseiDays).map(([d,ki])=>({day:Number(d),dow:new Date(year,month,Number(d)).getDay(),...ki})).sort((a,b)=>a.day-b.day);
          const monthSeminars=seminars.filter(sm=>{
            const sd=new Date(sm.date);
            return sd.getFullYear()===year&&sd.getMonth()===month;
          }).sort((a,b)=>new Date(a.date)-new Date(b.date));
          const monthVisits=visits.filter(v=>{
            const vd=new Date(v.date);
            return vd.getFullYear()===year&&vd.getMonth()===month;
          }).sort((a,b)=>new Date(a.date)-new Date(b.date));

          if(monthKyosei.length===0&&monthSeminars.length===0&&monthVisits.length===0) return null;

          return (
            <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,
              padding:"10px 14px",marginBottom:10,fontSize:11}}>
              <div style={{fontWeight:800,fontSize:11,color:"var(--txt)",marginBottom:8}}>
                📋 {year}年{month+1}月 特記事項
              </div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                {monthKyosei.length>0&&(
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#0f766e",marginBottom:4}}>🦷 矯正日</div>
                    {monthKyosei.map(k=>(
                      <div key={k.day} style={{marginBottom:2,color:"#115e59"}}>
                        {month+1}/{k.day}（{DAYS_JP[k.dow]}）{k.label}
                      </div>
                    ))}
                  </div>
                )}
                {monthSeminars.length>0&&(
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#7e22ce",marginBottom:4}}>🎓 セミナー</div>
                    {monthSeminars.map(sm=>{
                      const d=new Date(sm.date).getDate();
                      const dow=DAYS_JP[new Date(sm.date).getDay()];
                      const names=staff.filter(s=>sm.staffIds.includes(s.id)).map(s=>s.name).join("・");
                      return (
                        <div key={sm.id} style={{marginBottom:2,color:"#6d28d9"}}>
                          {month+1}/{d}（{dow}）{sm.name} {sm.start}〜{sm.end}
                          {names&&<span style={{marginLeft:4,fontSize:10,color:"#9333ea"}}>[{names}]</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {monthVisits.length>0&&(
                  <div>
                    <div style={{fontSize:9,fontWeight:800,color:"#0369a1",marginBottom:4}}>🏠 訪問</div>
                    {monthVisits.map(v=>{
                      const d=new Date(v.date).getDate();
                      const dow=DAYS_JP[new Date(v.date).getDay()];
                      const names=staff.filter(s=>v.staffIds.includes(s.id)).map(s=>s.name).join("・");
                      return (
                        <div key={v.id} style={{marginBottom:2,color:"#0369a1"}}>
                          {month+1}/{d}（{dow}）{v.name||"訪問"} {v.start}〜{v.end}
                          {names&&<span style={{marginLeft:4,fontSize:10}}>[{names}]</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* アラート */}
        {isA&&alerts.length>0&&(
          <div className="alertbar">
            <span style={{fontSize:16}}>⚠️</span>
            <div>
              <div style={{fontWeight:800,marginBottom:4,fontSize:11}}>人員不足 {alerts.length}件</div>
              <ul className="alist">
                {alerts.slice(0,20).map((a,i)=>(
                  <li key={i}>{month+1}/{a.day}({DAYS_JP[new Date(year,month,a.day).getDay()]}) {ROLES[a.role].label} {a.cnt}/{a.req}人</li>
                ))}
                {alerts.length>20&&<li>+{alerts.length-20}件</li>}
              </ul>
            </div>
          </div>
        )}
        {/* 凡例 */}
        <div className="legend">
          {Object.entries(SHIFT_TYPES).map(([k,v])=>(
            <div className="leg" key={k}>
              <div className="ld" style={{background:v.bg,color:v.color}}>{shiftLabel(k)}</div>
              <span>{v.label}{v.hours>0?` (${v.hours}h)`:""}</span>
            </div>
          ))}
        </div>

        {/* テーブル */}
        <div className="twrap">
          <table className="stbl">
            <thead>
              <tr>
                <th className="sc">スタッフ</th>
                {days.map((day,idx)=>{
                  const {y,m,d}=dayObj(day);
                  const dow=new Date(y,m,d).getDay();
                  const hol=isClinicHoliday(y,m,d);
                  const holLabel=clinicHolidayLabel(y,m,d);
                  const ki=kyoseiDays[d];
                  const kiValid=ki&&m===month; // 矯正日は当月のみ
                  const isTd=d===today.getDate()&&m===today.getMonth()&&y===today.getFullYear();
                  const isNewMonth=calStart===11&&d===1; // 翌月に切り替わる境目
                  let cls="";
                  if(hol||dow===0) cls="th-hol";
                  else if(kiValid?.type==="土") cls="th-k2sat";
                  else if(kiValid?.type==="木") cls="th-k4thu";
                  else if(dow===6) cls="th-sat";
                  return (
                    <th key={`${y}-${m}-${d}`} className={cls}
                      style={isNewMonth?{borderLeft:"2px solid #f59e0b"}:{}}>
                      {isNewMonth&&<div style={{fontSize:6,color:"#d97706",fontWeight:800,lineHeight:1}}>{y}/{m+1}月→</div>}
                      <span className={isTd?"today-mark":""}>{d}</span>
                      <div style={{fontSize:8,fontWeight:500}}>{DAYS_JP[dow]}</div>
                      {holLabel?<div style={{fontSize:7,color:"#b45309",fontWeight:800}} title={holLabel}>休</div>
                       :hol&&<div style={{fontSize:7,color:"#b45309",fontWeight:800}}>祝</div>}
                      {kiValid&&!hol&&<span className="k-mark">矯正</span>}
                      {kiValid&&!hol&&<span className="k-sub">{ki.label}</span>}
                    </th>
                  );
                })}
                {isA&&<th style={{minWidth:36}}>月h</th>}
              </tr>
            </thead>
            <tbody>
              {Object.entries(ROLES).map(([role,rv])=>{
                const rs=byRole[role];
                if(!rs||rs.length===0) return null;
                return [
                  <tr key={`rh_${role}`} className="rhr">
                    <td className="sc" style={{background:rv.bg,color:rv.color,fontWeight:800,fontSize:9,whiteSpace:"nowrap"}}>
                      {rv.label}（{rv.short}）
                    </td>
                    {days.map((day,idx)=>{
                      const {y,m,d}=dayObj(day);
                      const dow=new Date(y,m,d).getDay();
                      const hol=isClinicHoliday(y,m,d);
                      const ki=kyoseiDays[d];
                      const kiValid=ki&&m===month;
                      const isNewMonth=calStart===11&&d===1;
                      let cls="";
                      if(hol||dow===0) cls="td-hol";
                      else if(kiValid) cls="td-k";
                      else if(dow===6) cls="td-sat";
                      const isSunOrHol = hol || dow === 0;
                      const isRed = dow === 0 || hol;
                      const isSat = dow === 6;
                      return (
                        <td key={`${y}-${m}-${d}`} className={cls}
                          style={{...(isNewMonth?{borderLeft:"2px solid #f59e0b"}:{})}}
                          ref={el=>{if(el)el.style.setProperty("background",
                            isSunOrHol?"#fff5f5":isSat?"#eff6ff":"#ffffff","important")}}>
                          <div style={{fontSize:11,fontWeight:800,lineHeight:1.2,
                            color:isRed?"#dc2626":isSat?"#2563eb":"#111827"}}>{d}</div>
                          <div style={{fontSize:8,fontWeight:600,lineHeight:1,
                            color:isRed?"#ef4444":isSat?"#60a5fa":"#6b7280"}}>{DAYS_JP[dow]}</div>
                        </td>
                      );
                    })}
                    {isA&&<td style={{background:rv.bg+"33"}}/>}
                  </tr>,
                  ...rs.map(s=>(
                    <tr key={s.id}>
                      <td className="sn"
                        onContextMenu={e=>{e.preventDefault();setCtxMenu({staffId:s.id,staffName:s.name,x:e.clientX,y:e.clientY});}}>
                        <div className="nm">{s.name}</div>
                        <span className="rb" style={{background:rv.bg,color:rv.color}}>{rv.short}</span>
                      </td>
                      {days.map((day)=>{
                        const {y,m,d}=dayObj(day);
                        const dow=new Date(y,m,d).getDay();
                        const hol=isClinicHoliday(y,m,d);
                        const ki=m===month?kyoseiDays[d]:null;
                        const isOff = hol || dow === 0; // 日曜・祝日
                        const sh = isOff ? null : ((y===year&&m===month)?shifts[`${s.id}_${d}`]:nxtShifts[`${s.id}_${d}`]);
                        const ws = isOff ? null : wishes[`${s.id}_${d}`];
                        const st=SHIFT_TYPES[sh];
                        const inSeminar=!isOff&&seminars.some(sm=>{
                          const sd=new Date(sm.date);
                          return sd.getFullYear()===y&&sd.getMonth()===m&&sd.getDate()===d&&sm.staffIds.includes(s.id);
                        });
                        const inVisit=!isOff&&visits.some(v=>{
                          const vd=new Date(v.date);
                          return vd.getFullYear()===y&&vd.getMonth()===m&&vd.getDate()===d&&v.staffIds.includes(s.id);
                        });
                        const isNewMonth=calStart===11&&d===1;
                        let tdCls="";
                        if(isOff) tdCls="td-hol";
                        else if(ki) tdCls="td-k";
                        else if(dow===6) tdCls="td-sat";
                        return (
                          <td key={`${y}-${m}-${d}`} className={tdCls}
                            style={{...(inSeminar?{outline:"2px solid #d8b4fe",outlineOffset:"-2px",background:"#fdf4ff"}:{}),
                              ...(inVisit&&!inSeminar?{outline:"2px solid #7dd3fc",outlineOffset:"-2px",background:"#f0f9ff"}:{}),
                              ...(isNewMonth?{borderLeft:"2px solid #f59e0b"}:{})}}>
                            {isOff ? (
                              inSeminar ? <span className="sem-dot" style={{display:"block",margin:"auto"}}/> :
                              inVisit ? <span style={{display:"block",width:6,height:6,borderRadius:"50%",background:"#0369a1",margin:"auto"}}/> : null
                            ) : sh?(
                              <button className="scl"
                                style={{background:st?.bg||"#f3f4f6",color:st?.color||"#9ca3af"}}
                                onClick={()=>isA&&setModal({staffId:s.id,day:d,month:m,year:y,staffName:s.name})}
                                title={`${s.name} ${m+1}/${d} ${sh}${inSeminar?" 🎓セミナー参加":""}${inVisit?" 🏠訪問":""}${ws?` (希望:${ws})`:""}`}>
                                {shiftLabel(sh)}{inSeminar&&<span className="sem-dot"/>}{inVisit&&!inSeminar&&<span style={{display:"inline-block",width:5,height:5,borderRadius:"50%",background:"#0369a1",marginLeft:1,verticalAlign:"middle"}}/>}
                              </button>
                            ):(
                              <div className="scl-e"
                                onClick={()=>isA&&setModal({staffId:s.id,day:d,month:m,year:y,staffName:s.name})}
                                style={ws?{borderColor:SHIFT_TYPES[ws]?.color,
                                  background:(SHIFT_TYPES[ws]?.bg||"")+"55"}:{}}
                              />
                            )}
                          </td>
                        );
                      })}
                      {isA&&(
                        <td>
                          <span className={`hcol ${staffH[s.id]>stdH+0.5?"hover":staffH[s.id]<stdH-dH*2?"hund":"hok"}`}>
                            {staffH[s.id]}
                          </span>
                        </td>
                      )}
                    </tr>
                  )),
                  isA&&(
                    <tr key={`cnt_${role}`} className="crow">
                      <td className="sn" style={{color:rv.color,fontWeight:800}}>人数({rv.short})</td>
                      {days.map((day)=>{
                        const {y,m,d}=dayObj(day);
                        const dow=new Date(y,m,d).getDay();
                        const hol=isClinicHoliday(y,m,d);
                        const isNewMonth=calStart===11&&d===1;
                        if(dow===0||hol) return <td key={`${y}-${m}-${d}`} style={isNewMonth?{borderLeft:"2px solid #f59e0b"}:{}}/>;
                        const cnt=dayCounts[d]?.[role]||0;
                        const req=minSt[role]||0;
                        return <td key={`${y}-${m}-${d}`} style={isNewMonth?{borderLeft:"2px solid #f59e0b"}:{}}><span className={cnt>=req?"cok":"cng"}>{cnt}</span></td>;
                      })}
                      {isA&&<td/>}
                    </tr>
                  )
                ].filter(Boolean);
              })}
            </tbody>
          </table>
        </div>
        {/* コントロール */}
        {isA&&(
          <div className="cp">
            <div className="cpt">⚙️ シフト設定</div>
            <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-start"}}>
              <div className="cpg" style={{flex:2,minWidth:260}}>
                {Object.entries(ROLES).filter(([role])=>role!=="技工士"&&role!=="TC").map(([role,rv])=>(
                  <div className="cpi" key={role}>
                    <label><span style={{background:rv.bg,color:rv.color,padding:"1px 4px",borderRadius:3,fontSize:7,fontWeight:800,marginRight:3}}>{role}</span>最低人数</label>
                    <div className="cpr"><span>出勤</span>
                      <input type="number" min="0" max="10" className="ni"
                        value={minSt[role]||0}
                        onChange={e=>setMinSt(p=>({...p,[role]:Number(e.target.value)}))}/>
                      <span style={{fontSize:9,color:"#94a3b8"}}>人以上</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cpi" style={{minWidth:190}}>
                <label>勤務時間設定（平日）</label>
                <div className="cpr"><span>開始</span><input type="time" className="ti" value={wh.start} onChange={e=>setWh(p=>({...p,start:e.target.value}))}/></div>
                <div className="cpr"><span>終了</span><input type="time" className="ti" value={wh.end} onChange={e=>setWh(p=>({...p,end:e.target.value}))}/></div>
                <div className="cpr"><span>休憩</span>
                  <input type="number" min="0" max="120" step="15" className="ni" value={wh.breakMin} onChange={e=>setWh(p=>({...p,breakMin:Number(e.target.value)}))}/>
                  <span style={{fontSize:9,color:"#94a3b8"}}>分</span>
                </div>
                <div style={{fontSize:9,color:"#64748b",marginTop:5,fontFamily:"JetBrains Mono,monospace"}}>
                  1日 {dH}h ／ 月標準 {stdH}h
                </div>
              </div>
              <div className="cpi" style={{minWidth:190}}>
                <label>勤務時間設定（土曜）</label>
                <div className="cpr"><span>開始</span><input type="time" className="ti" value={whSat.start} onChange={e=>setWhSat(p=>({...p,start:e.target.value}))}/></div>
                <div className="cpr"><span>終了</span><input type="time" className="ti" value={whSat.end} onChange={e=>setWhSat(p=>({...p,end:e.target.value}))}/></div>
                <div className="cpr"><span>休憩</span>
                  <input type="number" min="0" max="120" step="15" className="ni" value={whSat.breakMin} onChange={e=>setWhSat(p=>({...p,breakMin:Number(e.target.value)}))}/>
                  <span style={{fontSize:9,color:"#94a3b8"}}>分</span>
                </div>
                <div style={{fontSize:9,color:"#64748b",marginTop:5,fontFamily:"JetBrains Mono,monospace"}}>
                  土曜 {satDH}h／第2土は矯正当番別計算
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,paddingTop:2}}>
                <button className="abtn" onClick={handleAuto}>✨ 自動シフト作成</button>
                <button className="cbtn" onClick={async ()=>{
                  if(!window.confirm("当月のシフトをクリアします。よろしいですか？")) return;
                  setShifts({});
                  setNxtShifts({});
                  toast_("シフトをクリアしました");
                }}>🗑 クリア</button>
                <div style={{fontSize:9,color:"#94a3b8",lineHeight:1.7,padding:"2px 0"}}>
                  週40h基準 / 週休2日<br/>祝日週は週休3日<br/>矯正当番は自動ローテーション
                </div>
              </div>
            </div>

            {/* 医院休診日設定 */}
            <div style={{marginTop:14,borderTop:"1px solid #f1f5f9",paddingTop:12}}>
              <div style={{fontSize:11,fontWeight:800,color:"#b45309",marginBottom:8}}>🏥 医院休診日設定</div>
              {/* 登録済み休診日 */}
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                {clinicHolidays.length===0&&<span style={{fontSize:11,color:"var(--mut)"}}>登録なし</span>}
                {clinicHolidays.sort((a,b)=>a.date.localeCompare(b.date)).map(h=>(
                  <div key={h.date} style={{display:"flex",alignItems:"center",gap:4,
                    background:"#fef3c7",border:"1.5px solid #fcd34d",borderRadius:7,padding:"3px 8px"}}>
                    <span style={{fontSize:10,fontWeight:700,color:"#92400e"}}>{h.date.slice(5).replace("-","/")} {h.label}</span>
                    <button onClick={()=>{setClinicHolidays(ps=>ps.filter(x=>x.date!==h.date));toast_("休診日を削除しました");}}
                      style={{fontSize:9,padding:"0 4px",border:"none",background:"none",color:"#dc2626",cursor:"pointer",fontWeight:800}}>✕</button>
                  </div>
                ))}
              </div>
              {/* 追加フォーム */}
              <div style={{display:"flex",gap:6,alignItems:"flex-end",flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:9,fontWeight:700,color:"var(--mut)",marginBottom:2}}>日付</div>
                  <input id="ch-date" type="date"
                    style={{padding:"5px 8px",border:"1.5px solid #e2e8f0",borderRadius:6,fontSize:11,fontFamily:"inherit"}}/>
                </div>
                <div>
                  <div style={{fontSize:9,fontWeight:700,color:"var(--mut)",marginBottom:2}}>名称（任意）</div>
                  <input id="ch-label" placeholder="例：お盆休み"
                    style={{width:110,padding:"5px 8px",border:"1.5px solid #e2e8f0",borderRadius:6,fontSize:11,fontFamily:"inherit"}}/>
                </div>
                <button className="svbtn" style={{fontSize:10,padding:"5px 12px"}}
                  onClick={()=>{
                    const date=document.getElementById("ch-date").value;
                    const label=document.getElementById("ch-label").value||"休診";
                    if(!date){toast_("日付を選択してください");return;}
                    if(clinicHolidays.some(h=>h.date===date)){toast_("すでに登録されています");return;}
                    setClinicHolidays(ps=>[...ps,{date,label}]);
                    toast_(`${date} を休診日に登録しました`);
                    document.getElementById("ch-date").value="";
                    document.getElementById("ch-label").value="";
                  }}>＋ 追加</button>
                <button style={{fontSize:10,padding:"5px 10px",borderRadius:6,border:"1px solid #e2e8f0",
                  background:"#f8fafc",color:"#64748b",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                  onClick={()=>{
                    // お盆・年末年始を一括登録
                    const y=year;
                    const presets=[
                      {date:`${y}-08-13`,label:"お盆休み"},{date:`${y}-08-14`,label:"お盆休み"},
                      {date:`${y}-08-15`,label:"お盆休み"},{date:`${y}-08-16`,label:"お盆休み"},
                      {date:`${y}-12-29`,label:"年末休み"},{date:`${y}-12-30`,label:"年末休み"},
                      {date:`${y}-12-31`,label:"年末休み"},{date:`${y+1}-01-01`,label:"元旦"},
                      {date:`${y+1}-01-02`,label:"年始休み"},{date:`${y+1}-01-03`,label:"年始休み"},
                    ];
                    const newOnes=presets.filter(p=>!clinicHolidays.some(h=>h.date===p.date));
                    setClinicHolidays(ps=>[...ps,...newOnes]);
                    toast_(`お盆・年末年始（${newOnes.length}日）を登録しました`);
                  }}>📅 お盆・年末年始を一括登録</button>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  };

  // ── FLEX TAB ───────────────────────────────
  const FlexTab=()=>{
    const active=staff.filter(s=>s.active);
    return (
      <div>
        <div className="ph">
          <div className="ptitle">変形労働時間 <small>{year}年{month+1}月</small></div>
          <div className="mnav">
            <button onClick={()=>changeMonth(month===0?year-1:year, month===0?11:month-1)}>‹</button>
            <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
            <button onClick={()=>changeMonth(month===11?year+1:year, month===11?0:month+1)}>›</button>
          </div>
        </div>
        {overAlerts.length>0&&(
          <div className="hrsbar">
            <span style={{fontSize:16}}>🕐</span>
            <div>
              <div style={{fontWeight:800,marginBottom:4,fontSize:11}}>変形労働時間超過（月標準{stdH}h超え）</div>
              <ul className="alist">
                {overAlerts.map(s=>(
                  <li key={s.id} style={{background:"#fef3c7",color:"#92400e"}}>{s.name} {staffH[s.id]}h</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="fwrap" style={{marginBottom:16}}>
          <div className="cpt">📋 変形労働時間制（週40時間基準）</div>
          <div style={{display:"flex",gap:22,flexWrap:"wrap",fontSize:12}}>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>通常1日の所定労働時間（平日）</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace"}}>{dH}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>{wh.start}〜{wh.end}（休憩{wh.breakMin}分）</div>
            </div>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>土曜診療の所定労働時間</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace"}}>{satDH}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>{whSat.start}〜{whSat.end}（休憩{whSat.breakMin}分）</div>
            </div>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>矯正当番(土) 8:45〜12:30+{kyoseiTime.sat.start}〜{kyoseiTime.sat.end}</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace"}}>{SHIFT_TYPES["矯正当番_土"].hours}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>午前3.75h + 午後3.5h（休憩除く）</div>
            </div>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>矯正当番(木) 8:45〜12:30+{kyoseiTime.thu.start}〜{kyoseiTime.thu.end}</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace"}}>{SHIFT_TYPES["矯正当番_木"].hours}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>午前3.75h + 午後4.5h（休憩除く）</div>
            </div>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>{month+1}月の月間所定労働時間</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace",color:"var(--ac)"}}>{stdH}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>40h/週 × {D}日 ÷ 7</div>
            </div>
          </div>
        </div>
        <div className="sdiv">スタッフ別 月間労働時間</div>
        <div className="fgrid">
          {Object.keys(ROLES).map(role=>{
            const rv=ROLES[role];
            return active.filter(s=>s.role===role).map(s=>{
              const h=staffH[s.id]||0;
              const pct=stdH>0?Math.min(h/stdH,1.3):0;
              const isOver=h>stdH+0.5;
              const isUnder=h<stdH-dH*2;
              const bc=isOver?"fover":isUnder?"fund":"fok";
              return (
                <div className="fcard" key={s.id}
                  style={{background:isOver?"#fff5f5":isUnder?"#fffbeb":"var(--bg)"}}>
                  <div className="fn">{s.name}</div>
                  <span className="fr" style={{background:rv.bg,color:rv.color}}>{rv.short} {rv.label}</span>
                  <div className="fst">
                    <div className="fs"><div className="v" style={{color:isOver?"#dc2626":isUnder?"#d97706":"var(--txt)"}}>{h}</div><div className="l">実績h</div></div>
                    <div className="fs"><div className="v" style={{color:"var(--mut)",fontSize:12}}>{stdH}</div><div className="l">所定h</div></div>
                    <div className="fs"><div className="v" style={{color:isOver?"#dc2626":"#15803d",fontSize:12}}>{isOver?"+":""}{Math.round((h-stdH)*10)/10}</div><div className="l">{isOver?"超過":"差分"}h</div></div>
                  </div>
                  <div className="fbar">
                    <div className={`fbar-f ${bc}`} style={{width:`${Math.min(pct*100,100)}%`}}/>
                  </div>
                  <div style={{fontSize:8,color:"var(--mut)",marginTop:3,fontFamily:"JetBrains Mono,monospace"}}>
                    {Math.round(pct*100)}%
                    {isOver&&<span style={{color:"#dc2626",fontWeight:800,marginLeft:4}}>⚠ 超過</span>}
                  </div>
                </div>
              );
            });
          })}
        </div>
      </div>
    );
  };

  // ── KYOSEI TAB ────────────────────
  const KyoseiTab=()=>{
    // 矯正日スケジュール（当番はシフトから検索）
    const schedule=(()=>{
      const res=[];
      for(let d=1;d<=D;d++){
        const ki=kyoseiDays[d];
        if(ki){
          const tban=staff.filter(s=>s.active).find(s=>
            shifts[`${s.id}_${d}`]==="矯正当番_土"||shifts[`${s.id}_${d}`]==="矯正当番_木"
          );
          res.push({day:d,ki,tban});
        }
      }
      return res;
    })();

    // 矯正当番対象スタッフ
    const eligible=staff.filter(s=>s.active&&KYOSEI_ROLES.has(s.role));

    return (
      <div>
        <div className="ph"><div className="ptitle">矯正日管理</div></div>

        {/* 矯正日管理 */}
        <div className="krot-wrap" style={{marginBottom:14}}>
          <div className="cpt">📆 矯正日管理（{year}年{month+1}月）</div>
          <div style={{fontSize:11,color:"var(--mut)",marginBottom:10}}>
            デフォルトは第2土曜・第4木曜。イレギュラーで追加・削除できます。
          </div>

          {/* 矯正時間設定 */}
          <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:12,
            background:"#f0fdfa",border:"1px solid #6ee7b7",borderRadius:8,padding:"10px 14px"}}>
            <div style={{fontSize:10,fontWeight:800,color:"#065f46",width:"100%",marginBottom:4}}>🕑 矯正診療時間（デフォルト・変更可）</div>
            {/* 第2土曜 */}
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:700,color:"#0369a1",minWidth:80}}>第2土曜（午後）</span>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <input type="time" value={kyoseiTime.sat.start}
                  onChange={e=>setKyoseiTime(p=>({...p,sat:{...p.sat,start:e.target.value}}))}
                  style={{padding:"4px 6px",border:"1.5px solid #7dd3fc",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
                <span style={{fontSize:11,color:"var(--mut)"}}>〜</span>
                <input type="time" value={kyoseiTime.sat.end}
                  onChange={e=>setKyoseiTime(p=>({...p,sat:{...p.sat,end:e.target.value}}))}
                  style={{padding:"4px 6px",border:"1.5px solid #7dd3fc",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
              </div>
            </div>
            {/* 第4木曜 */}
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:700,color:"#065f46",minWidth:80}}>第4木曜（午後）</span>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <input type="time" value={kyoseiTime.thu.start}
                  onChange={e=>setKyoseiTime(p=>({...p,thu:{...p.thu,start:e.target.value}}))}
                  style={{padding:"4px 6px",border:"1.5px solid #6ee7b7",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
                <span style={{fontSize:11,color:"var(--mut)"}}>〜</span>
                <input type="time" value={kyoseiTime.thu.end}
                  onChange={e=>setKyoseiTime(p=>({...p,thu:{...p.thu,end:e.target.value}}))}
                  style={{padding:"4px 6px",border:"1.5px solid #6ee7b7",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
              </div>
            </div>
          </div>

          {/* 今月の矯正日一覧 */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {Object.entries(kyoseiDays).sort((a,b)=>Number(a[0])-Number(b[0])).map(([d,ki])=>{
              const isExtra=extraKyosei.some(k=>k.year===year&&k.month===month&&k.day===Number(d));
              return (
                <div key={d} style={{display:"flex",alignItems:"center",gap:5,
                  background:isExtra?"#fdf4ff":"#f0fdfa",
                  border:`1.5px solid ${isExtra?"#d8b4fe":"#6ee7b7"}`,
                  borderRadius:8,padding:"5px 10px"}}>
                  <span style={{fontSize:11,fontWeight:800,color:isExtra?"#7e22ce":"#065f46"}}>
                    {month+1}/{d}（{ki.label}）
                  </span>
                  {isExtra&&<span style={{fontSize:8,background:"#ede9fe",color:"#7e22ce",padding:"1px 5px",borderRadius:4,fontWeight:800}}>追加</span>}
                  <button style={{fontSize:9,padding:"1px 6px",borderRadius:4,border:"1px solid #fca5a5",
                    background:"#fff",color:"#dc2626",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
                    onClick={()=>{
                      if(isExtra){
                        setExtraKyosei(ps=>ps.filter(k=>!(k.year===year&&k.month===month&&k.day===Number(d))));
                      } else {
                        setDeletedKyosei(ps=>[...ps,`${year}-${month}-${d}`]);
                      }
                      toast_(`${month+1}/${d} の矯正日を削除しました`);
                    }}>✕</button>
                </div>
              );
            })}
            {Object.keys(kyoseiDays).length===0&&(
              <div style={{fontSize:11,color:"var(--mut)"}}>今月の矯正日はありません</div>
            )}
          </div>

          {/* 矯正日追加フォーム */}
          <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap",
            background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px"}}>
            <div>
              <div style={{fontSize:9,fontWeight:700,color:"var(--mut)",marginBottom:3}}>日付</div>
              <input id="kyosei-add-day" type="number" min="1" max="31" placeholder="例: 15"
                style={{width:70,padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
            </div>
            <div>
              <div style={{fontSize:9,fontWeight:700,color:"var(--mut)",marginBottom:3}}>種別</div>
              <select id="kyosei-add-type"
                style={{padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:6,fontSize:12,fontFamily:"inherit"}}>
                <option value="土">土曜矯正（{kyoseiTime.sat.start}〜{kyoseiTime.sat.end}）</option>
                <option value="木">木曜矯正（{kyoseiTime.thu.start}〜{kyoseiTime.thu.end}）</option>
              </select>
            </div>
            <div>
              <div style={{fontSize:9,fontWeight:700,color:"var(--mut)",marginBottom:3}}>ラベル</div>
              <input id="kyosei-add-label" placeholder="例: 第3土"
                style={{width:80,padding:"6px 8px",border:"1.5px solid #e2e8f0",borderRadius:6,fontSize:12,fontFamily:"inherit"}}/>
            </div>
            <button className="svbtn" style={{fontSize:11}}
              onClick={()=>{
                const day=Number(document.getElementById("kyosei-add-day").value);
                const type=document.getElementById("kyosei-add-type").value;
                const label=document.getElementById("kyosei-add-label").value||`${month+1}/${day}`;
                if(!day||day<1||day>31){toast_("日付を入力してください");return;}
                const dateKey=`${year}-${month}-${day}`;
                setDeletedKyosei(ps=>ps.filter(k=>k!==dateKey));
                setExtraKyosei(ps=>[...ps.filter(k=>!(k.year===year&&k.month===month&&k.day===day)),
                  {year,month,day,type,label}]);
                toast_(`${month+1}/${day} を矯正日に追加しました`);
                document.getElementById("kyosei-add-day").value="";
                document.getElementById("kyosei-add-label").value="";
              }}>＋ 追加</button>
          </div>
        </div>

      </div>
    );
  };

  const PaidTab=()=>{
    const vs=isA?staff.filter(s=>s.active):[mySt].filter(Boolean);
    return (
      <div>
        <div className="ph"><div className="ptitle">有給管理</div></div>
        {isA&&(
          <div className="cards">
            {Object.entries(ROLES).map(([role,rv])=>{
              const rs=staff.filter(s=>s.role===role&&s.active);
              const used=rs.reduce((a,s)=>a+s.used,0);
              const tot=rs.reduce((a,s)=>a+s.leave,0);
              return (
                <div className="card" key={role}>
                  <div className="card-t"><span style={{background:rv.bg,color:rv.color,padding:"1px 5px",borderRadius:7,fontSize:7,fontWeight:800,marginRight:3}}>{rv.short}</span>{rv.label}</div>
                  <div className="card-v" style={{color:rv.color}}>{tot-used}<small> 日残</small></div>
                  <div className="card-s">取得 {used}日 / 付与 {tot}日</div>
                </div>
              );
            })}
          </div>
        )}
        <div className="ptwrap">
          <table className="ptbl">
            <thead>
              <tr><th>スタッフ名</th><th>役職</th><th>付与</th><th>取得</th><th>残日数</th><th>取得状況</th>{isA&&<th>操作</th>}</tr>
            </thead>
            <tbody>
              {Object.keys(ROLES).map(role=>
                vs.filter(s=>s.role===role).map(s=>{
                  const rv=ROLES[role];
                  const rem=s.leave-s.used;
                  const pct=s.leave>0?s.used/s.leave:0;
                  const bc=pct>=.8?"hi":pct<=.3?"lo":"md";
                  return (
                    <tr key={s.id}>
                      <td style={{fontWeight:700}}>{s.name}</td>
                      <td><span className="rb2" style={{background:rv.bg,color:rv.color}}>{rv.short} {rv.label}</span></td>
                      <td style={{textAlign:"center",fontFamily:"JetBrains Mono,monospace",fontWeight:700}}>{s.leave}日</td>
                      <td style={{textAlign:"center",fontFamily:"JetBrains Mono,monospace",fontWeight:700,color:"#d97706"}}>{s.used}日</td>
                      <td style={{textAlign:"center",fontFamily:"JetBrains Mono,monospace",fontWeight:900,color:rem<=2?"#dc2626":"#16a34a"}}>{rem}日</td>
                      <td style={{minWidth:130}}>
                        <div className="rbar-w">
                          <div className="rbar"><div className={`rbar-f ${bc}`} style={{width:`${Math.min(100,pct*100)}%`}}/></div>
                          <span className="lnum">{Math.round(pct*100)}%</span>
                        </div>
                      </td>
                      {isA&&<td><div style={{display:"flex",gap:4}}>
                        <button className="pa g" onClick={()=>{setStaff(ps=>ps.map(st=>st.id===s.id?{...st,used:Math.min(st.leave,st.used+1)}:st));toast_(`${s.name}: 有給+1日`);}}>+1日</button>
                        <button className="pa r" onClick={()=>{setStaff(ps=>ps.map(st=>st.id===s.id?{...st,used:Math.max(0,st.used-1)}:st));toast_(`${s.name}: 有給-1日`);}}>−1日</button>
                      </div></td>}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ── WISH TAB ───────────────────────────────
  const WishTab=()=>{
    const sid=isA?null:user.staffId;
    const days=Array.from({length:D},(_,i)=>i+1);
    const fd=fdow(year,month);
    const cells=[...Array(fd).fill(null),...days];

    if(isA){
      return (
        <div>
          <div className="ph">
            <div className="ptitle">希望シフト確認 <small>{year}年{month+1}月</small></div>
            <div className="mnav">
              <button onClick={()=>changeMonth(month===0?year-1:year, month===0?11:month-1)}>‹</button>
              <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
              <button onClick={()=>changeMonth(month===11?year+1:year, month===11?0:month+1)}>›</button>
            </div>
          </div>
          <div className="twrap">
            <table className="stbl">
              <thead>
                <tr>
                  <th className="sc">スタッフ</th>
                  {days.map(d=>{
                    const dow=new Date(year,month,d).getDay();
                    const hol=isClinicHoliday(year,month,d);
                    const ki=kyoseiDays[d];
                    let cls=hol||dow===0?"th-hol":ki?"th-k2sat":dow===6?"th-sat":"";
                    return <th key={d} className={cls}>{d}<br/><span style={{fontSize:8}}>{DAYS_JP[dow]}</span>{ki&&!hol&&<span className="k-mark">矯</span>}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {Object.entries(ROLES).map(([role,rv])=>[
                  <tr key={`rh_${role}`} className="rhr">
                    <td colSpan={D+1}><span style={{background:rv.bg,color:rv.color,padding:"2px 7px",borderRadius:7,fontSize:8,fontWeight:800}}>{rv.label}</span></td>
                  </tr>,
                  ...staff.filter(s=>s.active&&s.role===role).map(s=>(
                    <tr key={s.id}>
                      <td className="sn"><div className="nm">{s.name}</div></td>
                      {days.map(d=>{
                        const ws=wishes[`${s.id}_${d}`];
                        const st=SHIFT_TYPES[ws];
                        return <td key={d}>{ws?<span className="scl" style={{background:st?.bg,color:st?.color}}>{shiftLabel(ws)}</span>:<span style={{color:"#e2e8f0",fontSize:10}}>—</span>}</td>;
                      })}
                    </tr>
                  ))
                ])}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    return (
      <div>
        <div className="ph">
          <div className="ptitle">希望シフト提出 <small>{year}年{month+1}月</small></div>
          <div className="mnav">
            <button onClick={()=>changeMonth(month===0?year-1:year, month===0?11:month-1)}>‹</button>
            <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
            <button onClick={()=>changeMonth(month===11?year+1:year, month===11?0:month+1)}>›</button>
          </div>
        </div>
        <div className="cp">
          <div className="cpt">📅 希望シフトカレンダー</div>
          <div style={{fontSize:11,color:"#64748b",marginBottom:12}}>日付をクリックして希望を入力してください。</div>
          <div className="wcal">
            {DAYS_JP.map((d,i)=>(
              <div key={d} className={`wdh ${i===0?"sun":i===6?"sat":""}`}>{d}</div>
            ))}
            {cells.map((d,i)=>{
              if(d===null) return <div key={`e${i}`} className="wdc emp"/>;
              const dow=new Date(year,month,d).getDay();
              const hol=isClinicHoliday(year,month,d);
              const ki=kyoseiDays[d];
              const ws=wishes[`${sid}_${d}`];
              const st=SHIFT_TYPES[ws];
              return (
                <div key={d} className={`wdc ${ki&&!hol?"kd":""}`}
                  onClick={()=>setWModal({staffId:sid,day:d})}>
                  <div className={`wdn ${dow===0||hol?"sun":dow===6?"sat":""}`}>{d}</div>
                  {hol&&<div style={{fontSize:7,color:"#d97706"}}>祝</div>}
                  {ki&&!hol&&<div style={{fontSize:7,color:"#065f46",fontWeight:800}}>{ki.label}矯正日</div>}
                  {ws&&<span className="wtag" style={{background:st?.bg,color:st?.color}}>{shiftLabel(ws)}</span>}
                </div>
              );
            })}
          </div>
          <div style={{marginTop:12}}>
            <button className="abtn" onClick={()=>toast_("希望シフトを管理者に送信しました！")}>📨 管理者に送信</button>
          </div>
        </div>
      </div>
    );
  };

  // ── STAFF TAB ──────────────────────────────
  const StaffTab=()=>(
    <div>
      <div className="ph">
        <div className="ptitle">スタッフ管理</div>
        <div style={{display:"flex",gap:6}}>
          <button className="abtn" style={{fontSize:11,padding:"7px 12px"}}
            onClick={()=>setAddSt(v=>!v)}>
            {addSt?"✕ キャンセル":"＋ スタッフ追加"}
          </button>
          <button style={{fontSize:10,padding:"6px 10px",borderRadius:7,border:"1px solid #fca5a5",
            background:"#fff5f5",color:"#dc2626",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}
            onClick={async ()=>{
              if(window.confirm("⚠️ スタッフデータを初期データにリセットします。\nシフト・有給・設定もすべて消えます。よろしいですか？")){
                // localStorage クリア
                const lsKeys=["db_staff","db_minSt","db_wh","db_whSat","db_kyoseiTime","db_calStart",
                  "db_holidays","db_extraKyosei","db_deletedKyosei","db_seminars","db_visits"];
                lsKeys.forEach(k=>localStorage.removeItem(k));
                // Supabase テーブルをクリア
                await Promise.all([
                  supabase.from("seminar_staff").delete().neq("seminar_id", 0),
                  supabase.from("visit_staff").delete().neq("visit_id", 0),
                ]);
                await Promise.all([
                  supabase.from("shifts").delete().neq("id", 0),
                  supabase.from("wishes").delete().neq("id", 0),
                  supabase.from("seminars").delete().neq("id", 0),
                  supabase.from("visits").delete().neq("id", 0),
                  supabase.from("staff_rest_days").delete().neq("id", 0),
                  supabase.from("clinic_holidays").delete().neq("id", 0),
                  supabase.from("kyosei_overrides").delete().neq("id", 0),
                  supabase.from("staff").delete().neq("id", 0),
                ]);
                window.location.reload();
              }
            }}>🗑 データリセット</button>
        </div>
      </div>
      {addSt&&(
        <div className="aform">
          <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>新規スタッフ追加</div>
          <div className="afr" onKeyDown={e=>{ if(e.key==="Enter"&&!e.nativeEvent.isComposing) e.preventDefault(); }}>
            <div className="aff" style={{minWidth:120}}><label>氏名</label>
              <input value={newSt.name}
                onChange={e=>setNewSt(n=>({...n,name:e.target.value}))}
                onCompositionStart={()=>{}}
                onCompositionEnd={()=>{}}
                placeholder="例：田中 花子"/>
            </div>
            <div className="aff" style={{maxWidth:100}}><label>役職</label>
              <select value={newSt.role} onChange={e=>setNewSt(n=>({...n,role:e.target.value}))}>
                {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="aff" style={{maxWidth:130}}><label>生年月日</label>
              <input type="date" value={newSt.birthDate} onChange={e=>setNewSt(n=>({...n,birthDate:e.target.value}))}/>
            </div>
            <div className="aff" style={{maxWidth:90}}><label>入社年度</label>
              <input type="number" value={newSt.joinYear} onChange={e=>setNewSt(n=>({...n,joinYear:Number(e.target.value)}))} min="1990" max="2099"/>
            </div>
            <div className="aff" style={{maxWidth:100}}><label>雇用形態</label>
              <select value={newSt.employment} onChange={e=>setNewSt(n=>({...n,employment:e.target.value,weeklyDaysOff:e.target.value==="パート"?null:2}))}>
                <option value="正社員">正社員</option>
                <option value="17時まで">17時まで勤務</option>
                <option value="パート">パート</option>
              </select>
            </div>
            {newSt.employment==="正社員"&&(
              <div className="aff" style={{maxWidth:100}}><label>週休日数</label>
                <select value={newSt.weeklyDaysOff} onChange={e=>setNewSt(n=>({...n,weeklyDaysOff:Number(e.target.value)}))}>
                  <option value={2}>週休2日</option>
                  <option value={2.5}>週休2.5日</option>
                  <option value={3}>週休3日</option>
                </select>
              </div>
            )}
            <div className="aff" style={{maxWidth:90}}><label>有給付与日数</label>
              <input type="number" value={newSt.leave} onChange={e=>setNewSt(n=>({...n,leave:Number(e.target.value)}))} min="0" max="40"/>
            </div>
            <div className="aff" style={{minWidth:240}}>
              {RestDayPicker({
                restDays: newSt.restDays||[],
                onChange: (rd)=>setNewSt(n=>({...n,restDays:rd})),
                targetId: "new"
              })}
            </div>
            <button className="svbtn" onClick={()=>{
              if(!newSt.name.trim()){toast_("氏名を入力してください");return;}
              const id=Math.max(0,...staff.map(s=>s.id))+1;
              const isKyosei=KYOSEI_ROLES.has(newSt.role);
              const maxOrd=isKyosei?Math.max(0,...staff.filter(s=>s.kyoseiOrder!=null).map(s=>s.kyoseiOrder)):null;
              setStaff(ps=>[...ps,{
                id, name:newSt.name, role:newSt.role, leave:newSt.leave, used:0, active:true,
                kyoseiOrder:isKyosei?maxOrd+1:null,
                birthDate:newSt.birthDate, joinYear:newSt.joinYear,
                employment:newSt.employment,
                weeklyDaysOff:newSt.employment==="正社員"?newSt.weeklyDaysOff:null,
                restDays:newSt.restDays||[],
              }]);
              setNewSt({name:"",role:"Dh",leave:10,birthDate:"",joinYear:new Date().getFullYear(),employment:"正社員",weeklyDaysOff:2,restDays:[]});
              setAddSt(false);
              toast_(`${newSt.name} を追加しました`);
            }}>追加</button>
          </div>
        </div>
      )}
      <div className="sgrid">
        {Object.keys(ROLES).map(role=>{
          const rv=ROLES[role];
          return staff.filter(s=>s.role===role).map(s=>{
            const age=s.birthDate?Math.floor((new Date()-new Date(s.birthDate))/(365.25*24*3600*1000)):null;
            const tenure=s.joinYear?new Date().getFullYear()-s.joinYear:null;
            return (
            <div className="scard" key={s.id} style={{opacity:s.active?1:.55}}>
              <div className="st">
                <div>
                  <div className="snm">{s.name}</div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:3}}>
                    <span className="srl" style={{background:rv.bg,color:rv.color}}>{rv.short} {rv.label}</span>
                    <span className="srl" style={{background:s.employment==="正社員"?"#dbeafe":"#fef3c7",color:s.employment==="正社員"?"#1d4ed8":"#b45309"}}>
                      {s.employment||"正社員"}
                    </span>
                    {s.employment==="正社員"&&s.weeklyDaysOff!=null&&(
                      <span className="srl" style={{background:"#f0fdf4",color:"#15803d"}}>週休{s.weeklyDaysOff}日</span>
                    )}
                    {s.kyoseiOrder!=null&&(
                      <span className="srl" style={{background:"#d1fae5",color:"#065f46"}}>矯正{s.kyoseiOrder}番</span>
                    )}
                    <span className="srl" style={{background:s.loginId?"#dbeafe":"#fee2e2",color:s.loginId?"#1d4ed8":"#dc2626"}}>
                      {s.loginId?`ID: ${s.loginId}`:"ID未設定"}
                    </span>
                    <span className="srl" style={{background:s.pin?"#dcfce7":"#fee2e2",color:s.pin?"#15803d":"#dc2626"}}>
                      {s.pin?"PIN: ●●●●":"PIN未設定"}
                    </span>
                  </div>
                  {/* 生年月日・入社年度 */}
                  <div style={{marginTop:6,display:"flex",gap:10,flexWrap:"wrap"}}>
                    {s.birthDate&&(
                      <div style={{fontSize:10,color:"var(--mut)"}}>
                        🎂 {s.birthDate.replace(/-/g,"/")}
                        {age!=null&&<span style={{marginLeft:4,fontWeight:700,color:"var(--txt)"}}>（{age}歳）</span>}
                      </div>
                    )}
                    {s.joinYear&&(
                      <div style={{fontSize:10,color:"var(--mut)"}}>
                        📅 {s.joinYear}年入社
                        {tenure!=null&&<span style={{marginLeft:4,fontWeight:700,color:"var(--txt)"}}>（{tenure}年目）</span>}
                      </div>
                    )}
                  </div>
                  {/* 定休曜日 */}
                  <div style={{marginTop:8}}>
                    {RestDayPicker({
                      restDays: s.restDays||[],
                      onChange: (rd)=>setStaff(ps=>ps.map(st=>st.id===s.id?{...st,restDays:rd}:st)),
                      targetId: s.id
                    })}
                  </div>
                </div>
                <button className="sb" style={{background:s.active?"#dcfce7":"#f3f4f6",color:s.active?"#15803d":"#9ca3af",borderColor:"transparent",flexShrink:0}}
                  onClick={()=>{setStaff(ps=>ps.map(st=>st.id===s.id?{...st,active:!st.active}:st));toast_(s.active?`${s.name} を休職にしました`:`${s.name} を復帰させました`);}}>
                  {s.active?"在職":"休職"}
                </button>
              </div>
              <div className="sst">
                <div className="si"><div className="v">{s.leave}</div><div className="l">有給付与</div></div>
                <div className="si"><div className="v" style={{color:"#d97706"}}>{s.used}</div><div className="l">取得済</div></div>
                <div className="si"><div className="v" style={{color:s.leave-s.used<=2?"#dc2626":"#16a34a"}}>{s.leave-s.used}</div><div className="l">残日数</div></div>
                {isA&&<div className="si"><div className="v" style={{color:"#7c3aed",fontSize:12}}>{staffH[s.id]||0}</div><div className="l">今月h</div></div>}
              </div>
              <div className="sact">
                <button className="sb" onClick={()=>{const n=window.prompt("氏名を変更:",s.name);if(n?.trim()){setStaff(ps=>ps.map(st=>st.id===s.id?{...st,name:n.trim()}:st));toast_("氏名を変更しました");}}}>名前変更</button>
                <button className="sb" onClick={()=>{
                  const opts=Object.keys(ROLES).join(" / ");
                  const n=window.prompt(`職種を変更（${opts}）\n現在：${s.role}`,s.role);
                  if(n&&ROLES[n]){
                    const isKyosei=KYOSEI_ROLES.has(n);
                    const maxOrd=isKyosei?Math.max(0,...staff.filter(x=>x.kyoseiOrder!=null).map(x=>x.kyoseiOrder)):null;
                    setStaff(ps=>ps.map(st=>st.id===s.id?{...st,role:n,kyoseiOrder:isKyosei&&st.kyoseiOrder==null?maxOrd+1:KYOSEI_ROLES.has(n)?st.kyoseiOrder:null}:st));
                    toast_(`${s.name} の職種を「${ROLES[n].label}」に変更しました`);
                  } else if(n) toast_(`「${n}」は無効な職種です。${opts} のいずれかで入力してください`);
                }}>職種変更</button>
                <button className="sb" onClick={()=>{const n=Number(window.prompt("有給付与日数:",s.leave));if(!isNaN(n)&&n>=0){setStaff(ps=>ps.map(st=>st.id===s.id?{...st,leave:n}:st));toast_("有給日数を更新しました");}}}>有給変更</button>
                <button className="sb" onClick={()=>{
                  const emp=window.confirm(`${s.name} の雇用形態を「${s.employment==="正社員"?"パート":"正社員"}」に変更しますか？`);
                  if(emp){
                    const next=s.employment==="正社員"?"パート":"正社員";
                    setStaff(ps=>ps.map(st=>st.id===s.id?{...st,employment:next,weeklyDaysOff:next==="正社員"?2:null}:st));
                    toast_("雇用形態を変更しました");
                  }
                }}>雇用変更</button>
                {s.employment==="正社員"&&(
                  <button className="sb" onClick={()=>{
                    const opts=["2","2.5","3"];
                    const cur=String(s.weeklyDaysOff||2);
                    const n=window.prompt(`週休日数を入力（2 / 2.5 / 3）\n現在：${cur}日`,cur);
                    if(n&&opts.includes(n)){setStaff(ps=>ps.map(st=>st.id===s.id?{...st,weeklyDaysOff:Number(n)}:st));toast_("週休日数を変更しました");}
                    else if(n) toast_("2、2.5、3のいずれかで入力してください");
                  }}>週休変更</button>
                )}
                <button className="sb" style={{background:"#eff6ff",color:"#1d4ed8",borderColor:"#bfdbfe"}}
                  onClick={()=>setIdModal(s.id)}>🪪 ID・PIN設定</button>
                <button className="sb del" onClick={()=>{if(window.confirm(`${s.name} を削除しますか？`)){setStaff(ps=>ps.filter(st=>st.id!==s.id));toast_(`${s.name} を削除しました`);}}}>削除</button>
              </div>
            </div>
          );});
        })}
      </div>
    </div>
  );

  // ── 定休曜日ピッカー共通UI ──────────────────
  // restDays: [{dow, type}], onChange: (newRestDays)=>void, targetId: staffId or "new"
  const RestDayPicker=({restDays, onChange, targetId})=>{
    const DAYS=["月","火","水","木","金","土"];
    return (
      <div>
        <div style={{fontSize:8,color:"var(--mut)",fontWeight:700,marginBottom:5,letterSpacing:".3px"}}>定休曜日</div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
          {DAYS.map((d,i)=>{
            const dow=i+1;
            const entry=(restDays||[]).find(r=>r.dow===dow);
            const type=entry?.type||null;
            const isOpen=rdPop?.targetId===targetId&&rdPop?.dow===dow;

            // ボタンの色
            let bg="#f8fafc", color="#94a3b8", border="#e2e8f0", label=d;
            if(type==="全日"){  bg="#0f4c8a"; color="#fff"; border="#0f4c8a"; label=d+"✕"; }
            if(type==="午前"){ bg="#0891b2"; color="#fff"; border="#0891b2"; label=d+"前"; }
            if(type==="午後"){ bg="#7c3aed"; color="#fff"; border="#7c3aed"; label=d+"後"; }

            return (
              <div key={dow} className="rdpick">
                <button type="button"
                  style={{padding:"4px 8px",borderRadius:6,border:`1.5px solid ${border}`,
                    background:bg,color,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit",
                    minWidth:34}}
                  onClick={e=>{
                    e.stopPropagation();
                    setRdPop(isOpen?null:{targetId,dow});
                  }}>
                  {label}
                </button>
                {isOpen&&(
                  <div className="rdpop" onClick={e=>e.stopPropagation()}>
                    <div className="rdpop-title">{d}曜日</div>
                    <div className="rdpop-opts">
                      <button className={`rdpop-opt none ${!type?"sel":""}`}
                        onClick={()=>{onChange((restDays||[]).filter(r=>r.dow!==dow));setRdPop(null);}}>
                        出勤
                      </button>
                      <button className={`rdpop-opt ${type==="午前"?"sel-am":""}`}
                        onClick={()=>{onChange([...(restDays||[]).filter(r=>r.dow!==dow),{dow,type:"午前"}]);setRdPop(null);}}>
                        🌅 午前休
                      </button>
                      <button className={`rdpop-opt ${type==="午後"?"sel-pm":""}`}
                        onClick={()=>{onChange([...(restDays||[]).filter(r=>r.dow!==dow),{dow,type:"午後"}]);setRdPop(null);}}>
                        🌇 午後休
                      </button>
                      <button className={`rdpop-opt ${type==="全日"?"sel":""}`}
                        onClick={()=>{onChange([...(restDays||[]).filter(r=>r.dow!==dow),{dow,type:"全日"}]);setRdPop(null);}}>
                        🌙 全日休
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {(restDays||[]).length>0&&(
          <div style={{marginTop:5,fontSize:9,color:"var(--mut)"}}>
            {(restDays||[]).sort((a,b)=>a.dow-b.dow).map(r=>{
              const dayName=["月","火","水","木","金","土"][r.dow-1];
              const typeColor=r.type==="午前"?"#0891b2":r.type==="午後"?"#7c3aed":"#0f4c8a";
              return <span key={r.dow} style={{display:"inline-block",marginRight:6,color:typeColor,fontWeight:700}}>{dayName}曜{r.type}</span>;
            })}
          </div>
        )}
      </div>
    );
  };

  // ── APPOINTMENT PDF TAB ─────────────────────
  const ApptTab=()=>{
    // PDF解析: テキスト項目を座標付きで取得
    async function parsePdf(arrayBuffer){
      const pdf=await pdfjsLib.getDocument({data:arrayBuffer}).promise;
      const rawItems=[];
      for(let p=1;p<=pdf.numPages;p++){
        const page=await pdf.getPage(p);
        const tc=await page.getTextContent();
        tc.items.forEach(it=>{
          if(it.str.trim()) rawItems.push({
            str:it.str.normalize("NFKC"), // 全角英数→半角、半角カナ→全角 等を統一
            x:it.transform[4],  // 丸めない（精度維持）
            y:it.transform[5],
            w:it.width||0,
            page:p
          });
        });
      }
      // 同一行(Y座標近い)で隣接するテキストを結合（pdfjsが分割することがある）
      rawItems.sort((a,b)=>b.y-a.y||a.x-b.x);
      const merged=[];
      const yTol=2; // Y座標の許容誤差
      const xGap=3; // X座標のギャップ許容値
      for(const it of rawItems){
        const last=merged[merged.length-1];
        if(last && Math.abs(last.y-it.y)<yTol && it.x<=(last.x+last.w+xGap) && last.page===it.page){
          // 前のアイテムに結合
          last.str+=it.str;
          last.w=(it.x-last.x)+it.w;
        } else {
          merged.push({...it});
        }
      }
      return merged;
    }

    // テキスト項目→構造化データ
    function buildAppointments(items){
      if(!items||items.length===0) return null;
      // ヘッダー: 最上部のテキストから日付を取得
      const sorted=[...items].sort((a,b)=>b.y-a.y||a.x-b.x);
      let dateStr="", notes="";
      // 令和N年MM月DD日(曜)
      const dateRe=/令和(\d+)年(\d+)月(\d+)日\((.)\)/;
      for(const it of sorted){
        const m=it.str.match(dateRe);
        if(m){
          const wy=2018+parseInt(m[1]);
          dateStr=`${wy}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
          break;
        }
      }
      // 備考行 (矯正　村山　西森　休み...)
      for(const it of sorted){
        if(it.str.includes("矯正")||it.str.includes("休み")||it.str.includes("DA")||it.str.includes("DH")){
          if(!it.str.includes("メンテ")&&!it.str.includes("チェア")){
            notes=it.str; break;
          }
        }
      }
      // チェア列ヘッダーを検出
      const chairNames=["メンテ1","メンテ2","メンテ3","メンテ4","Dr.5","Dr.6","Dr.7","特診室","新患","カウンセリング"];
      // NFKC正規化済みなので半角カナ・全角数字は自動変換済み
      const chairNorm=s=>s.normalize("NFKC").replace(/\s/g,"");
      const headerItems=items.filter(it=>{
        const n=chairNorm(it.str);
        return chairNames.some(cn=>n.includes(chairNorm(cn)));
      });
      // X座標でチェア列の境界を決定
      const colBounds=[];
      // ヘッダーX座標を近い値でグルーピング（同一列の揺れ吸収）
      const sortedHX=[...headerItems].sort((a,b)=>a.x-b.x);
      const uniqueX=[];
      for(const h of sortedHX){
        if(uniqueX.length===0||h.x-uniqueX[uniqueX.length-1]>10){
          uniqueX.push(h.x);
        }
      }
      // 列境界: 各ヘッダーXの中間点
      for(let i=0;i<uniqueX.length;i++){
        const left=i===0?-9999:(uniqueX[i-1]+uniqueX[i])/2;
        const right=i===uniqueX.length-1?9999:(uniqueX[i]+uniqueX[i+1])/2;
        const hdr=headerItems.find(h=>Math.abs(h.x-uniqueX[i])<10);
        colBounds.push({name:hdr?hdr.str.trim():`列${i+1}`, left, right, x:uniqueX[i]});
      }
      if(colBounds.length===0) return null;
      // 時間行を検出 (09:00, 09:15, ... パターン)
      const timeRe=/^(\d{1,2}):(\d{2})$/;
      const timeItems=items.filter(it=>timeRe.test(it.str.trim()));
      const timeYs=[...new Set(timeItems.map(t=>t.y))].sort((a,b)=>b-a);
      // セル内テキストを集約
      const headerY=headerItems.length>0?Math.min(...headerItems.map(h=>h.y)):9999;
      const contentItems=items.filter(it=>it.y<headerY-5);
      // 時間行間の間隔から、行に属す最大距離を算出
      const timeGap=timeYs.length>=2?Math.abs(timeYs[0]-timeYs[1]):30;
      const maxRowDist=timeGap*0.6; // 行間の60%以内なら同じ時間帯に属する
      // セルをチェア×時間帯にマッピング
      const cells={};// key: "colIdx_timeY" -> [strings]
      contentItems.forEach(it=>{
        const col=colBounds.findIndex(c=>it.x>=c.left&&it.x<c.right);
        if(col<0) return;
        // 最も近い時間Yを探索（閾値付き）
        let bestTy=null, bestDist=999999;
        timeYs.forEach(ty=>{
          const d=Math.abs(it.y-ty);
          if(d<bestDist){bestDist=d;bestTy=ty;}
        });
        if(bestTy===null||bestDist>maxRowDist) return; // 遠すぎる項目はスキップ
        const key=`${col}_${bestTy}`;
        if(!cells[key]) cells[key]=[];
        cells[key].push(it.str.trim());
      });
      // セルからスタッフ割り当てを抽出
      const appointments=[];
      const timeMap={};
      timeItems.forEach(t=>{timeMap[t.y]=t.str.trim();});
      Object.entries(cells).forEach(([key,strs])=>{
        const [colIdx,ty]=key.split("_").map(Number);
        const chair=colBounds[colIdx]?.name||"";
        const time=timeMap[ty]||"";
        // セル内のテキストを結合してからスタッフ抽出（分割対策）
        const text=strs.join(" ");
        // 患者ID (6桁数字)
        const idMatch=text.match(/(\d{6})/);
        // スタッフ抽出 - 結合テキストからも検出
        let assignedStaff=[];
        const extractStaff=(ss)=>{
          ss=ss.trim();
          const ssN=ss.normalize("NFKC").replace(/﨑/g,"崎");
          if(ss==="院長") assignedStaff.push({raw:"院長",role:"Dr",name:"院長",isAny:false});
          else if(ssN==="岡崎"||ss==="岡﨑") assignedStaff.push({raw:ss,role:"Dr",name:"岡崎",isAny:false});
          else if(/^DH\s*(.+)/.test(ss)){
            const n=ss.replace(/^DH\s*/,"");
            assignedStaff.push({raw:ss,role:"Dh",name:n,isAny:n==="誰でも"});
          }
          else if(/^Dr\.?\s*(.+)/.test(ss)&&!/^Dr\.\d/.test(ss)){
            // Dr.5等のチェア名は除外
            const n=ss.replace(/^Dr\.?\s*/,"");
            assignedStaff.push({raw:ss,role:"Dr",name:n,isAny:n==="誰でも"});
          }
          else if(/衛生士\s*誰でも/.test(ss)){
            assignedStaff.push({raw:ss,role:"Dh",name:"誰でも",isAny:true});
          }
        };
        // 個別テキストから抽出
        strs.forEach(s=>extractStaff(s));
        // 個別で見つからなかった場合、結合テキストからも試行
        if(assignedStaff.length===0) extractStaff(text);
        if(assignedStaff.length>0||idMatch){
          appointments.push({chair,time,text,patientId:idMatch?idMatch[1]:"",staff:assignedStaff});
        }
      });
      return {date:dateStr, notes, chairs:colBounds.map(c=>c.name), appointments};
    }

    // スタッフ名マッチング (PDF上の省略名 → staffデータ)
    function matchStaff(pdfName, role, staffList){
      if(!pdfName||pdfName==="誰でも") return null;
      if(pdfName==="院長") return null; // 院長は別扱い
      // 漢字正規化 (異体字・全角半角・スペース統一)
      const norm=s=>(s||"").normalize("NFKC")
        .replace(/﨑/g,"崎").replace(/髙/g,"高").replace(/濵/g,"浜").replace(/邊|邉/g,"辺")
        .replace(/齋|齊/g,"斎").replace(/廣/g,"広").replace(/櫻/g,"桜").replace(/澤/g,"沢")
        .replace(/\s+/g," ").trim();
      const target=norm(pdfName);
      const candidates=role?staffList.filter(s=>s.role===role):staffList;
      // 完全一致 → 姓一致 → 部分一致 の優先度で検索
      return candidates.find(s=>norm(s.name)===target)
        || candidates.find(s=>{
          const surname=norm(s.name).split(/\s/)[0];
          return surname===target;
        })
        || candidates.find(s=>norm(s.name).includes(target)||target.includes(norm(s.name).split(/\s/)[0]))
        || null;
    }

    // シフトデータとの照合 + 衛生士自動振り分け
    function crossReference(parsed){
      if(!parsed||!parsed.date) return null;
      const [py,pm,pd]=parsed.date.split("-").map(Number);
      const pMonth=pm-1; // 0-indexed
      // この日のシフトデータ取得
      const dayShifts={};// staffId -> shiftType
      const activeStaff=staff.filter(s=>s.active);
      activeStaff.forEach(s=>{
        const key=`${s.id}_${pd}`;
        // 現在表示中の月と一致するか確認
        const sh=(py===year&&pMonth===month)?shifts[key]:null;
        if(sh) dayShifts[s.id]=sh;
      });
      // 出勤者リスト
      const workingStaff=activeStaff.filter(s=>{
        const st=dayShifts[s.id];
        return st&&st!=="休み"&&st!=="有給";
      });
      const workingDh=workingStaff.filter(s=>s.role==="Dh");
      const workingDr=workingStaff.filter(s=>s.role==="Dr");
      const workingDa=workingStaff.filter(s=>s.role==="Da");
      const workingUketsuke=workingStaff.filter(s=>s.role==="受付");
      // PDF内の指名済みDH一覧
      const assignedDhIds=new Set();
      const results=[];
      // まず指名付きを処理
      parsed.appointments.forEach(appt=>{
        appt.staff.forEach(sa=>{
          if(!sa.isAny){
            const matched=matchStaff(sa.name, sa.role, activeStaff);
            if(matched){
              assignedDhIds.add(matched.id);
              const shType=dayShifts[matched.id];
              const isOff=!shType||shType==="休み"||shType==="有給";
              results.push({
                ...appt, staffAssign:sa, matchedStaff:matched,
                conflict:isOff?"off_but_assigned":null,
                shiftType:shType||"未登録",
              });
            } else {
              results.push({...appt, staffAssign:sa, matchedStaff:null, conflict:"unmatched"});
            }
          }
        });
      });
      // 衛生士誰でも の振り分け（午前/午後のシフト制約を考慮）
      // 午前半休=午後から出勤、午後半休=午前のみ出勤
      const isAMTime=time=>{const h=parseInt((time||"").split(":")[0]);return !isNaN(h)&&h<12;};
      const canWorkAt=(staffId,time)=>{
        const sh=dayShifts[staffId];
        if(!sh||sh==="休み"||sh==="有給") return false;
        if(sh==="午後半休"&&!isAMTime(time)) return false; // 午前出→午後NG
        if(sh==="午前半休"&&isAMTime(time)) return false;  // 午後出→午前NG
        return true;
      };
      const availableDh=workingDh.filter(s=>!assignedDhIds.has(s.id));
      // 岡崎Dr がいる予約の「誰でも」枠にはDa谷を優先配置
      const normName=s=>(s||"").normalize("NFKC").replace(/﨑/g,"崎").replace(/\s+/g," ").trim();
      const taniDa=workingDa.find(s=>normName(s.name).includes("谷"));
      const anyAssignments=[];
      // 同一時間帯に岡崎/院長がいるかチェック（PDFの生テキストから直接検出）
      const hasOkazakiAt=(time)=>{
        return parsed.appointments.some(appt=>appt.time===time&&(
          appt.staff.some(sa=>sa.name==="院長"||normName(sa.name).includes("岡崎"))||
          appt.text.includes("岡崎")||appt.text.includes("岡﨑")||appt.text.includes("院長")
        ));
      };
      // まず岡崎/院長がいる時間帯の「誰でも」枠でDa谷を優先配置
      const taniAssignedTimes=new Set();
      if(taniDa){
        parsed.appointments.forEach(appt=>{
          appt.staff.forEach(sa=>{
            if(sa.isAny&&sa.role==="Dh"&&hasOkazakiAt(appt.time)&&!taniAssignedTimes.has(appt.time)
              &&canWorkAt(taniDa.id,appt.time)){
              taniAssignedTimes.add(appt.time);
              anyAssignments.push({
                ...appt, staffAssign:sa,
                matchedStaff:taniDa,
                autoAssigned:true, priorityNote:"岡崎Dr枠→Da谷 優先配置",
                conflict:null,
              });
            }
          });
        });
      }
      // 残りの「誰でも」枠を通常DH振り分け（時間帯に勤務可能なDHのみ）
      parsed.appointments.forEach(appt=>{
        appt.staff.forEach(sa=>{
          if(sa.isAny&&sa.role==="Dh"){
            // 既にDa谷で割り当て済みならスキップ
            if(taniAssignedTimes.has(appt.time)&&anyAssignments.some(a=>a.time===appt.time&&a.chair===appt.chair)) return;
            // この時間帯に勤務可能で、まだ割り当てられていないDHを探す
            const assigned=availableDh.find(s=>!assignedDhIds.has(s.id)&&canWorkAt(s.id,appt.time))||null;
            anyAssignments.push({
              ...appt, staffAssign:sa,
              matchedStaff:assigned,
              autoAssigned:true,
              conflict:assigned?null:"no_available_dh",
            });
            if(assigned) assignedDhIds.add(assigned.id);
          }
        });
      });
      // 未配置のDH（出勤しているが予約に出てこない）
      const unassignedDh=workingDh.filter(s=>!assignedDhIds.has(s.id));
      // チェア別データ構築（カラム表示用）
      const isDrChair=name=>/^Dr\./i.test(name);
      const chairMap={};
      parsed.chairs.forEach(ch=>{chairMap[ch]=[];});
      // Drチェア用: アシスト（DA/DH）自動振り分け
      const drAssistMap={};// key:"chair_time" -> staff
      const assignedAssistIds=new Set([...assignedDhIds]);
      // Drチェアの予約にアシストを自動配置（Da優先、次にDH）
      const availableAssist=[
        ...workingDa.filter(s=>!assignedAssistIds.has(s.id)),
        ...availableDh.filter(s=>!assignedAssistIds.has(s.id)),
      ];
      parsed.appointments.forEach(appt=>{
        if(!isDrChair(appt.chair)) return;
        const key=`${appt.chair}_${appt.time}`;
        // 岡崎/院長枠→Da谷優先
        const isOkazaki=appt.staff.some(sa=>sa.name==="院長"||normName(sa.name).includes("岡崎"))
          ||appt.text.includes("岡崎")||appt.text.includes("岡﨑")||appt.text.includes("院長");
        if(isOkazaki&&taniDa&&canWorkAt(taniDa.id,appt.time)&&!assignedAssistIds.has(taniDa.id)){
          drAssistMap[key]={staff:taniDa, note:"岡崎Dr枠→Da谷 優先"};
          assignedAssistIds.add(taniDa.id);
        } else {
          const ast=availableAssist.find(s=>!assignedAssistIds.has(s.id)&&canWorkAt(s.id,appt.time));
          if(ast){
            drAssistMap[key]={staff:ast, note:null};
            assignedAssistIds.add(ast.id);
          }
        }
      });
      // 全予約をチェアごとにグループ化し、割り当て結果を付与
      parsed.appointments.forEach(appt=>{
        if(!chairMap[appt.chair]) chairMap[appt.chair]=[];
        const named=results.find(r=>r.time===appt.time&&r.chair===appt.chair);
        const any=anyAssignments.find(a=>a.time===appt.time&&a.chair===appt.chair);
        const drAst=drAssistMap[`${appt.chair}_${appt.time}`];
        chairMap[appt.chair].push({
          ...appt,
          assignedStaff:named?.matchedStaff||any?.matchedStaff||null,
          assignedRole:named?.staffAssign?.role||any?.staffAssign?.role||null,
          priorityNote:any?.priorityNote||null,
          conflict:named?.conflict||any?.conflict||null,
          isAny:!!any,
          drStaff:appt.staff.find(s=>s.role==="Dr")||null,
          dhStaff:appt.staff.find(s=>s.role==="Dh")||null,
          drMatched:results.find(r=>r.time===appt.time&&r.chair===appt.chair&&r.staffAssign?.role==="Dr")?.matchedStaff||null,
          // アシスト: Drチェアは専用振り分け、それ以外は従来通り
          assistStaff:drAst?.staff||null,
          assistNote:drAst?.note||null,
          dhMatched:(results.find(r=>r.time===appt.time&&r.chair===appt.chair&&r.staffAssign?.role==="Dh")?.matchedStaff)
            ||(any?.matchedStaff)||null,
          dhPriorityNote:any?.priorityNote||null,
        });
      });
      return {
        date:parsed.date, notes:parsed.notes,
        workingStaff, workingDh, workingDr, workingDa, workingUketsuke,
        namedResults:results,
        anyAssignments,
        unassignedDh,
        totalAppts:parsed.appointments.length,
        conflicts:results.filter(r=>r.conflict),
        chairs:parsed.chairs, chairMap, isDrChair,
      };
    }

    async function handlePdfFile(file){
      if(!file||!file.name.match(/\.pdf$/i)){toast_("PDFファイルを選択してください");return;}
      try{
        const buf=await file.arrayBuffer();
        const items=await parsePdf(buf);
        const parsed=buildAppointments(items);
        if(!parsed||parsed.appointments.length===0){
          toast_("予約データを読み取れませんでした");return;
        }
        const result=crossReference(parsed);
        setApptData({parsed, result});
        toast_(`予約照合完了: ${parsed.appointments.length}件の予約を検出`);
      }catch(err){
        console.error(err);
        toast_("PDFの読み込みに失敗しました");
      }
    }

    const R=apptData?.result;
    // 午前/午後分類ヘルパー
    const isAM=time=>{const h=parseInt((time||"").split(":")[0]);return !isNaN(h)&&h<12;};
    const splitAMPM=list=>{
      const am=list.filter(a=>isAM(a.time));
      const pm=list.filter(a=>!isAM(a.time));
      return {am,pm};
    };

    return (
      <div>
        <div className="ph">
          <div className="ptitle">予約照合（チェア別予約一覧PDF）</div>
          {apptData&&<button className="cbtn" onClick={()=>{setApptData(null);setDrExtra({});}} style={{background:"#ef4444",color:"#fff"}}>クリア</button>}
        </div>

        {!apptData&&(
          <div className="kot-wrap">
            <div className="cpt">チェア別予約一覧のPDFをアップロード</div>
            <p style={{fontSize:13,color:"#64748b",margin:"8px 0 16px"}}>
              スタッフ配置システムから出力した「チェア別予約一覧」PDFを読み込み、
              シフトデータと照合します。「衛生士誰でも」枠には出勤中の衛生士を自動振り分けします。
            </p>
            <div
              className={`drop-zone ${apptDrag?"drag":""}`}
              onDragOver={e=>{e.preventDefault();setApptDrag(true);}}
              onDragLeave={()=>setApptDrag(false)}
              onDrop={e=>{e.preventDefault();setApptDrag(false);handlePdfFile(e.dataTransfer.files[0]);}}
              onClick={()=>document.getElementById("appt-file-input").click()}
            >
              <div className="dico">📄</div>
              <p>PDFファイルをここにドラッグ＆ドロップ</p>
              <small>またはクリックしてファイルを選択</small>
            </div>
            <input id="appt-file-input" type="file" accept=".pdf" style={{display:"none"}}
              onChange={e=>{handlePdfFile(e.target.files[0]);e.target.value="";}}/>
          </div>
        )}

        {R&&(
          <>
            {/* 日付・備考 */}
            <div className="kot-wrap" style={{marginBottom:12}}>
              <div style={{fontSize:18,fontWeight:900,marginBottom:4}}>{R.date} の予約照合結果</div>
              {R.notes&&<div style={{fontSize:13,color:"#64748b",background:"#f8fafc",padding:"6px 10px",borderRadius:6}}>{R.notes}</div>}
            </div>

            {/* サマリーカード */}
            {(()=>{
              const allAppts=apptData?.parsed?.appointments||[];
              const amCount=allAppts.filter(a=>isAM(a.time)).length;
              const pmCount=allAppts.filter(a=>!isAM(a.time)).length;
              return (
                <div className="sum-cards">
                  <div className="sum-card">
                    <div className="sum-val">{R.totalAppts}</div>
                    <div className="sum-lbl">予約件数</div>
                    <div style={{fontSize:11,color:"#64748b",marginTop:2}}>午前{amCount} / 午後{pmCount}</div>
                  </div>
                  <div className="sum-card">
                    <div className="sum-val">{R.workingStaff.length}</div>
                    <div className="sum-lbl">出勤者数</div>
                  </div>
                  <div className="sum-card">
                    <div className="sum-val" style={{color:"#1d4ed8"}}>{R.workingDh.length}</div>
                    <div className="sum-lbl">出勤DH</div>
                  </div>
                  <div className="sum-card">
                    <div className="sum-val" style={{color:R.conflicts.length>0?"#ef4444":"#16a34a"}}>{R.conflicts.length}</div>
                    <div className="sum-lbl">不整合</div>
                  </div>
                </div>
              );
            })()}

            {/* 出勤者一覧 */}
            <div className="kot-wrap" style={{marginBottom:12}}>
              <div className="cpt">出勤者一覧（シフトデータより）</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                {R.workingStaff.map(s=>(
                  <span key={s.id} style={{
                    display:"inline-block",padding:"3px 10px",borderRadius:12,fontSize:12,fontWeight:700,
                    background:ROLES[s.role]?.bg||"#f3f4f6", color:ROLES[s.role]?.color||"#333",
                    border:`1px solid ${ROLES[s.role]?.color||"#ccc"}30`,
                  }}>{ROLES[s.role]?.short||s.role} {s.name.split(" ")[0]}</span>
                ))}
              </div>
            </div>

            {/* 不整合アラート（上部に集約） */}
            {R.conflicts.length>0&&(
              <div className="kot-wrap" style={{marginBottom:12,borderLeft:"4px solid #ef4444"}}>
                <div className="cpt" style={{color:"#ef4444"}}>不整合検出（{R.conflicts.length}件）</div>
                {R.conflicts.map((c,i)=>(
                  <div key={i} style={{padding:"4px 0",borderBottom:"1px solid #fee2e2",fontSize:13}}>
                    {c.conflict==="off_but_assigned"&&(
                      <span><strong style={{color:"#ef4444"}}>{c.matchedStaff?.name}</strong> はシフト上「{c.shiftType}」ですが、{c.chair} {c.time} に配置</span>
                    )}
                    {c.conflict==="unmatched"&&(
                      <span style={{color:"#d97706"}}>「{c.staffAssign.raw}」該当スタッフなし（{c.chair} {c.time}）</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 未配置DH */}
            {R.unassignedDh.length>0&&(
              <div className="kot-wrap" style={{marginBottom:12,borderLeft:"4px solid #16a34a"}}>
                <div className="cpt" style={{color:"#16a34a"}}>未配置の出勤DH（フリー）</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>
                  {R.unassignedDh.map(s=>(
                    <span key={s.id} style={{
                      display:"inline-block",padding:"4px 12px",borderRadius:12,fontSize:13,fontWeight:700,
                      background:"#dcfce7",color:"#15803d",border:"1px solid #bbf7d0",
                    }}>{s.name}</span>
                  ))}
                </div>
              </div>
            )}

            {/* チェア別カラム表示（午前・午後） */}
            {R.chairs&&(()=>{
              const isDr=R.isDrChair;
              const renderPeriodChairs=(label,filterFn)=>{
                const color=label==="午前"?"#ea580c":"#7c3aed";
                const bg=label==="午前"?"#fff7ed":"#f5f3ff";
                // このピリオドに予約があるチェアのみ表示
                const activeChairs=R.chairs.filter(ch=>(R.chairMap[ch]||[]).some(a=>filterFn(a.time)));
                if(activeChairs.length===0) return null;
                return (
                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:16,fontWeight:900,color,marginBottom:8,padding:"4px 10px",background:bg,borderRadius:6,display:"inline-block"}}>{label}</div>
                    <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:8}}>
                      {activeChairs.map(ch=>{
                        const appts=(R.chairMap[ch]||[]).filter(a=>filterFn(a.time)).sort((a,b)=>{
                          const ta=a.time.split(":").map(Number),tb=b.time.split(":").map(Number);
                          return (ta[0]*60+ta[1])-(tb[0]*60+tb[1]);
                        });
                        const drChair=isDr(ch);
                        return (
                          <div key={ch} style={{
                            minWidth:drChair?130:110, maxWidth:drChair?155:135,
                            flex:"0 0 auto",
                            border:"1px solid #e2e8f0",borderRadius:8,background:"#fff",
                          }}>
                            {/* チェアヘッダー */}
                            <div style={{
                              padding:"4px 6px",background:drChair?"#fef2f2":"#f0f9ff",
                              borderBottom:"1px solid #e2e8f0",borderRadius:"8px 8px 0 0",
                              display:"flex",justifyContent:"space-between",alignItems:"center",
                            }}>
                              <span style={{fontSize:11,fontWeight:900,color:drChair?"#b91c1c":"#1e40af"}}>{ch}</span>
                              <span style={{fontSize:10,color:"#94a3b8"}}>{appts.length}件</span>
                            </div>
                            {/* 予約リスト */}
                            {appts.map((appt,ai)=>(
                              <div key={ai} style={{
                                padding:"4px 6px",borderBottom:"1px solid #f1f5f9",fontSize:11,
                              }}>
                                <div style={{fontWeight:700,color:"#334155",marginBottom:2}}>{appt.time}</div>
                                {appt.patientId&&<div style={{fontSize:10,color:"#94a3b8"}}>{appt.patientId}</div>}
                                {drChair?(
                                  <>
                                    {/* Dr選択枠 */}
                                    <div style={{marginTop:3}}>
                                      <div style={{fontSize:9,color:"#b91c1c",fontWeight:700}}>Dr</div>
                                      <select
                                        value={drExtra[`dr_${ch}_${appt.time}`]||(appt.drMatched?.id||appt.drStaff?.name||"")}
                                        onChange={e=>setDrExtra(prev=>({...prev,[`dr_${ch}_${appt.time}`]:e.target.value}))}
                                        style={{
                                          width:"100%",padding:"2px 2px",borderRadius:4,fontSize:10,fontWeight:700,
                                          border:"1px solid #d1d5db",
                                          background:drExtra[`dr_${ch}_${appt.time}`]||appt.drMatched||appt.drStaff?"#fee2e2":"#fff",
                                          color:drExtra[`dr_${ch}_${appt.time}`]||appt.drMatched||appt.drStaff?"#b91c1c":"#94a3b8",
                                          cursor:"pointer",
                                        }}
                                      >
                                        <option value="">— 選択 —</option>
                                        {appt.drStaff&&!appt.drMatched&&<option value={appt.drStaff.name}>{appt.drStaff.name}（PDF）</option>}
                                        {R.workingDr.map(s=>(
                                          <option key={s.id} value={s.id}>{s.name.split(" ")[0]}</option>
                                        ))}
                                      </select>
                                    </div>
                                    {/* アシスト選択枠 */}
                                    <div style={{marginTop:2}}>
                                      <div style={{fontSize:9,color:"#15803d",fontWeight:700}}>アシスト</div>
                                      <select
                                        value={drExtra[`ast_${ch}_${appt.time}`]||(appt.assistStaff?.id||"")}
                                        onChange={e=>setDrExtra(prev=>({...prev,[`ast_${ch}_${appt.time}`]:e.target.value}))}
                                        style={{
                                          width:"100%",padding:"2px 2px",borderRadius:4,fontSize:10,fontWeight:700,
                                          border:"1px solid #d1d5db",
                                          background:(()=>{
                                            const v=drExtra[`ast_${ch}_${appt.time}`]||appt.assistStaff?.id;
                                            if(!v) return "#fff";
                                            return appt.assistNote?"#fef3c7":"#dcfce7";
                                          })(),
                                          color:(()=>{
                                            const v=drExtra[`ast_${ch}_${appt.time}`]||appt.assistStaff?.id;
                                            if(!v) return "#94a3b8";
                                            return appt.assistNote?"#d97706":"#15803d";
                                          })(),
                                          cursor:"pointer",
                                        }}
                                      >
                                        <option value="">— 選択 —</option>
                                        {appt.assistStaff&&(
                                          <option value={appt.assistStaff.id}>
                                            {ROLES[appt.assistStaff.role]?.short||""} {appt.assistStaff.name.split(" ")[0]}{appt.assistNote?" ★":""}（自動）
                                          </option>
                                        )}
                                        {[...R.workingDa,...R.workingDh,...R.workingUketsuke].map(s=>(
                                          <option key={s.id} value={s.id}>{ROLES[s.role]?.short||s.role} {s.name.split(" ")[0]}</option>
                                        ))}
                                      </select>
                                    </div>
                                  </>
                                ):(
                                  /* メンテ・その他チェア: 担当1枠 */
                                  <div style={{marginTop:3}}>
                                    <div style={{
                                      padding:"2px 4px",borderRadius:4,fontSize:10,fontWeight:700,
                                      background:appt.assignedStaff?(appt.priorityNote?"#fef3c7":"#dbeafe"):(appt.conflict?"#fee2e2":"#f3f4f6"),
                                      color:appt.assignedStaff?(appt.priorityNote?"#d97706":"#1d4ed8"):(appt.conflict?"#ef4444":"#94a3b8"),
                                    }}>
                                      {appt.assignedStaff?(
                                        <>{appt.assignedStaff.name}{appt.priorityNote&&<span style={{fontSize:8}}> ★</span>}</>
                                      ):(
                                        appt.staff.length>0?appt.staff[0].raw:"—"
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              };
              return (
                <>
                  {renderPeriodChairs("午前",t=>isAM(t))}
                  {renderPeriodChairs("午後",t=>!isAM(t))}
                </>
              );
            })()}
          </>
        )}
      </div>
    );
  };

  // ── KOT TAB ────────────────────────────────
  const KotTab=()=>{
    const drag=kotDrag;

    // KING OF TIME CSVパーサー
    // KOTの月別勤怠CSVフォーマットに対応
    function parseKotCsv(text){
      const lines=text.split(/\r?\n/).filter(l=>l.trim());
      if(lines.length<2) return null;

      // ヘッダー行を探す（「従業員番号」or「氏名」or「日付」を含む行）
      let headerIdx=lines.findIndex(l=>l.includes("氏名")||l.includes("日付")||l.includes("出勤"));
      if(headerIdx<0) headerIdx=0;
      const headers=lines[headerIdx].split(",").map(h=>h.replace(/"/g,"").trim());

      const records=[];
      for(let i=headerIdx+1;i<lines.length;i++){
        const cols=lines[i].split(",").map(c=>c.replace(/"/g,"").trim());
        if(cols.every(c=>!c)) continue;
        const rec={};
        headers.forEach((h,idx)=>{ rec[h]=cols[idx]||""; });
        records.push(rec);
      }

      // カラム名の正規化（KOTのCSV出力形式に合わせる）
      const nameKey=headers.find(h=>h.includes("氏名")||h==="名前")||headers[1]||"";
      const dateKey=headers.find(h=>h.includes("日付")||h.includes("年月日"))||"";
      const inKey =headers.find(h=>h.includes("出勤時刻")||h.includes("出勤")&&h.includes("時"))||"";
      const outKey=headers.find(h=>h.includes("退勤時刻")||h.includes("退勤")&&h.includes("時"))||"";
      const workKey=headers.find(h=>h.includes("実労働")||h.includes("労働時間"))||"";
      const overtimeKey=headers.find(h=>h.includes("残業")||h.includes("時間外"))||"";
      const leaveKey=headers.find(h=>h.includes("有給")||h.includes("休暇種別"))||"";

      // スタッフ別に集計
      const byStaff={};
      records.forEach(r=>{
        const name=(r[nameKey]||"").trim();
        if(!name) return;
        if(!byStaff[name]) byStaff[name]={name,records:[],totalWork:0,overtime:0,lateCount:0,earlyCount:0,paidLeave:0};
        const rec={
          date:r[dateKey]||"",
          in:r[inKey]||"",
          out:r[outKey]||"",
          work:r[workKey]||"",
          overtime:r[overtimeKey]||"",
          leave:r[leaveKey]||"",
        };
        byStaff[name].records.push(rec);

        // 実労働時間集計
        if(rec.work){
          const [hh,mm]=(rec.work+":0").split(":").map(Number);
          byStaff[name].totalWork+=hh+(mm||0)/60;
        }
        // 残業時間集計
        if(rec.overtime){
          const [hh,mm]=(rec.overtime+":0").split(":").map(Number);
          byStaff[name].overtime+=hh+(mm||0)/60;
        }
        // 有給カウント
        if(rec.leave&&(rec.leave.includes("有給")||rec.leave.includes("年休"))) byStaff[name].paidLeave++;

        // 遅刻チェック（予定出勤8:45より10分以上遅い）
        if(rec.in){
          const [hh,mm]=rec.in.split(":").map(Number);
          const inMin=hh*60+mm;
          if(inMin>8*60+55) byStaff[name].lateCount++;
        }
        // 早退チェック（平日18:30より30分以上早い退勤）
        if(rec.out){
          const [hh,mm]=rec.out.split(":").map(Number);
          const outMin=hh*60+mm;
          const dow=rec.date?new Date(rec.date).getDay():1;
          const expectedEnd=dow===6?15*60+30:18*60+30;
          if(outMin<expectedEnd-30) byStaff[name].earlyCount++;
        }
      });

      return {byStaff,headers,nameKey,dateKey,inKey,outKey,workKey};
    }

    function handleFile(file){
      if(!file||!file.name.match(/\.csv$/i)){toast_("CSVファイルを選択してください");return;}
      const reader=new FileReader();
      reader.onload=e=>{
        try{
          const result=parseKotCsv(e.target.result);
          if(!result||Object.keys(result.byStaff).length===0){
            toast_("データを読み取れませんでした。KOTのCSV形式を確認してください");
            return;
          }
          setKotData(result);
          // 有給を自動反映
          let updated=0;
          Object.values(result.byStaff).forEach(ks=>{
            if(ks.paidLeave>0){
              const matched=staff.find(s=>s.name===ks.name||ks.name.includes(s.name.replace(" ",""))||s.name.includes(ks.name.replace(" ","")));
              if(matched){
                setStaff(ps=>ps.map(s=>s.id===matched.id?{...s,used:Math.min(s.leave,ks.paidLeave)}:s));
                updated++;
              }
            }
          });
          toast_(`✅ 打刻データを読み込みました${updated>0?`（有給${updated}名を自動反映）`:""}`);
        }catch(err){
          toast_("CSVの読み込みに失敗しました");
        }
      };
      reader.readAsText(file,"Shift_JIS");
    }

    const staffList=kotData?Object.values(kotData.byStaff):[];
    const totalOT=staffList.reduce((a,s)=>a+s.overtime,0);
    const lateTotal=staffList.reduce((a,s)=>a+s.lateCount,0);
    const earlyTotal=staffList.reduce((a,s)=>a+s.earlyCount,0);

    return (
      <div>
        <div className="ph">
          <div className="ptitle">KING OF TIME 打刻連携</div>
          {kotData&&<button className="cbtn" onClick={()=>setKotData(null)}>🗑 データをクリア</button>}
        </div>

        {/* 手順説明 */}
        <div className="kot-wrap">
          <div className="cpt">📋 KING OF TIMEからCSVをダウンロードする手順</div>
          <div className="kot-step">
            <div className="kot-num">1</div>
            <div className="kot-body">
              <h4>KING OF TIMEにログイン</h4>
              <p><a href="https://s2.ta.kingoftime.jp/admin" target="_blank" rel="noreferrer" style={{color:"#0f4c8a"}}>管理画面</a>を開く</p>
            </div>
          </div>
          <div className="kot-step">
            <div className="kot-num">2</div>
            <div className="kot-body">
              <h4>月別勤怠データを開く</h4>
              <p>「勤怠」→「月別勤怠」→ 対象月を選択</p>
            </div>
          </div>
          <div className="kot-step">
            <div className="kot-num">3</div>
            <div className="kot-body">
              <h4>CSVエクスポート</h4>
              <p>画面右上の「CSV出力」ボタンをクリック → <code>勤怠データ_YYYYMM.csv</code> をダウンロード</p>
            </div>
          </div>
          <div className="kot-step" style={{marginBottom:0}}>
            <div className="kot-num">4</div>
            <div className="kot-body">
              <h4>下のエリアにアップロード</h4>
              <p>ダウンロードしたCSVファイルをドラッグ＆ドロップ、またはクリックして選択</p>
            </div>
          </div>
        </div>

        {/* ドロップゾーン */}
        {!kotData&&(
          <div className="kot-wrap">
            <div
              className={`drop-zone ${drag?"drag":""}`}
              onDragOver={e=>{e.preventDefault();setKotDrag(true);}}
              onDragLeave={()=>setKotDrag(false)}
              onDrop={e=>{e.preventDefault();setKotDrag(false);handleFile(e.dataTransfer.files[0]);}}
              onClick={()=>document.getElementById("kot-file-input").click()}
            >
              <div className="dico">📂</div>
              <p>CSVファイルをここにドラッグ＆ドロップ</p>
              <small>またはクリックしてファイルを選択（Shift_JIS / UTF-8 対応）</small>
            </div>
            <input id="kot-file-input" type="file" accept=".csv" style={{display:"none"}}
              onChange={e=>handleFile(e.target.files[0])}/>
          </div>
        )}

        {/* 結果表示 */}
        {kotData&&(
          <>
            {/* サマリーカード */}
            <div className="sum-cards">
              <div className="sum-card">
                <div className="sv" style={{color:"#0f4c8a"}}>{staffList.length}<small style={{fontSize:12,fontWeight:400}}> 名</small></div>
                <div className="sl">読み込んだスタッフ数</div>
              </div>
              <div className="sum-card">
                <div className="sv" style={{color:"#dc2626"}}>{lateTotal}<small style={{fontSize:12,fontWeight:400}}> 件</small></div>
                <div className="sl">遅刻（8:55以降出勤）</div>
              </div>
              <div className="sum-card">
                <div className="sv" style={{color:"#d97706"}}>{earlyTotal}<small style={{fontSize:12,fontWeight:400}}> 件</small></div>
                <div className="sl">早退（30分以上早い退勤）</div>
              </div>
              <div className="sum-card">
                <div className="sv" style={{color:"#7c3aed"}}>{Math.round(totalOT*10)/10}<small style={{fontSize:12,fontWeight:400}}> h</small></div>
                <div className="sl">月間残業時間合計</div>
              </div>
            </div>

            {/* スタッフ別一覧 */}
            <div className="kot-result">
              <table className="kot-tbl">
                <thead>
                  <tr>
                    <th>氏名</th>
                    <th>実労働時間</th>
                    <th>予定時間(月標準)</th>
                    <th>差異</th>
                    <th>残業</th>
                    <th>遅刻</th>
                    <th>早退</th>
                    <th>有給取得</th>
                    <th>有給反映</th>
                  </tr>
                </thead>
                <tbody>
                  {staffList.map((ks,i)=>{
                    const matched=staff.find(s=>s.name===ks.name||ks.name.replace(/\s/g,"")===s.name.replace(/\s/g,""));
                    const diff=matched?Math.round((ks.totalWork-stdH)*10)/10:null;
                    return (
                      <tr key={i}>
                        <td style={{fontWeight:700}}>
                          {ks.name}
                          {matched
                            ?<span style={{marginLeft:4,fontSize:9,background:ROLES[matched.role]?.bg,color:ROLES[matched.role]?.color,padding:"1px 5px",borderRadius:6,fontWeight:800}}>{matched.role}</span>
                            :<span style={{marginLeft:4,fontSize:9,background:"#fee2e2",color:"#dc2626",padding:"1px 5px",borderRadius:6,fontWeight:800}}>未照合</span>
                          }
                        </td>
                        <td><span className="hcol" style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700}}>{Math.round(ks.totalWork*10)/10}h</span></td>
                        <td style={{color:"var(--mut)",fontFamily:"JetBrains Mono,monospace"}}>{stdH}h</td>
                        <td>
                          {diff!==null&&(
                            <span className={diff>0?"diff-over":diff<-8?"diff-early":"diff-ok"}>
                              {diff>0?"+":""}{diff}h
                            </span>
                          )}
                        </td>
                        <td><span className="diff-over">{Math.round(ks.overtime*10)/10}h</span></td>
                        <td>
                          {ks.lateCount>0
                            ?<span className="diff-badge" style={{background:"#fee2e2",color:"#dc2626"}}>{ks.lateCount}回</span>
                            :<span style={{color:"#94a3b8",fontSize:10}}>なし</span>}
                        </td>
                        <td>
                          {ks.earlyCount>0
                            ?<span className="diff-badge" style={{background:"#fef3c7",color:"#b45309"}}>{ks.earlyCount}回</span>
                            :<span style={{color:"#94a3b8",fontSize:10}}>なし</span>}
                        </td>
                        <td style={{fontFamily:"JetBrains Mono,monospace",fontWeight:700,color:"#d97706"}}>{ks.paidLeave}日</td>
                        <td>
                          {matched&&ks.paidLeave>0?(
                            <button className="pa g" onClick={()=>{
                              setStaff(ps=>ps.map(s=>s.id===matched.id?{...s,used:Math.min(s.leave,ks.paidLeave)}:s));
                              toast_(`${ks.name} の有給を${ks.paidLeave}日に更新しました`);
                            }}>反映</button>
                          ):<span style={{color:"#94a3b8",fontSize:10}}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 日別詳細（アコーディオン） */}
            <div style={{marginTop:14}}>
              <div className="sdiv">スタッフ別 日次詳細</div>
              {staffList.map((ks,i)=>{
                const matched=staff.find(s=>s.name===ks.name||ks.name.replace(/\s/g,"")===s.name.replace(/\s/g,""));
                const rv=matched?ROLES[matched.role]:null;
                return (
                  <details key={i} style={{marginBottom:6,background:"var(--surf)",borderRadius:8,border:"1px solid var(--bdr)"}}>
                    <summary style={{padding:"10px 14px",cursor:"pointer",fontWeight:700,fontSize:12,listStyle:"none",display:"flex",alignItems:"center",gap:8}}>
                      <span>{ks.name}</span>
                      {rv&&<span style={{background:rv.bg,color:rv.color,fontSize:8,padding:"1px 5px",borderRadius:6,fontWeight:800}}>{matched.role}</span>}
                      <span style={{marginLeft:"auto",fontSize:10,color:"var(--mut)"}}>実労働 {Math.round(ks.totalWork*10)/10}h ／ 残業 {Math.round(ks.overtime*10)/10}h ／ 遅刻 {ks.lateCount}回</span>
                    </summary>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                      <thead>
                        <tr style={{background:"#f7f9fc"}}>
                          <th style={{padding:"5px 10px",textAlign:"left",fontSize:9,fontWeight:800,color:"var(--mut)"}}>日付</th>
                          <th style={{padding:"5px 10px",fontSize:9,fontWeight:800,color:"var(--mut)"}}>出勤</th>
                          <th style={{padding:"5px 10px",fontSize:9,fontWeight:800,color:"var(--mut)"}}>退勤</th>
                          <th style={{padding:"5px 10px",fontSize:9,fontWeight:800,color:"var(--mut)"}}>実労働</th>
                          <th style={{padding:"5px 10px",fontSize:9,fontWeight:800,color:"var(--mut)"}}>残業</th>
                          <th style={{padding:"5px 10px",fontSize:9,fontWeight:800,color:"var(--mut)"}}>備考</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ks.records.map((r,j)=>{
                          const inMin=r.in?r.in.split(":").reduce((a,v,i)=>a+(i===0?Number(v)*60:Number(v)),0):0;
                          const isLate=r.in&&inMin>8*60+55;
                          const outMin=r.out?r.out.split(":").reduce((a,v,i)=>a+(i===0?Number(v)*60:Number(v)),0):0;
                          const isEarly=r.out&&outMin<18*60;
                          return (
                            <tr key={j} style={{borderBottom:"1px solid #f1f5f9"}}>
                              <td style={{padding:"5px 10px",fontWeight:600}}>{r.date}</td>
                              <td style={{padding:"5px 10px",textAlign:"center",color:isLate?"#dc2626":"var(--txt)",fontWeight:isLate?700:400,fontFamily:"JetBrains Mono,monospace"}}>{r.in||"—"}</td>
                              <td style={{padding:"5px 10px",textAlign:"center",color:isEarly?"#d97706":"var(--txt)",fontFamily:"JetBrains Mono,monospace"}}>{r.out||"—"}</td>
                              <td style={{padding:"5px 10px",textAlign:"center",fontFamily:"JetBrains Mono,monospace"}}>{r.work||"—"}</td>
                              <td style={{padding:"5px 10px",textAlign:"center",color:"#7c3aed",fontFamily:"JetBrains Mono,monospace"}}>{r.overtime||"—"}</td>
                              <td style={{padding:"5px 10px"}}>
                                {r.leave&&<span className="diff-badge" style={{background:"#fef3c7",color:"#b45309"}}>{r.leave}</span>}
                                {isLate&&<span className="diff-badge" style={{background:"#fee2e2",color:"#dc2626"}}>遅刻</span>}
                                {isEarly&&!r.leave&&<span className="diff-badge" style={{background:"#fffbeb",color:"#d97706"}}>早退</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </details>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  };

  const aTabs=[
    {id:"shift",label:"シフト表"},
    {id:"kyosei",label:"矯正日"},
    {id:"flex",label:"変形労働時間"},
    {id:"paid",label:"有給管理"},
    {id:"appt",label:"予約照合"},
    {id:"kot",label:"KOT打刻連携"},
    {id:"wish",label:"希望確認"},
    {id:"staff",label:"スタッフ管理"},
  ];
  const sTabs=[{id:"shift",label:"シフト確認"},{id:"paid",label:"有給残日数"},{id:"wish",label:"希望提出"}];
  const navTabs=isA?aTabs:sTabs;

  return (
    <>
      <style>{CSS}</style>
      <div>
        <header className="hdr">
          <div className="hlogo">🦷 <em>Dental</em>Shift<span style={{color:"rgba(255,255,255,.2)",fontSize:9,fontWeight:400,marginLeft:2}}>PRO</span></div>
          <nav className="hnav">
            {navTabs.map(t=>(
              <button key={t.id} className={`hnb ${tab===t.id?"on":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>
            ))}
          </nav>
          <div className="hr">
            {pendingSaves>0
              ? <span style={{fontSize:9,color:"#fcd34d"}}>💾 保存中…</span>
              : !staffSynced
                ? <span style={{fontSize:9,color:"rgba(255,255,255,.5)"}}>☁ 同期中…</span>
                : <span style={{fontSize:9,color:"rgba(255,255,255,.4)"}}>☁ 保存済</span>
            }
            {isA&&alerts.length>0&&<span className="halert red" onClick={()=>setTab("shift")}>⚠ 不足{alerts.length}件</span>}
            {isA&&overAlerts.length>0&&<span className="halert ora" onClick={()=>setTab("flex")}>🕐 超過{overAlerts.length}名</span>}
            <span style={{color:"rgba(255,255,255,.6)",fontSize:11}}>{user.name}</span>
            <span className="hbadge">{isA?"管理者":"スタッフ"}</span>
            <button className="hbtn" onClick={()=>setUser(null)}>ログアウト</button>
          </div>
        </header>
        <main className="main">
          {tab==="shift"  && ShiftTab()}
          {tab==="kyosei" && isA && KyoseiTab()}
          {tab==="flex"   && isA && FlexTab()}
          {tab==="paid"   && PaidTab()}
          {tab==="appt"   && isA && ApptTab()}
          {tab==="kot"    && isA && KotTab()}
          {tab==="wish"   && WishTab()}
          {tab==="staff"  && isA && StaffTab()}
        </main>

        {/* 右クリックコンテキストメニュー */}
        {ctxMenu&&(()=>{
          const s=staff.find(st=>st.id===ctxMenu.staffId);
          if(!s) return null;
          const DAYS_JP2=["日","月","火","水","木","金","土"];
          // 当月の全営業日を集める（日曜・院内休診除く）
          const entries=[];
          for(let d=1;d<=D;d++){
            const dow=new Date(year,month,d).getDay();
            if(dow===0||isClinicHoliday(year,month,d)) continue;
            const sh=shifts[`${s.id}_${d}`]||null;
            entries.push({d,dow,sh});
          }
          const workDays=entries.filter(e=>e.sh&&e.sh!=="休み"&&e.sh!=="有給");
          const restDays=entries.filter(e=>e.sh==="休み"||e.sh==="有給");
          const noShift=entries.filter(e=>!e.sh);

          // メニューが画面からはみ出さないよう位置調整
          const menuW=220, menuH=Math.min(400, 80+entries.length*18);
          const x=Math.min(ctxMenu.x, window.innerWidth-menuW-8);
          const y=Math.min(ctxMenu.y, window.innerHeight-menuH-8);

          return (
            <div style={{position:"fixed",inset:0,zIndex:2000}} onClick={()=>setCtxMenu(null)} onContextMenu={e=>{e.preventDefault();setCtxMenu(null);}}>
              <div style={{position:"absolute",left:x,top:y,width:menuW,
                background:"#fff",borderRadius:12,boxShadow:"0 8px 32px rgba(0,0,0,.18)",
                border:"1px solid #e2e8f0",overflow:"hidden",fontSize:11}}
                onClick={e=>e.stopPropagation()}>
                {/* ヘッダー */}
                <div style={{padding:"10px 14px",background:"#0f4c8a",color:"#fff"}}>
                  <div style={{fontWeight:800,fontSize:13}}>{s.name}</div>
                  <div style={{fontSize:9,opacity:.8,marginTop:2}}>
                    {year}/{month+1}月 — 出勤{workDays.length}日 / 休み{restDays.length}日
                  </div>
                </div>
                {/* 一覧 */}
                <div style={{maxHeight:320,overflowY:"auto",padding:"6px 0"}}>
                  {entries.map(({d,dow,sh})=>{
                    const isSun=dow===0;
                    const label=sh?SHIFT_TYPES[sh]?.label??sh:null;
                    const isRest=sh==="休み";
                    const isPaid=sh==="有給";
                    const isWork=sh&&!isRest&&!isPaid;
                    const dotColor=isPaid?"#d97706":isRest?"#9ca3af":isWork?"#1d4ed8":"#e2e8f0";
                    return (
                      <div key={d} style={{display:"flex",alignItems:"center",gap:8,
                        padding:"3px 14px",
                        background:isPaid?"#fffbeb":isRest?"#f9fafb":"transparent"}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:dotColor,flexShrink:0,display:"inline-block"}}/>
                        <span style={{color:"#64748b",minWidth:52,fontFamily:"JetBrains Mono,monospace",fontSize:10}}>
                          {month+1}/{d}（{DAYS_JP2[dow]}）
                        </span>
                        <span style={{fontWeight:700,color:isPaid?"#d97706":isRest?"#9ca3af":isWork?"#1d4ed8":"#cbd5e1",fontSize:10}}>
                          {isPaid?"有給":isRest?"休み":label??"—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div style={{padding:"6px 14px",borderTop:"1px solid #e2e8f0",textAlign:"right"}}>
                  <button onClick={()=>setCtxMenu(null)}
                    style={{fontSize:10,padding:"3px 10px",borderRadius:6,border:"1px solid #e2e8f0",
                      background:"#f8fafc",cursor:"pointer",fontFamily:"inherit"}}>閉じる</button>
                </div>
              </div>
            </div>
          );
        })()}

        {modal&&isA&&(
          <div className="ov" onClick={()=>setModal(null)}>
            <div className="modal" onClick={e=>e.stopPropagation()}>
              <h3>{modal.staffName}</h3>
              <p>
                {modal.year||year}年{(modal.month??month)+1}月{modal.day}日（{DAYS_JP[new Date(modal.year||year,modal.month??month,modal.day).getDay()]}）
                {isClinicHoliday(modal.year||year,modal.month??month,modal.day)&&" 🎌祝日"}
                {(modal.month??month)===month&&kyoseiDays[modal.day]&&` 🦷${kyoseiDays[modal.day].label}矯正日`}
              </p>
              {/* 同日の休み・有給人数を表示 */}
              {(()=>{
                const d=modal.day; const m=modal.month??month; const y=modal.year||year;
                const restPeople=staff.filter(s=>s.active&&s.id!==modal.staffId&&
                  (shifts[`${s.id}_${d}`]==="休み"||shifts[`${s.id}_${d}`]==="有給")
                );
                if(restPeople.length===0) return null;
                return (
                  <div style={{fontSize:10,color:"#b45309",background:"#fef3c7",borderRadius:6,
                    padding:"4px 8px",marginBottom:8,fontWeight:600}}>
                    ⚠️ 同日休み中：{restPeople.map(s=>s.name).join("、")}（{restPeople.length}人）
                  </div>
                );
              })()}
              <div className="mbtns">
                {Object.entries(SHIFT_TYPES).map(([k,v])=>(
                  <button key={k} className="mbtn" style={{borderColor:v.color,color:v.color}}
                    onClick={()=>applyShift(modal.staffId,modal.day,k,modal.year||year,modal.month??month)}>
                    {v.label}{v.hours>0&&<small>{v.hours}h</small>}
                  </button>
                ))}
              </div>
              <button className="mclr" onClick={()=>applyShift(modal.staffId,modal.day,null,modal.year||year,modal.month??month)}>シフトをクリア</button>
              <button className="mcan" onClick={()=>setModal(null)}>キャンセル</button>
            </div>
          </div>
        )}

        {wModal&&!isA&&(
          <div className="ov" onClick={()=>setWModal(null)}>
            <div className="modal" onClick={e=>e.stopPropagation()}>
              <h3>{month+1}月{wModal.day}日の希望シフト</h3>
              <p>{DAYS_JP[new Date(year,month,wModal.day).getDay()]}曜日{kyoseiDays[wModal.day]&&` ／ ${kyoseiDays[wModal.day].label}矯正日`}</p>
              <div className="mbtns">
                {[
                  {k:"有給",     label:"有給（全日）",   color:"#d97706"},
                  {k:"午前半休", label:"午前休希望",     color:"#c2410c"},
                  {k:"午後半休", label:"午後休希望",     color:"#a16207"},
                ].map(({k,label,color})=>(
                  <button key={k} className="mbtn" style={{borderColor:color,color}}
                    onClick={()=>{
                      setWishes(p=>{const n={...p};n[`${wModal.staffId}_${wModal.day}`]=k;return n;});
                      setWModal(null);toast_("希望シフトを入力しました");
                    }}>
                    {label}
                  </button>
                ))}
              </div>
              <button className="mclr" onClick={()=>{setWishes(p=>{const n={...p};delete n[`${wModal.staffId}_${wModal.day}`];return n;});setWModal(null);}}>クリア</button>
              <button className="mcan" onClick={()=>setWModal(null)}>キャンセル</button>
            </div>
          </div>
        )}

        {toast&&<div className="toast">✓ {toast}</div>}

        {/* スマホ用下部タブバー */}
        <nav className="mob-nav">
          {navTabs.map(t=>(
            <button key={t.id} className={tab===t.id?"on":""} onClick={()=>setTab(t.id)}>
              <span>{t.id==="shift"?"📅":t.id==="kyosei"?"🦷":t.id==="flex"?"🕐":t.id==="paid"?"📋":t.id==="wish"?"💬":"👥"}</span>
              {t.label.length>4?t.label.slice(0,4)+"…":t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* セミナーモーダル */}
      {semModal&&isA&&(()=>{
        const isEdit=semModal!=="add";
        const existing=isEdit?seminars.find(s=>s.id===semModal):null;
        const initDate=existing?.date||(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;})();
        let formData={
          name: existing?.name||"",
          date: existing?.date||initDate,
          start: existing?.start||"09:00",
          end: existing?.end||"18:30",
          staffIds: existing?.staffIds||[],
        };
        const save=()=>{
          const fd=document.getElementById("sem-form");
          const name=fd.querySelector("#sem-name").value.trim();
          const date=fd.querySelector("#sem-date").value;
          const start=fd.querySelector("#sem-start").value;
          const end=fd.querySelector("#sem-end").value;
          const staffIds=[...fd.querySelectorAll(".sem-staff-btn.on")].map(b=>Number(b.dataset.id));
          if(!name){toast_("セミナー名を入力してください");return;}
          if(!date){toast_("日付を入力してください");return;}
          if(staffIds.length===0){toast_("参加スタッフを選択してください");return;}
          if(isEdit){
            setSeminars(ps=>ps.map(s=>s.id===semModal?{...s,name,date,start,end,staffIds}:s));
            toast_("セミナーを更新しました");
          } else {
            setSeminars(ps=>[...ps,{id:Date.now(),name,date,start,end,staffIds}]);
            toast_("セミナーを追加しました");
          }
          setSemModal(null);
        };
        return (
          <div className="sem-modal-ov" onClick={()=>setSemModal(null)}>
            <div className="sem-modal" onClick={e=>e.stopPropagation()}>
              <h3>🎓 {isEdit?"セミナー編集":"セミナー追加"}</h3>
              <div className="sem-form" id="sem-form">
                <div>
                  <label>セミナー名</label>
                  <input id="sem-name" defaultValue={existing?.name||""} placeholder="例：衛生士スキルアップ研修"/>
                </div>
                <div className="sem-row">
                  <div>
                    <label>日付</label>
                    <input id="sem-date" type="date" defaultValue={existing?.date||initDate}/>
                  </div>
                  <div>
                    <label>開始時間</label>
                    <input id="sem-start" type="time" defaultValue={existing?.start||"09:00"}/>
                  </div>
                  <div>
                    <label>終了時間</label>
                    <input id="sem-end" type="time" defaultValue={existing?.end||"18:30"}/>
                  </div>
                </div>
                <div>
                  <label>参加スタッフ（複数選択可）</label>
                  <div className="sem-staff-grid">
                    {staff.filter(s=>s.active).map(s=>{
                      const on=(existing?.staffIds||[]).includes(s.id);
                      const rv=ROLES[s.role];
                      return (
                        <button key={s.id} type="button" data-id={s.id}
                          className={`sem-staff-btn ${on?"on":""}`}
                          onClick={e=>{e.currentTarget.classList.toggle("on");}}>
                          <span style={{fontSize:8,marginRight:3,background:rv.bg,color:rv.color,padding:"0 3px",borderRadius:3,fontWeight:800}}>{s.role}</span>
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
                  <button className="mcan" onClick={()=>setSemModal(null)}>キャンセル</button>
                  <button className="svbtn" onClick={save}>{isEdit?"更新":"追加"}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ミーティングモーダル */}
      {mtgModal&&isA&&(()=>{
        const isEdit=mtgModal!=="add";
        const existing=isEdit?meetings.find(s=>s.id===mtgModal):null;
        const initDate=existing?.date||(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;})();
        const save=()=>{
          const fd=document.getElementById("mtg-form");
          const name=fd.querySelector("#mtg-name").value.trim()||"院内ミーティング";
          const date=fd.querySelector("#mtg-date").value;
          const start=fd.querySelector("#mtg-start").value;
          const end=fd.querySelector("#mtg-end").value;
          const staffIds=[...fd.querySelectorAll(".mtg-staff-btn.on")].map(b=>Number(b.dataset.id));
          if(!date){toast_("日付を入力してください");return;}
          if(staffIds.length===0){toast_("参加スタッフを選択してください");return;}
          if(isEdit){
            setMeetings(ps=>ps.map(s=>s.id===mtgModal?{...s,name,date,start,end,staffIds}:s));
            toast_("ミーティングを更新しました");
          } else {
            setMeetings(ps=>[...ps,{id:Date.now(),name,date,start,end,staffIds}]);
            toast_("ミーティングを追加しました");
          }
          setMtgModal(null);
        };
        return (
          <div className="sem-modal-ov" onClick={()=>setMtgModal(null)}>
            <div className="sem-modal" onClick={e=>e.stopPropagation()}>
              <h3>🏥 {isEdit?"ミーティング編集":"ミーティング追加"}</h3>
              <div className="sem-form" id="mtg-form">
                <div>
                  <label>ミーティング名</label>
                  <input id="mtg-name" defaultValue={existing?.name||"院内ミーティング"} placeholder="例：院内ミーティング"/>
                </div>
                <div className="sem-row">
                  <div>
                    <label>日付</label>
                    <input id="mtg-date" type="date" defaultValue={existing?.date||initDate}/>
                  </div>
                  <div>
                    <label>開始時間</label>
                    <input id="mtg-start" type="time" defaultValue={existing?.start||"13:00"}/>
                  </div>
                  <div>
                    <label>終了時間</label>
                    <input id="mtg-end" type="time" defaultValue={existing?.end||"14:00"}/>
                  </div>
                </div>
                <div>
                  <label>参加スタッフ（複数選択可）</label>
                  <div className="sem-staff-grid">
                    {staff.filter(s=>s.active).map(s=>{
                      const on=(existing?.staffIds||[]).includes(s.id);
                      const rv=ROLES[s.role];
                      return (
                        <button key={s.id} type="button" data-id={s.id}
                          className={`mtg-staff-btn sem-staff-btn ${on?"on":""}`}
                          onClick={e=>{e.currentTarget.classList.toggle("on");}}>
                          <span style={{fontSize:8,marginRight:3,background:rv.bg,color:rv.color,padding:"0 3px",borderRadius:3,fontWeight:800}}>{s.role}</span>
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
                  <button className="mcan" onClick={()=>setMtgModal(null)}>キャンセル</button>
                  <button className="svbtn" onClick={save}>{isEdit?"更新":"追加"}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ID・PIN設定モーダル */}
      {idModal&&isA&&(()=>{
        const s=staff.find(st=>st.id===idModal);
        if(!s) return null;
        let newId=s.loginId||"";
        let newPin="";
        let newPin2="";
        return (
          <div className="sem-modal-ov" onClick={()=>setIdModal(null)}>
            <div className="sem-modal" onClick={e=>e.stopPropagation()} style={{maxWidth:360}}>
              <h3 style={{color:"#1d4ed8"}}>🪪 ID・PIN設定</h3>
              <div style={{fontSize:12,color:"var(--mut)",marginBottom:14,fontWeight:600}}>{s.name}（{ROLES[s.role]?.label}）</div>
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* ログインID */}
                <div>
                  <label style={{fontSize:10,fontWeight:800,color:"var(--mut)",display:"block",marginBottom:4}}>
                    ログインID <span style={{fontSize:9,fontWeight:400}}>(半角英数字・記号)</span>
                  </label>
                  <input id="id-input" defaultValue={s.loginId||""} placeholder="例: yamada.hanako"
                    style={{width:"100%",padding:"8px 10px",border:"1.5px solid #bfdbfe",borderRadius:8,
                      fontSize:14,fontFamily:"inherit",letterSpacing:1}}/>
                  {s.loginId&&<div style={{fontSize:9,color:"#64748b",marginTop:3}}>現在: {s.loginId}</div>}
                </div>
                {/* PIN */}
                <div>
                  <label style={{fontSize:10,fontWeight:800,color:"var(--mut)",display:"block",marginBottom:4}}>
                    新しいPIN（4桁） <span style={{fontSize:9,fontWeight:400}}>{s.pin?"※空欄なら変更なし":""}</span>
                  </label>
                  <div style={{display:"flex",gap:8}}>
                    <input id="pin-input" type="password" maxLength={4} placeholder="新PIN" inputMode="numeric"
                      style={{width:"50%",padding:"8px 10px",border:"1.5px solid #bfdbfe",borderRadius:8,
                        fontSize:18,fontFamily:"monospace",letterSpacing:4,textAlign:"center"}}/>
                    <input id="pin-input2" type="password" maxLength={4} placeholder="確認" inputMode="numeric"
                      style={{width:"50%",padding:"8px 10px",border:"1.5px solid #bfdbfe",borderRadius:8,
                        fontSize:18,fontFamily:"monospace",letterSpacing:4,textAlign:"center"}}/>
                  </div>
                  {s.pin&&<div style={{fontSize:9,color:"#64748b",marginTop:3}}>現在: 設定済み ●●●●</div>}
                </div>
                {/* 保存 */}
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
                  <button className="mcan" onClick={()=>setIdModal(null)}>キャンセル</button>
                  <button className="svbtn" onClick={()=>{
                    const loginId=document.getElementById("id-input").value.trim();
                    const pin1=document.getElementById("pin-input").value;
                    const pin2=document.getElementById("pin-input2").value;
                    if(!loginId){toast_("IDを入力してください");return;}
                    if(staff.some(st=>st.id!==s.id&&st.loginId===loginId)){toast_("このIDは既に使われています");return;}
                    if(pin1||pin2){
                      if(!/^\d{4}$/.test(pin1)){toast_("PINは4桁の数字で入力してください");return;}
                      if(pin1!==pin2){toast_("PINが一致しません");return;}
                      setStaff(ps=>ps.map(st=>st.id===s.id?{...st,loginId,pin:pin1}:st));
                    } else {
                      setStaff(ps=>ps.map(st=>st.id===s.id?{...st,loginId}:st));
                    }
                    toast_(`${s.name} のID・PINを設定しました`);
                    setIdModal(null);
                  }}>保存</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 訪問モーダル */}
      {visitModal&&isA&&(()=>{
        const isEdit=visitModal!=="add";
        const existing=isEdit?visits.find(v=>v.id===visitModal):null;
        const initDate=existing?.date||(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;})();
        const save=()=>{
          const fd=document.getElementById("visit-form");
          const name=fd.querySelector("#visit-name").value.trim();
          const date=fd.querySelector("#visit-date").value;
          const start=fd.querySelector("#visit-start").value;
          const end=fd.querySelector("#visit-end").value;
          const breakMin=Number(fd.querySelector("#visit-break").value)||0;
          const staffIds=[...fd.querySelectorAll(".visit-staff-btn.on")].map(b=>Number(b.dataset.id));
          if(!date){toast_("日付を入力してください");return;}
          if(staffIds.length===0){toast_("参加スタッフを選択してください");return;}
          const entry={id:isEdit?visitModal:Date.now(),name:name||"訪問",date,start,end,breakMin,staffIds};
          if(isEdit) setVisits(ps=>ps.map(v=>v.id===visitModal?entry:v));
          else setVisits(ps=>[...ps,entry]);
          toast_(isEdit?"訪問を更新しました":"訪問を追加しました");
          setVisitModal(null);
        };
        return (
          <div className="sem-modal-ov" onClick={()=>setVisitModal(null)}>
            <div className="sem-modal" onClick={e=>e.stopPropagation()}>
              <h3>🏠 {isEdit?"訪問編集":"訪問追加"}</h3>
              <div className="sem-form" id="visit-form">
                <div>
                  <label>訪問名（任意）</label>
                  <input id="visit-name" defaultValue={existing?.name||""} placeholder="例：○○老健"/>
                </div>
                <div className="sem-row">
                  <div>
                    <label>日付</label>
                    <input id="visit-date" type="date" defaultValue={existing?.date||initDate}/>
                  </div>
                  <div>
                    <label>開始時間</label>
                    <input id="visit-start" type="time" defaultValue={existing?.start||"09:00"}/>
                  </div>
                  <div>
                    <label>終了時間</label>
                    <input id="visit-end" type="time" defaultValue={existing?.end||"16:00"}/>
                  </div>
                  <div>
                    <label>休憩(分)</label>
                    <input id="visit-break" type="number" min="0" max="120" step="15" defaultValue={existing?.breakMin||60} style={{width:60}}/>
                  </div>
                </div>
                <div>
                  <label>参加スタッフ（Dr・Dhのみ）</label>
                  <div className="sem-staff-grid">
                    {staff.filter(s=>s.active&&(s.role==="Dr"||s.role==="Dh")).map(s=>{
                      const on=(existing?.staffIds||[]).includes(s.id);
                      const rv=ROLES[s.role];
                      return (
                        <button key={s.id} type="button" data-id={s.id}
                          className={`visit-staff-btn sem-staff-btn ${on?"on":""}`}
                          onClick={e=>e.currentTarget.classList.toggle("on")}>
                          <span style={{fontSize:8,marginRight:3,background:rv.bg,color:rv.color,padding:"0 3px",borderRadius:3,fontWeight:800}}>{s.role}</span>
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
                  <button className="mcan" onClick={()=>setVisitModal(null)}>キャンセル</button>
                  <button className="svbtn" style={{background:"#0369a1"}} onClick={save}>{isEdit?"更新":"追加"}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

// ═══════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════
function LoginScreen({onLogin,staff}){
  const [role,setRole]=useState("admin");
  const [loginId,setLoginId]=useState("");
  const [pin,setPin]=useState("");
  const [err,setErr]=useState("");

  function go(){
    setErr("");
    if(role==="admin"){
      if(pin==="admin123") onLogin({role:"admin",name:"院長・管理者"});
      else setErr("パスワードが違います");
    } else {
      const s=staff.find(st=>st.active&&st.loginId&&st.loginId===loginId.trim());
      if(!s){ setErr("IDが見つかりません"); return; }
      if(!s.pin){ setErr("PINが未設定です。管理者に連絡してください"); return; }
      if(s.pin!==pin){ setErr("PINが違います"); return; }
      onLogin({role:"staff",staffId:s.id,name:s.name});
    }
  }

  // PINキーパッド
  const PinPad=({value,onChange})=>(
    <div style={{marginTop:8}}>
      <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:8}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:36,height:44,borderRadius:8,border:"2px solid",
            borderColor:value.length>i?"#0f4c8a":"#e2e8f0",
            background:value.length>i?"#dbeafe":"#f8fafc",
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:20,fontWeight:900,color:"#0f4c8a",letterSpacing:2}}>
            {value.length>i?"●":""}
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,maxWidth:180,margin:"0 auto"}}>
        {[1,2,3,4,5,6,7,8,9,"","0","⌫"].map((k,i)=>(
          <button key={i} type="button"
            style={{padding:"10px 0",borderRadius:8,border:"1.5px solid #e2e8f0",
              background:k===""?"transparent":"rgba(255,255,255,.15)",
              color:"#fff",fontSize:16,fontWeight:700,cursor:k===""?"default":"pointer",
              fontFamily:"inherit",opacity:k===""?0:1}}
            onClick={()=>{
              if(k===""||!k) return;
              if(k==="⌫") onChange(value.slice(0,-1));
              else if(value.length<4) onChange(value+k);
            }}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <style>{CSS}</style>
      <div className="lp">
        <div className="lcard">
          <div className="lico">🦷</div>
          <div className="lttl">DentalShift PRO</div>
          <div className="lsub">歯科医院 シフト・有給管理システム</div>
          <div className="ltabs">
            <button className={`ltab ${role==="admin"?"on":""}`} onClick={()=>{setRole("admin");setErr("");setPin("");}}>👑 管理者</button>
            <button className={`ltab ${role==="staff"?"on":""}`} onClick={()=>{setRole("staff");setErr("");setPin("");}}>👤 スタッフ</button>
          </div>
          {role==="admin"?(
            <div className="lf">
              <label>パスワード</label>
              <input type="password" placeholder="パスワードを入力" value={pin}
                onChange={e=>setPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
            </div>
          ):(
            <div className="lf">
              <label>スタッフID</label>
              <input type="text" placeholder="IDを入力" value={loginId}
                onChange={e=>{setLoginId(e.target.value);setErr("");}}
                style={{textAlign:"center",fontSize:16,letterSpacing:2}}
                onKeyDown={e=>e.key==="Enter"&&go()}/>
              <label style={{marginTop:10}}>PIN（4桁）</label>
              <PinPad value={pin} onChange={v=>{setPin(v);setErr("");}}/>
            </div>
          )}
          {err&&<div style={{color:"#fca5a5",fontSize:11,textAlign:"center",marginTop:6,fontWeight:700}}>{err}</div>}
          <button className="lbtn" onClick={go}
            style={{opacity:(role==="staff"&&pin.length<4)?0.5:1}}>
            ログイン
          </button>
          {role==="admin"&&<div className="lhint">demo: admin123</div>}
        </div>
      </div>
    </>
  );
}
