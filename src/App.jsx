import { useState, useMemo } from "react";

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════
const ROLES = {
  Dr:  { label:"歯科医師",   short:"Dr",  color:"#b91c1c", bg:"#fee2e2" },
  Dh:  { label:"歯科衛生士", short:"Dh",  color:"#1d4ed8", bg:"#dbeafe" },
  Da:  { label:"歯科助手",   short:"Da",  color:"#15803d", bg:"#dcfce7" },
  受付: { label:"受付",       short:"受付", color:"#7c3aed", bg:"#ede9fe" },
};

// 矯正当番対象役職
const KYOSEI_ROLES = new Set(["Dh","Da","受付"]);

// シフト種別
// hours = 所定労働時間(h)
const SHIFT_TYPES = {
  出勤:       { label:"出勤",         color:"#1d4ed8", bg:"#dbeafe",  hours:8.25 }, // 8:45-18:30 休90分
  土曜出勤:    { label:"土曜出勤",     color:"#0369a1", bg:"#e0f2fe",  hours:6.25 }, // 8:45-15:30 休30分
  矯正当番_土:  { label:"矯正当番(土)", color:"#0f766e", bg:"#ccfbf1",  hours:5.5  }, // 8:45-12:30 + 14:00-17:30
  矯正当番_木:  { label:"矯正当番(木)", color:"#065f46", bg:"#a7f3d0",  hours:6.5  }, // 8:45-12:30 + 14:00-18:30
  休み:       { label:"休み",         color:"#9ca3af", bg:"#f3f4f6",  hours:0    },
  有給:       { label:"有給",         color:"#d97706", bg:"#fef3c7",  hours:0    },
  午前半休:    { label:"午前半休",     color:"#c2410c", bg:"#ffedd5",  hours:4.125},
  午後半休:    { label:"午後半休",     color:"#a16207", bg:"#fef9c3",  hours:4.125},
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
  { id:1,  name:"佐藤 一郎",   role:"Dr",  leave:15, used:2,  active:true, kyoseiOrder:null },
  { id:2,  name:"吉田 剛",     role:"Dr",  leave:15, used:0,  active:true, kyoseiOrder:null },
  { id:3,  name:"山田 花子",   role:"Dh",  leave:10, used:1,  active:true, kyoseiOrder:1 },
  { id:4,  name:"田中 美咲",   role:"Dh",  leave:10, used:2,  active:true, kyoseiOrder:2 },
  { id:5,  name:"鈴木 奈々",   role:"Dh",  leave:10, used:0,  active:true, kyoseiOrder:3 },
  { id:6,  name:"渡辺 さくら", role:"Dh",  leave:10, used:3,  active:true, kyoseiOrder:4 },
  { id:7,  name:"伊藤 健二",   role:"Da",  leave:10, used:1,  active:true, kyoseiOrder:5 },
  { id:8,  name:"中村 洋介",   role:"Da",  leave:8,  used:0,  active:true, kyoseiOrder:6 },
  { id:9,  name:"小林 麻子",   role:"受付", leave:10, used:1,  active:true, kyoseiOrder:7 },
  { id:10, name:"加藤 真弓",   role:"受付", leave:10, used:0,  active:true, kyoseiOrder:8 },
];

const DEFAULT_MIN = { Dr:1, Dh:2, Da:1, 受付:1 };
const DEFAULT_WH  = { start:"08:45", end:"18:30", breakMin:90 };
const DEFAULT_WH_SAT = { start:"08:45", end:"15:30", breakMin:30 }; // 土曜: 6.25h

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
function autoSchedule(y,m,staff,minStaff) {
  const total=dim(y,m);
  const shifts={};
  const weekWork={};
  const workCount={};
  // 矯正ローテーション: 対象スタッフをkyoseiOrderでソート
  const kyoseiStaff=staff.filter(s=>KYOSEI_ROLES.has(s.role)&&s.kyoseiOrder!=null)
    .sort((a,b)=>a.kyoseiOrder-b.kyoseiOrder);
  // 矯正日ごとに担当を1人ずつ割り当てるカウンター
  let kyoseiRotIdx=0;

  staff.forEach(s=>{ weekWork[s.id]={}; workCount[s.id]=0; });

  // 先に矯正日を特定
  const kyoseiDays={};
  for(let d=1;d<=total;d++){
    const ki=kyoseiInfo(y,m,d);
    if(ki) kyoseiDays[d]=ki;
  }

  // 矯正日ごとに担当を1名アサイン (ローテーション)
  const kyoseiAssigned={}; // day -> staffId
  Object.keys(kyoseiDays).forEach(ds=>{
    const d=Number(ds);
    // 有給・休みのスタッフを除く有効なローテーション候補
    const candidate=kyoseiStaff[kyoseiRotIdx % kyoseiStaff.length];
    kyoseiAssigned[d]=candidate.id;
    kyoseiRotIdx++;
  });

  for(let d=1;d<=total;d++){
    const date=new Date(y,m,d);
    const dow=date.getDay();
    const hol=isHoliday(y,m,d);
    const wk=wkey(y,m,d);
    const ki=kyoseiDays[d];

    // 日曜・祝日 → 全員休み
    if(dow===0||hol){
      staff.forEach(s=>{ shifts[`${s.id}_${d}`]="休み"; });
      continue;
    }

    // 祝日週かどうか
    const hasHolWeek=[0,1,2,3,4,5,6].some(i=>{
      const dd=d-dow+i;
      return dd>=1&&dd<=total&&isHoliday(y,m,dd);
    });
    const maxDays=hasHolWeek?4:5;

    Object.keys(ROLES).forEach(role=>{
      const rs=staff.filter(s=>s.role===role);
      const req=minStaff[role]||0;
      const sorted=[...rs].sort((a,b)=>(workCount[a.id]||0)-(workCount[b.id]||0));

      let assigned=0;
      sorted.forEach(s=>{
        const wc=weekWork[s.id][wk]||0;
        const needRest=wc>=maxDays;

        if(needRest&&assigned>=req){
          shifts[`${s.id}_${d}`]="休み";
          return;
        }

        // 矯正日の処理
        if(ki){
          if(!needRest||assigned<req){
            if(kyoseiAssigned[d]===s.id){
              // 当番者
              shifts[`${s.id}_${d}`]=ki.type==="土"?"矯正当番_土":"矯正当番_木";
            } else {
              // 非当番: Dr は通常出勤、その他は休み
              shifts[`${s.id}_${d}`]= role==="Dr" ? "出勤" : "休み";
            }
            workCount[s.id]=(workCount[s.id]||0)+1;
            weekWork[s.id][wk]=(weekWork[s.id][wk]||0)+1;
            assigned++;
          } else {
            shifts[`${s.id}_${d}`]="休み";
          }
        } else {
          // 通常日（土曜は土曜出勤）
          shifts[`${s.id}_${d}`]=dow===6?"土曜出勤":"出勤";
          workCount[s.id]=(workCount[s.id]||0)+1;
          weekWork[s.id][wk]=(weekWork[s.id][wk]||0)+1;
          assigned++;
        }
      });
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
.rhr td{background:#f1f5f9!important;padding:4px 11px;font-size:9px;font-weight:900;
  color:var(--mut);letter-spacing:.4px;border-bottom:1px solid var(--bdr);
  position:sticky;left:0;}
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
  display:flex;align-items:center;justify-content:center;z-index:1000;padding:14px;}
.modal{background:#fff;border-radius:15px;padding:22px;
  width:100%;max-width:360px;box-shadow:0 18px 50px rgba(0,0,0,.18);}
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
`;

// ═══════════════════════════════════════════════════════
// SHIFT LABEL HELPER
// ═══════════════════════════════════════════════════════
function shiftLabel(key) {
  if(!key) return "";
  if(key==="矯正当番_土") return "矯土";
  if(key==="矯正当番_木") return "矯木";
  if(key==="土曜出勤")    return "土勤";
  if(key==="午前のみ")    return "午前";
  if(key==="午前半休")    return "午前休";
  if(key==="午後半休")    return "午後休";
  return key[0];
}

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════
export default function App() {
  const today=new Date();
  const [user,    setUser]    = useState(null);
  const [tab,     setTab]     = useState("shift");
  const [year,    setYear]    = useState(today.getFullYear());
  const [month,   setMonth]   = useState(today.getMonth());
  const [staff,   setStaff]   = useState(INIT_STAFF);
  const [shifts,  setShifts]  = useState({});
  const [wishes,  setWishes]  = useState({});
  const [minSt,   setMinSt]   = useState(DEFAULT_MIN);
  const [wh,      setWh]      = useState(DEFAULT_WH);
  const [whSat,   setWhSat]   = useState(DEFAULT_WH_SAT);
  const [toast,   setToast]   = useState(null);
  const [modal,   setModal]   = useState(null);
  const [wModal,  setWModal]  = useState(null);
  const [addSt,   setAddSt]   = useState(false);
  const [newSt,   setNewSt]   = useState({name:"",role:"Dh",leave:10});

  const D=dim(year,month);
  const dH=useMemo(()=>dailyH(wh),[wh]);
  const satDH=useMemo(()=>dailyH(whSat),[whSat]);
  const stdH=useMemo(()=>monthlyStd(year,month),[year,month]);

  function toast_(msg){ setToast(msg); setTimeout(()=>setToast(null),2500); }

  // 矯正日一覧 (this month)
  const kyoseiDays=useMemo(()=>{
    const map={};
    for(let d=1;d<=D;d++){
      const ki=kyoseiInfo(year,month,d);
      if(ki) map[d]=ki;
    }
    return map;
  },[year,month,D]);

  function applyShift(sid,day,type){
    const key=`${sid}_${day}`;
    setShifts(prev=>{
      const next={...prev};
      if(prev[key]==="有給"&&type!=="有給")
        setStaff(ps=>ps.map(s=>s.id===sid?{...s,used:Math.max(0,s.used-1)}:s));
      if(type===null) delete next[key]; else next[key]=type;
      return next;
    });
    if(type==="有給"&&shifts[`${sid}_${day}`]!=="有給")
      setStaff(ps=>ps.map(s=>s.id===sid?{...s,used:Math.min(s.leave,s.used+1)}:s));
    setModal(null);
    toast_("シフトを更新しました");
  }

  function handleAuto(){
    const s=autoSchedule(year,month,staff.filter(s=>s.active),minSt);
    setShifts(s);
    toast_("✨ シフトを自動作成しました");
  }

  // 日別・役職別 出勤数
  const dayCounts=useMemo(()=>{
    const map={};
    for(let d=1;d<=D;d++){
      map[d]={};
      Object.keys(ROLES).forEach(role=>{
        map[d][role]=staff.filter(s=>s.role===role&&s.active).filter(s=>{
          const sh=shifts[`${s.id}_${d}`];
          return sh&&sh!=="休み"&&sh!=="有給";
        }).length;
      });
    }
    return map;
  },[shifts,staff,D]);

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
      if(dow===0||isHoliday(year,month,d)) continue;
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
    const days=Array.from({length:D},(_,i)=>i+1);
    const active=staff.filter(s=>s.active);
    const tStaff=isA?active:[mySt].filter(Boolean);
    const byRole={};
    Object.keys(ROLES).forEach(r=>{byRole[r]=tStaff.filter(s=>s.role===r);});

    return (
      <div>
        <div className="ph">
          <div className="ptitle">シフト表 <small>{year}年{month+1}月</small></div>
          <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
            <div className="mnav">
              <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
              <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
              <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
            </div>
            {isA&&<button className="pbtn" onClick={()=>window.print()}>🖨 印刷</button>}
          </div>
        </div>

        {/* 矯正日インフォ */}
        {Object.keys(kyoseiDays).length>0&&(
          <div className="kinfo">
            <div className="kinfo-title">🦷 今月の矯正診療日</div>
            <div className="kinfo-grid">
              {Object.entries(kyoseiDays).map(([d,ki])=>{
                const assignedId=autoSchedule(year,month,active,minSt)[`_kyosei_${d}`];
                // 担当者を shifts から探す
                const tBan=active.find(s=>shifts[`${s.id}_${d}`]==="矯正当番_土"||shifts[`${s.id}_${d}`]==="矯正当番_木");
                return (
                  <div className="kinfo-item" key={d}>
                    <strong>{month+1}/{d}（{ki.label}）</strong><br/>
                    {ki.type==="土"?"14:00〜17:30":"14:00〜18:30"}
                    {tBan&&<span style={{marginLeft:6,fontSize:11,fontWeight:700,background:"#d1fae5",
                      color:"#065f46",padding:"1px 6px",borderRadius:8}}>当番: {tBan.name}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* コントロール */}
        {isA&&(
          <div className="cp">
            <div className="cpt">⚙️ シフト設定</div>
            <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"flex-start"}}>
              <div className="cpg" style={{flex:2,minWidth:260}}>
                {Object.entries(ROLES).map(([role,rv])=>(
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
                <button className="cbtn" onClick={()=>{setShifts({});toast_("シフトをクリアしました");}}>🗑 クリア</button>
                <div style={{fontSize:9,color:"#94a3b8",lineHeight:1.7,padding:"2px 0"}}>
                  週40h基準 / 週休2日<br/>祝日週は週休3日<br/>矯正当番は自動ローテーション
                </div>
              </div>
            </div>
          </div>
        )}

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
        {isA&&overAlerts.length>0&&(
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
                {days.map(d=>{
                  const dow=new Date(year,month,d).getDay();
                  const hol=isHoliday(year,month,d);
                  const ki=kyoseiDays[d];
                  const isTd=d===today.getDate()&&month===today.getMonth()&&year===today.getFullYear();
                  let cls="";
                  if(hol||dow===0) cls="th-hol";
                  else if(ki?.type==="土") cls="th-k2sat";
                  else if(ki?.type==="木") cls="th-k4thu";
                  else if(dow===6) cls="th-sat";
                  return (
                    <th key={d} className={cls}>
                      <span className={isTd?"today-mark":""}>{d}</span>
                      <div style={{fontSize:8,fontWeight:500}}>{DAYS_JP[dow]}</div>
                      {hol&&<div style={{fontSize:7,color:"#b45309",fontWeight:800}}>祝</div>}
                      {ki&&!hol&&<span className="k-mark">矯正</span>}
                      {ki&&!hol&&<span className="k-sub">{ki.label}</span>}
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
                    <td colSpan={D+2}>
                      <span style={{background:rv.bg,color:rv.color,padding:"2px 7px",borderRadius:7,fontSize:8,fontWeight:800}}>
                        {rv.label}（{rv.short}）
                      </span>
                    </td>
                  </tr>,
                  ...rs.map(s=>(
                    <tr key={s.id}>
                      <td className="sn">
                        <div className="nm">{s.name}</div>
                        <span className="rb" style={{background:rv.bg,color:rv.color}}>{rv.short}</span>
                      </td>
                      {days.map(d=>{
                        const dow=new Date(year,month,d).getDay();
                        const hol=isHoliday(year,month,d);
                        const ki=kyoseiDays[d];
                        const sh=shifts[`${s.id}_${d}`];
                        const ws=wishes[`${s.id}_${d}`];
                        const st=SHIFT_TYPES[sh];
                        let tdCls="";
                        if(hol||dow===0) tdCls="td-hol";
                        else if(ki) tdCls="td-k";
                        else if(dow===6) tdCls="td-sat";
                        return (
                          <td key={d} className={tdCls}>
                            {sh?(
                              <button className="scl"
                                style={{background:st?.bg||"#f3f4f6",color:st?.color||"#9ca3af"}}
                                onClick={()=>isA&&setModal({staffId:s.id,day:d,staffName:s.name})}
                                title={`${s.name} ${month+1}/${d} ${sh}${ws?` (希望:${ws})`:""}`}>
                                {shiftLabel(sh)}
                              </button>
                            ):(
                              <div className="scl-e"
                                onClick={()=>isA&&setModal({staffId:s.id,day:d,staffName:s.name})}
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
                      {days.map(d=>{
                        const dow=new Date(year,month,d).getDay();
                        const hol=isHoliday(year,month,d);
                        if(dow===0||hol) return <td key={d}/>;
                        const cnt=dayCounts[d]?.[role]||0;
                        const req=minSt[role]||0;
                        return <td key={d}><span className={cnt>=req?"cok":"cng"}>{cnt}</span></td>;
                      })}
                      {isA&&<td/>}
                    </tr>
                  )
                ].filter(Boolean);
              })}
            </tbody>
          </table>
        </div>
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
            <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
            <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
            <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
          </div>
        </div>
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
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>矯正当番(土) 8:45〜12:30+14:00〜17:30</div>
              <div style={{fontSize:20,fontWeight:900,fontFamily:"JetBrains Mono,monospace"}}>{SHIFT_TYPES["矯正当番_土"].hours}<small style={{fontSize:11,fontWeight:400}}> h</small></div>
              <div style={{fontSize:9,color:"#94a3b8"}}>午前3.75h + 午後3.5h（休憩除く）</div>
            </div>
            <div>
              <div style={{fontSize:9,color:"var(--mut)",fontWeight:700,marginBottom:3}}>矯正当番(木) 8:45〜12:30+14:00〜18:30</div>
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

  // ── KYOSEI ROTATION TAB ────────────────────
  const KyoseiTab=()=>{
    const eligible=staff.filter(s=>s.active&&KYOSEI_ROLES.has(s.role));
    const withOrder=eligible.filter(s=>s.kyoseiOrder!=null).sort((a,b)=>a.kyoseiOrder-b.kyoseiOrder);
    const without=eligible.filter(s=>s.kyoseiOrder==null);
    const [addId,setAddId]=useState("");

    // 矯正日スケジュール (全月)
    const schedule=useMemo(()=>{
      const res=[];
      let idx=0;
      for(let d=1;d<=D;d++){
        const ki=kyoseiInfo(year,month,d);
        if(ki){
          const s=withOrder[idx%withOrder.length];
          res.push({day:d,ki,staff:s});
          idx++;
        }
      }
      return res;
    },[withOrder]);

    return (
      <div>
        <div className="ph"><div className="ptitle">矯正当番 ローテーション</div></div>

        {/* 今月の当番スケジュール */}
        <div className="krot-wrap" style={{marginBottom:16}}>
          <div className="cpt">📅 {year}年{month+1}月 矯正当番スケジュール</div>
          <div className="mnav" style={{display:"inline-flex",marginBottom:12}}>
            <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
            <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
            <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
          </div>
          {schedule.length===0
            ?<div style={{fontSize:12,color:"var(--mut)"}}>今月の矯正日はありません</div>
            :<div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {schedule.map(({day,ki,staff:s})=>(
                <div key={day} style={{background:"#f0fdfa",border:"1px solid #6ee7b7",borderRadius:9,padding:"10px 14px",minWidth:160}}>
                  <div style={{fontSize:11,fontWeight:800,color:"#065f46"}}>{month+1}/{day}（{ki.label}）</div>
                  <div style={{fontSize:10,color:"#047857",margin:"3px 0"}}>{ki.type==="土"?"14:00〜17:30":"14:00〜18:30"}</div>
                  {s
                    ?<div style={{fontSize:12,fontWeight:700,color:"var(--txt)"}}>{s.name}
                      <span style={{fontSize:9,marginLeft:5,color:ROLES[s.role].color,background:ROLES[s.role].bg,padding:"1px 5px",borderRadius:6,fontWeight:800}}>{s.role}</span>
                    </div>
                    :<div style={{fontSize:11,color:"#dc2626",fontWeight:700}}>担当未設定</div>
                  }
                </div>
              ))}
            </div>
          }
        </div>

        {/* ローテーション順序 */}
        <div className="krot-wrap">
          <div className="cpt">🔄 ローテーション順（Dh・Da・受付）</div>
          <div style={{fontSize:11,color:"var(--mut)",marginBottom:10}}>
            ↑↓ボタンで順番を変更できます。矯正日ごとに上から順番に担当します。
          </div>
          <div className="krot-grid">
            {withOrder.map((s,i)=>{
              const rv=ROLES[s.role];
              return (
                <div className="krot-card" key={s.id}>
                  <div className="krot-num">{i+1}</div>
                  <div className="krot-info">
                    <div className="n">{s.name}</div>
                    <div className="r" style={{color:rv.color}}>{rv.label}</div>
                  </div>
                  <div style={{marginLeft:"auto",display:"flex",gap:3}}>
                    <button className="sb" style={{padding:"2px 6px"}} disabled={i===0}
                      onClick={()=>setStaff(ps=>{
                        const arr=[...ps];
                        const ai=arr.findIndex(x=>x.id===s.id);
                        const bi=arr.findIndex(x=>x.id===withOrder[i-1].id);
                        [arr[ai].kyoseiOrder,arr[bi].kyoseiOrder]=[arr[bi].kyoseiOrder,arr[ai].kyoseiOrder];
                        return [...arr];
                      })}>↑</button>
                    <button className="sb" style={{padding:"2px 6px"}} disabled={i===withOrder.length-1}
                      onClick={()=>setStaff(ps=>{
                        const arr=[...ps];
                        const ai=arr.findIndex(x=>x.id===s.id);
                        const bi=arr.findIndex(x=>x.id===withOrder[i+1].id);
                        [arr[ai].kyoseiOrder,arr[bi].kyoseiOrder]=[arr[bi].kyoseiOrder,arr[ai].kyoseiOrder];
                        return [...arr];
                      })}>↓</button>
                    <button className="sb del"
                      onClick={()=>{setStaff(ps=>ps.map(x=>x.id===s.id?{...x,kyoseiOrder:null}:x));toast_(`${s.name} をローテーションから除外しました`);}}>除外</button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 未追加スタッフ */}
          {without.length>0&&(
            <div className="krot-add">
              <span style={{fontSize:11,color:"var(--mut)",fontWeight:600}}>ローテーションに追加:</span>
              <select className="krot-sel" value={addId} onChange={e=>setAddId(e.target.value)}>
                <option value="">-- 選択 --</option>
                {without.map(s=><option key={s.id} value={s.id}>{s.name}（{ROLES[s.role].label}）</option>)}
              </select>
              <button className="svbtn" onClick={()=>{
                if(!addId) return;
                const maxOrd=Math.max(0,...withOrder.map(s=>s.kyoseiOrder||0));
                setStaff(ps=>ps.map(x=>x.id===Number(addId)?{...x,kyoseiOrder:maxOrd+1}:x));
                setAddId("");
                toast_("ローテーションに追加しました");
              }}>追加</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── PAID TAB ───────────────────────────────
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
              <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
              <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
              <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
            </div>
          </div>
          <div className="twrap">
            <table className="stbl">
              <thead>
                <tr>
                  <th className="sc">スタッフ</th>
                  {days.map(d=>{
                    const dow=new Date(year,month,d).getDay();
                    const hol=isHoliday(year,month,d);
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
            <button onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
            <span className="mlbl">{year}/{String(month+1).padStart(2,"0")}</span>
            <button onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
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
              const hol=isHoliday(year,month,d);
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
        <button className="abtn" style={{fontSize:11,padding:"7px 12px"}}
          onClick={()=>setAddSt(v=>!v)}>
          {addSt?"✕ キャンセル":"＋ スタッフ追加"}
        </button>
      </div>
      {addSt&&(
        <div className="aform">
          <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>新規スタッフ追加</div>
          <div className="afr">
            <div className="aff"><label>氏名</label><input value={newSt.name} onChange={e=>setNewSt(n=>({...n,name:e.target.value}))} placeholder="例：田中 花子"/></div>
            <div className="aff" style={{maxWidth:100}}><label>役職</label>
              <select value={newSt.role} onChange={e=>setNewSt(n=>({...n,role:e.target.value}))}>
                {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="aff" style={{maxWidth:90}}><label>有給付与日数</label><input type="number" value={newSt.leave} onChange={e=>setNewSt(n=>({...n,leave:Number(e.target.value)}))} min="0" max="40"/></div>
            <button className="svbtn" onClick={()=>{
              if(!newSt.name.trim()){toast_("氏名を入力してください");return;}
              const id=Math.max(0,...staff.map(s=>s.id))+1;
              const isKyosei=KYOSEI_ROLES.has(newSt.role);
              const maxOrd=isKyosei?Math.max(0,...staff.filter(s=>s.kyoseiOrder!=null).map(s=>s.kyoseiOrder)):null;
              setStaff(ps=>[...ps,{id,name:newSt.name,role:newSt.role,leave:newSt.leave,used:0,active:true,kyoseiOrder:isKyosei?maxOrd+1:null}]);
              setNewSt({name:"",role:"Dh",leave:10});
              setAddSt(false);
              toast_(`${newSt.name} を追加しました`);
            }}>追加</button>
          </div>
        </div>
      )}
      <div className="sgrid">
        {Object.keys(ROLES).map(role=>{
          const rv=ROLES[role];
          return staff.filter(s=>s.role===role).map(s=>(
            <div className="scard" key={s.id} style={{opacity:s.active?1:.55}}>
              <div className="st">
                <div>
                  <div className="snm">{s.name}</div>
                  <span className="srl" style={{background:rv.bg,color:rv.color}}>{rv.short} {rv.label}</span>
                  {s.kyoseiOrder!=null&&<span style={{fontSize:8,color:"#065f46",background:"#d1fae5",padding:"1px 5px",borderRadius:6,fontWeight:800,marginLeft:4}}>矯正ローテ {s.kyoseiOrder}番</span>}
                </div>
                <button className="sb" style={{background:s.active?"#dcfce7":"#f3f4f6",color:s.active?"#15803d":"#9ca3af",borderColor:"transparent"}}
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
                <button className="sb" onClick={()=>{const n=Number(window.prompt("有給付与日数:",s.leave));if(!isNaN(n)&&n>=0){setStaff(ps=>ps.map(st=>st.id===s.id?{...st,leave:n}:st));toast_("有給日数を更新しました");}}}>有給変更</button>
                <button className="sb del" onClick={()=>{if(window.confirm(`${s.name} を削除しますか？`)){setStaff(ps=>ps.filter(st=>st.id!==s.id));toast_(`${s.name} を削除しました`);}}}>削除</button>
              </div>
            </div>
          ));
        })}
      </div>
    </div>
  );

  const aTabs=[
    {id:"shift",label:"シフト表"},
    {id:"kyosei",label:"矯正当番"},
    {id:"flex",label:"変形労働時間"},
    {id:"paid",label:"有給管理"},
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
            {isA&&alerts.length>0&&<span className="halert red" onClick={()=>setTab("shift")}>⚠ 不足{alerts.length}件</span>}
            {isA&&overAlerts.length>0&&<span className="halert ora" onClick={()=>setTab("flex")}>🕐 超過{overAlerts.length}名</span>}
            <span style={{color:"rgba(255,255,255,.6)",fontSize:11}}>{user.name}</span>
            <span className="hbadge">{isA?"管理者":"スタッフ"}</span>
            <button className="hbtn" onClick={()=>setUser(null)}>ログアウト</button>
          </div>
        </header>
        <main className="main">
          {tab==="shift"  && <ShiftTab/>}
          {tab==="kyosei" && isA && <KyoseiTab/>}
          {tab==="flex"   && isA && <FlexTab/>}
          {tab==="paid"   && <PaidTab/>}
          {tab==="wish"   && <WishTab/>}
          {tab==="staff"  && isA && <StaffTab/>}
        </main>

        {modal&&isA&&(
          <div className="ov" onClick={()=>setModal(null)}>
            <div className="modal" onClick={e=>e.stopPropagation()}>
              <h3>{modal.staffName}</h3>
              <p>
                {year}年{month+1}月{modal.day}日（{DAYS_JP[new Date(year,month,modal.day).getDay()]}）
                {isHoliday(year,month,modal.day)&&" 🎌祝日"}
                {kyoseiDays[modal.day]&&` 🦷${kyoseiDays[modal.day].label}矯正日`}
              </p>
              <div className="mbtns">
                {Object.entries(SHIFT_TYPES).map(([k,v])=>(
                  <button key={k} className="mbtn" style={{borderColor:v.color,color:v.color}}
                    onClick={()=>applyShift(modal.staffId,modal.day,k)}>
                    {v.label}{v.hours>0&&<small>{v.hours}h</small>}
                  </button>
                ))}
              </div>
              <button className="mclr" onClick={()=>applyShift(modal.staffId,modal.day,null)}>シフトをクリア</button>
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
                {Object.entries(SHIFT_TYPES).map(([k,v])=>(
                  <button key={k} className="mbtn" style={{borderColor:v.color,color:v.color}}
                    onClick={()=>{
                      setWishes(p=>{const n={...p};n[`${wModal.staffId}_${wModal.day}`]=k;return n;});
                      setWModal(null);toast_("希望シフトを入力しました");
                    }}>
                    {v.label}{v.hours>0&&<small>{v.hours}h</small>}
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
    </>
  );
}

// ═══════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════
function LoginScreen({onLogin,staff}){
  const [role,setRole]=useState("admin");
  const [sel, setSel] =useState(staff[0]?.id||1);
  const [pass,setPass]=useState("");

  function go(){
    if(role==="admin"){
      if(pass==="admin123") onLogin({role:"admin",name:"院長・管理者"});
      else alert("パスワードが違います（デモ: admin123）");
    } else {
      const s=staff.find(st=>st.id===Number(sel));
      if(s) onLogin({role:"staff",staffId:s.id,name:s.name});
    }
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="lp">
        <div className="lcard">
          <div className="lico">🦷</div>
          <div className="lttl">DentalShift PRO</div>
          <div className="lsub">歯科医院 シフト・有給管理システム</div>
          <div className="ltabs">
            <button className={`ltab ${role==="admin"?"on":""}`} onClick={()=>setRole("admin")}>👑 管理者</button>
            <button className={`ltab ${role==="staff"?"on":""}`} onClick={()=>setRole("staff")}>👤 スタッフ</button>
          </div>
          {role==="admin"
            ?<div className="lf"><label>パスワード</label><input type="password" placeholder="パスワードを入力" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/></div>
            :<div className="lf"><label>スタッフを選択</label>
              <select value={sel} onChange={e=>setSel(e.target.value)}>
                {Object.keys(ROLES).map(r=>staff.filter(s=>s.role===r&&s.active).map(s=>(
                  <option key={s.id} value={s.id}>{s.name}（{ROLES[s.role].label}）</option>
                )))}
              </select>
            </div>
          }
          <button className="lbtn" onClick={go}>ログイン</button>
          <div className="lhint">{role==="admin"?"demo: admin123":"パスワード不要（デモ）"}</div>
        </div>
      </div>
    </>
  );
}
