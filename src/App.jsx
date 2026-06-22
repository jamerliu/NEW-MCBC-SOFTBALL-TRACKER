import React, { useState, useEffect, useMemo } from "react";
import { Plus, Minus, Trash2, ArrowUp, ArrowDown, ChevronLeft, RefreshCw, Save, Users, ClipboardList, ListOrdered, Table2, X, RotateCcw, Pencil, Printer } from "lucide-react";

/* ---------------------------------------------------------------------------
   HELPERS
--------------------------------------------------------------------------- */

const KEYS = { TEAMS: "teams", PLAYERS: "players", GAMES: "games", STATS: "stats", LINEUPS: "lineups", HISTORICAL: "historical", TRASH: "trashedGames" };

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function loadRaw(key, shared, fallback) {
  try {
    const r = await window.storage.get(key, shared);
    return r ? JSON.parse(r.value) : fallback;
  } catch (e) {
    return fallback;
  }
}

async function existsRaw(key, shared) {
  try {
    const r = await window.storage.get(key, shared);
    return !!r;
  } catch (e) {
    return false;
  }
}

async function loadKey(key, fallback) {
  return loadRaw(key, true, fallback);
}

async function keyExists(key) {
  return existsRaw(key, true);
}

async function saveKey(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
  } catch (e) {
    console.error("Storage save failed", key, e);
  }
}

function statKey(gameId, playerId) {
  return gameId + "::" + playerId;
}

const emptyLine = { ab: 0, s: 0, d: 0, t: 0, hr: 0, rbi: 0 };
const emptyHistLine = { ab: 0, h: 0, tb: 0, rbi: 0 };

function deriveTotals(line) {
  const ab = Number(line.ab) || 0;
  const h = Number(line.h) || 0;
  const tb = Number(line.tb) || 0;
  const rbi = Number(line.rbi) || 0;
  const obp = ab > 0 ? h / ab : 0;
  const slg = ab > 0 ? tb / ab : 0;
  return { ab, h, tb, rbi, obp, slg };
}

function lineFor(stats, gameId, playerId) {
  return stats[statKey(gameId, playerId)] || emptyLine;
}

function derive(line) {
  const ab = Number(line.ab) || 0;
  const s = Number(line.s) || 0;
  const d = Number(line.d) || 0;
  const t = Number(line.t) || 0;
  const hr = Number(line.hr) || 0;
  const rbi = Number(line.rbi) || 0;
  const h = s + d + t + hr;
  const tb = s + d * 2 + t * 3 + hr * 4;
  const obp = ab > 0 ? h / ab : 0;
  const slg = ab > 0 ? tb / ab : 0;
  return { ab, h, tb, rbi, obp, slg };
}

function fmt3(n) {
  if (!isFinite(n)) return ".000";
  let s = n.toFixed(3);
  if (s.startsWith("0.")) s = s.slice(1);
  if (s.startsWith("-0.")) s = "-" + s.slice(2);
  return s;
}

function cumulativeFor(playerId, stats, historical = {}) {
  let ab = 0, h = 0, tb = 0, rbi = 0;
  Object.entries(stats).forEach(([key, line]) => {
    const pId = key.split("::")[1];
    if (pId !== playerId) return;
    const d = derive(line);
    ab += d.ab; h += d.h; tb += d.tb; rbi += d.rbi;
  });
  const hist = historical[playerId];
  if (hist) {
    const hd = deriveTotals(hist);
    ab += hd.ab; h += hd.h; tb += hd.tb; rbi += hd.rbi;
  }
  const obp = ab > 0 ? h / ab : 0;
  const slg = ab > 0 ? tb / ab : 0;
  return { ab, h, tb, rbi, obp, slg };
}

function gamesPlayedCount(playerId, games) {
  return games.filter((g) => (g.roster || []).includes(playerId)).length;
}

/* Gender-rule lineup logic, checked cyclically (wraps from last batter back to first):
   - Men: hard cap, never more than 3 in a row, no exceptions.
   - Women: soft cap, prefer no more than 2 in a row, but a clearly elite hitter
     is allowed to stay in place rather than always being bumped out. */

function maxRunCyclic(genders, target = "M") {
  const n = genders.length;
  if (n === 0) return 0;
  let max = 0, run = 0;
  for (let i = 0; i < n * 2; i++) {
    const g = genders[i % n];
    if (g === target) {
      run++;
      max = Math.max(max, run);
      if (run > n) break;
    } else run = 0;
  }
  return Math.min(max, n);
}

function fixGenderRuleHard(order, playersById, target = "M", maxRun = 3) {
  let arr = [...order];
  let guard = 0;
  while (guard < 200) {
    guard++;
    const genders = arr.map((id) => playersById[id]?.gender || "M");
    const n = genders.length;
    let run = 0, violIdx = -1;
    for (let i = 0; i < n * 2; i++) {
      const g = genders[i % n];
      if (g === target) {
        run++;
        if (run > maxRun) { violIdx = i % n; break; }
      } else run = 0;
    }
    if (violIdx === -1) break;
    let swapIdx = -1;
    for (let dist = 1; dist < n; dist++) {
      const idx = (violIdx + dist) % n;
      if (genders[idx] !== target) { swapIdx = idx; break; }
    }
    if (swapIdx === -1) break;
    [arr[violIdx], arr[swapIdx]] = [arr[swapIdx], arr[violIdx]];
  }
  return arr;
}

/* Same idea as fixGenderRuleHard, but if the player who'd normally get bumped
   has a clearly elite quality score (top tier of the selected pool), she's left
   in place instead, on the theory that a standout hitter is worth the exception. */
function fixFemaleRuleSoft(order, playersById, qualityById, maxRun = 2, protectThreshold = 0.75) {
  let arr = [...order];
  const protectedIdx = new Set();
  let guard = 0;
  while (guard < 200) {
    guard++;
    const genders = arr.map((id) => playersById[id]?.gender || "M");
    const n = genders.length;
    let run = 0, violIdx = -1;
    for (let i = 0; i < n * 2; i++) {
      const idx = i % n;
      const g = genders[idx];
      if (g === "F") {
        run++;
        if (run > maxRun && !protectedIdx.has(idx)) { violIdx = idx; break; }
      } else run = 0;
    }
    if (violIdx === -1) break;
    const pid = arr[violIdx];
    const quality = qualityById[pid] ?? 0;
    if (quality >= protectThreshold) {
      protectedIdx.add(violIdx);
      continue;
    }
    let swapIdx = -1;
    for (let dist = 1; dist < n; dist++) {
      const idx2 = (violIdx + dist) % n;
      if (genders[idx2] === "M") { swapIdx = idx2; break; }
    }
    if (swapIdx === -1) break;
    [arr[violIdx], arr[swapIdx]] = [arr[swapIdx], arr[violIdx]];
  }
  return arr;
}

const SKILL_TIERS = [
  { value: "high", label: "High level" },
  { value: "medium", label: "Medium level" },
  { value: "beginner", label: "Beginner" },
];

/* Rough stat estimates per tier, used only as a stand-in for players with zero
   recorded at-bats (brand new players, or anyone without historical data yet).
   Real recorded stats always take priority over these the moment they exist. */
const TIER_PROXY = {
  high: { obp: 0.42, slg: 0.62, rbiRate: 0.18 },
  medium: { obp: 0.32, slg: 0.42, rbiRate: 0.1 },
  beginner: { obp: 0.23, slg: 0.26, rbiRate: 0.04 },
};

function buildLineup(selectedIds, playersById, statsCumulativeById) {
  const n = selectedIds.length;
  if (n === 0) return [];
  const data = selectedIds.map((id) => {
    const c = statsCumulativeById[id] || { ab: 0, obp: 0, slg: 0, rbi: 0 };
    let obp = c.obp, slg = c.slg, rbiRate = c.ab > 0 ? c.rbi / c.ab : 0;
    if (c.ab === 0) {
      const tier = playersById[id]?.skillTier;
      const proxy = TIER_PROXY[tier] || TIER_PROXY.medium;
      obp = proxy.obp; slg = proxy.slg; rbiRate = proxy.rbiRate;
    }
    return { id, obp, slg, rbiRate };
  });
  const maxOf = (arr, key) => Math.max(...arr.map((x) => x[key]), 0.0001);
  const obpMax = maxOf(data, "obp"), slgMax = maxOf(data, "slg"), rbiMax = maxOf(data, "rbiRate");
  data.forEach((d) => {
    d.obpN = d.obp / obpMax;
    d.slgN = d.slg / slgMax;
    d.rbiN = d.rbiRate / rbiMax;
  });
  const qualityById = {};
  data.forEach((d) => { qualityById[d.id] = (d.obpN + d.slgN + d.rbiN) / 3; });

  const tableSetterW = (i) => Math.max(0, 1 - i / (n - 1 || 1));
  const peak = Math.min(3, n - 1);
  const spread = Math.max(2, n / 2);
  const powerW = (i) => Math.max(0, 1 - Math.abs(i - peak) / spread);

  const slots = Array.from({ length: n }, (_, i) => i);
  const importance = slots.map((i) => tableSetterW(i) + powerW(i));
  const slotOrder = [...slots].sort((a, b) => importance[b] - importance[a]);

  const used = new Set();
  const result = new Array(n);
  slotOrder.forEach((slotIdx) => {
    let best = null, bestScore = -Infinity;
    data.forEach((d) => {
      if (used.has(d.id)) return;
      const score = tableSetterW(slotIdx) * d.obpN + powerW(slotIdx) * (0.7 * d.slgN + 0.3 * d.rbiN);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    if (best) { result[slotIdx] = best.id; used.add(best.id); }
  });

  let order = fixGenderRuleHard(result, playersById, "M", 3);
  order = fixFemaleRuleSoft(order, playersById, qualityById, 2, 0.75);
  // Swapping to fix the women's run can shuffle a man into a new spot, so re-check
  // the hard male rule once more as a final safety net.
  order = fixGenderRuleHard(order, playersById, "M", 3);
  return order;
}

/* ---------------------------------------------------------------------------
   SMALL UI PIECES
--------------------------------------------------------------------------- */

const COLORS = {
  bg: "#F5F3FC",
  ink: "#221A3A",
  field: "#3D2B7A",
  turf: "#6C4FCB",
  clay: "#2F5FE3",
  mustard: "#7C9CF5",
  line: "#DAD3F0",
  panel: "#EAE4F7",
  highlight: "#EFF1FE",
  muted: "#6B6280",
};

function SkillBadge({ tier }) {
  if (!tier) return <span className="text-[11px] italic" style={{ color: "#A9A2C9" }}>Not set</span>;
  const meta = {
    high: { label: "High", bg: COLORS.field },
    medium: { label: "Medium", bg: COLORS.clay },
    beginner: { label: "Beginner", bg: COLORS.turf },
  }[tier] || { label: tier, bg: COLORS.muted };
  return (
    <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: meta.bg, color: "white" }}>
      {meta.label}
    </span>
  );
}

function GenderPill({ gender }) {
  const isM = gender === "M";
  return (
    <span
      className="inline-flex items-center justify-center text-[10px] font-bold uppercase tracking-wider rounded-full w-6 h-6"
      style={{
        background: isM ? COLORS.field : COLORS.clay,
        color: COLORS.bg,
      }}
      title={isM ? "Male" : "Female"}
    >
      {isM ? "M" : "F"}
    </span>
  );
}

function Stepper({ label, value, onInc, onDec, accent }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}` }}>
      <span className="text-xs font-bold uppercase tracking-wide w-9" style={{ color: accent || COLORS.field }}>{label}</span>
      <button
        onClick={onDec}
        className="w-7 h-7 rounded-md flex items-center justify-center"
        style={{ background: "white", border: `1px solid ${COLORS.line}`, color: COLORS.ink }}
      >
        <Minus size={14} />
      </button>
      <span className="w-6 text-center font-mono font-extrabold tabular-nums" style={{ color: COLORS.ink }}>{value}</span>
      <button
        onClick={onInc}
        className="w-7 h-7 rounded-md flex items-center justify-center"
        style={{ background: accent || COLORS.field, color: "white" }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function ConfirmDelete({ onConfirm, label = "Remove" }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setConfirming(true); }} className="text-stone-400 hover:text-red-700">
        <Trash2 size={15} />
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); onConfirm(); setConfirming(false); }}
        className="text-[11px] font-bold px-2 py-1 rounded-md whitespace-nowrap"
        style={{ background: "#9B3A1F", color: "white" }}
      >
        {label}
      </button>
      <button onClick={(e) => { e.stopPropagation(); setConfirming(false); }} className="text-stone-400 hover:text-stone-600">
        <X size={14} />
      </button>
    </span>
  );
}

function NumBox({ value, onChange, onBlur, width = "w-14" }) {
  return (
    <input
      type="number"
      min="0"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      onBlur={onBlur}
      className={`${width} text-center rounded-md border px-1 py-1 text-sm font-mono tabular-nums focus:outline-none focus:ring-2`}
      style={{ borderColor: COLORS.line, background: "white", color: COLORS.ink, "--tw-ring-color": COLORS.mustard }}
    />
  );
}

function Btn({ children, onClick, variant = "primary", icon: Icon, disabled, small }) {
  const styles = {
    primary: { background: COLORS.field, color: "white" },
    accent: { background: COLORS.clay, color: "white" },
    ghost: { background: "transparent", color: COLORS.field, border: `1px solid ${COLORS.field}` },
    danger: { background: "transparent", color: "#9B3A1F", border: "1px solid #9B3A1F" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg font-semibold transition-opacity hover:opacity-85 disabled:opacity-40 ${
        small ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"
      }`}
      style={styles[variant]}
    >
      {Icon && <Icon size={small ? 13 : 15} />}
      {children}
    </button>
  );
}

function TabBtn({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold uppercase tracking-wide rounded-t-lg transition-colors"
      style={{
        background: active ? COLORS.bg : "transparent",
        color: active ? COLORS.field : "rgba(245,243,252,0.65)",
        borderBottom: active ? `3px solid ${COLORS.clay}` : "3px solid transparent",
      }}
    >
      <Icon size={16} /> {children}
    </button>
  );
}

function SortHeader({ label, field, sort, setSort }) {
  const active = sort.key === field;
  return (
    <th
      onClick={() => setSort((s) => ({ key: field, dir: s.key === field && s.dir === "desc" ? "asc" : "desc" }))}
      className="cursor-pointer select-none px-3 py-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap"
      style={{ color: active ? COLORS.clay : COLORS.field }}
    >
      {label} {active ? (sort.dir === "desc" ? "▾" : "▴") : ""}
    </th>
  );
}

/* ---------------------------------------------------------------------------
   TEAM VIEW
--------------------------------------------------------------------------- */

function TeamView({ players, games, stats, historical, onOpenPlayer, addPlayer, updatePlayer, deletePlayer }) {
  const [sort, setSort] = useState({ key: "obp", dir: "desc" });
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [gender, setGender] = useState("M");
  const [tier, setTier] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editGender, setEditGender] = useState("M");
  const [editTier, setEditTier] = useState("");

  const rows = players.map((p) => {
    const c = cumulativeFor(p.id, stats, historical);
    const gp = gamesPlayedCount(p.id, games);
    return { ...p, ...c, gp };
  });

  rows.sort((a, b) => {
    const dir = sort.dir === "desc" ? -1 : 1;
    if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
    return (a[sort.key] - b[sort.key]) * dir;
  });

  const startEdit = (p) => { setEditingId(p.id); setEditName(p.name); setEditGender(p.gender); setEditTier(p.skillTier || ""); };
  const saveEdit = () => {
    if (editName.trim()) updatePlayer(editingId, { name: editName.trim(), gender: editGender, skillTier: editTier || null });
    setEditingId(null);
  };

  const SORT_FIELDS = [
    { key: "name", label: "Name" },
    { key: "gp", label: "Games Played" },
    { key: "ab", label: "At Bats" },
    { key: "h", label: "Hits" },
    { key: "obp", label: "OBP" },
    { key: "slg", label: "SLG" },
    { key: "rbi", label: "RBI" },
  ];
  const isAlpha = sort.key === "name";
  const dirLabel = isAlpha
    ? (sort.dir === "asc" ? "A → Z" : "Z → A")
    : (sort.dir === "desc" ? "Highest → Lowest" : "Lowest → Highest");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-extrabold" style={{ color: COLORS.field }}>Team Stat Sheet</h2>
          <p className="text-sm" style={{ color: "#6B6280" }}>
            Click a player's row to see their game-by-game log. OBP equals batting average here since there are no walks or HBP in this league.
          </p>
        </div>
        <Btn icon={Plus} onClick={() => setShowAdd((v) => !v)}>Add Player</Btn>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label className="text-xs font-bold uppercase block mb-1" style={{ color: COLORS.field }}>Sort by</label>
          <select
            value={sort.key}
            onChange={(e) => setSort((s) => ({ ...s, key: e.target.value }))}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: COLORS.line }}
          >
            {SORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <Btn
          variant="ghost"
          icon={sort.dir === "asc" ? ArrowUp : ArrowDown}
          onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
        >
          {dirLabel}
        </Btn>
      </div>

      {showAdd && (
        <div className="mb-1 text-xs" style={{ color: COLORS.muted }}>
          Skill level is a quick estimate the lineup builder leans on until a player has logged at-bats. Add more detail on their page once they're added.
        </div>
      )}
      {showAdd && (
        <div className="flex items-end gap-3 mb-4 p-3 rounded-lg" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
          <div>
            <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="block mt-1 rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: COLORS.line }}
              placeholder="Player name"
            />
          </div>
          <div>
            <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Gender</label>
            <select value={gender} onChange={(e) => setGender(e.target.value)} className="block mt-1 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: COLORS.line }}>
              <option value="M">M</option>
              <option value="F">F</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Skill level</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)} className="block mt-1 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: COLORS.line }}>
              <option value="">Not set</option>
              {SKILL_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <Btn
            icon={Save}
            onClick={() => {
              if (!name.trim()) return;
              addPlayer(name.trim(), gender, tier || null);
              setName(""); setGender("M"); setTier(""); setShowAdd(false);
            }}
          >
            Save Player
          </Btn>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg" style={{ border: `1px solid ${COLORS.line}`, background: "white" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "#EAE4F7" }}>
            <tr>
              <SortHeader label="Player" field="name" sort={sort} setSort={setSort} />
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.field }}>G</th>
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.field }}>Level</th>
              <SortHeader label="GP" field="gp" sort={sort} setSort={setSort} />
              <SortHeader label="AB" field="ab" sort={sort} setSort={setSort} />
              <SortHeader label="H" field="h" sort={sort} setSort={setSort} />
              <SortHeader label="OBP" field="obp" sort={sort} setSort={setSort} />
              <SortHeader label="SLG" field="slg" sort={sort} setSort={setSort} />
              <SortHeader label="RBI" field="rbi" sort={sort} setSort={setSort} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isEditing = editingId === r.id;
              return (
                <tr key={r.id} className="border-t hover:bg-violet-50/50" style={{ borderColor: COLORS.line }} onClick={() => !isEditing && onOpenPlayer(r.id)}>
                  <td className="px-3 py-2 font-semibold cursor-pointer" style={{ color: COLORS.ink }}>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-md border px-2 py-1 text-sm w-32"
                        style={{ borderColor: COLORS.line }}
                      />
                    ) : r.name}
                  </td>
                  <td className="px-3 py-2">
                    {isEditing ? (
                      <select
                        value={editGender}
                        onChange={(e) => setEditGender(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-md border px-1.5 py-1 text-xs"
                        style={{ borderColor: COLORS.line }}
                      >
                        <option value="M">M</option>
                        <option value="F">F</option>
                      </select>
                    ) : <GenderPill gender={r.gender} />}
                  </td>
                  <td className="px-3 py-2">
                    {isEditing ? (
                      <select
                        value={editTier}
                        onChange={(e) => setEditTier(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-md border px-1.5 py-1 text-xs"
                        style={{ borderColor: COLORS.line }}
                      >
                        <option value="">Not set</option>
                        {SKILL_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    ) : <SkillBadge tier={r.skillTier} />}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums cursor-pointer">{r.gp}</td>
                  <td className="px-3 py-2 font-mono tabular-nums cursor-pointer">{r.ab}</td>
                  <td className="px-3 py-2 font-mono tabular-nums cursor-pointer">{r.h}</td>
                  <td className="px-3 py-2 font-mono tabular-nums font-bold cursor-pointer" style={{ color: COLORS.field }}>{fmt3(r.obp)}</td>
                  <td className="px-3 py-2 font-mono tabular-nums font-bold cursor-pointer" style={{ color: COLORS.clay }}>{fmt3(r.slg)}</td>
                  <td className="px-3 py-2 font-mono tabular-nums cursor-pointer">{r.rbi}</td>
                  <td className="px-3 py-2 text-right">
                    {isEditing ? (
                      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button onClick={saveEdit} className="text-stone-500 hover:text-green-700"><Save size={15} /></button>
                        <button onClick={() => setEditingId(null)} className="text-stone-400 hover:text-stone-600"><X size={15} /></button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => startEdit(r)} className="text-stone-400 hover:text-stone-700"><Pencil size={14} /></button>
                        <ConfirmDelete label="Remove" onConfirm={() => deletePlayer(r.id)} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-stone-400">No players yet. Add your roster to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   PLAYER DETAIL VIEW
--------------------------------------------------------------------------- */

function PlayerView({ player, games, stats, historical, onBack, updateLine, updatePlayer }) {
  const cum = cumulativeFor(player.id, stats, historical);
  const gp = gamesPlayedCount(player.id, games);
  const playerGames = games
    .filter((g) => (g.roster || []).includes(player.id))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const [draft, setDraft] = useState({});
  const [noteDraft, setNoteDraft] = useState(player.skillNote || "");

  const getLine = (gameId) => draft[gameId] || lineFor(stats, gameId, player.id);
  const setField = (gameId, field, val) => {
    setDraft((d) => ({ ...d, [gameId]: { ...getLine(gameId), [field]: val } }));
  };
  const commit = (gameId) => {
    if (draft[gameId]) updateLine(gameId, player.id, draft[gameId]);
  };

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm font-bold mb-3" style={{ color: COLORS.field }}>
        <ChevronLeft size={16} /> Back to team
      </button>

      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-2xl font-extrabold" style={{ color: COLORS.field }}>{player.name}</h2>
        <GenderPill gender={player.gender} />
        <SkillBadge tier={player.skillTier} />
      </div>
      <p className="text-sm mb-4" style={{ color: "#6B6280" }}>
        {gp} game{gp === 1 ? "" : "s"} played, career totals below.
        {historical[player.id] && (Number(historical[player.id].ab) || 0) > 0 && (
          <span> Includes {historical[player.id].ab} at-bats imported from last season.</span>
        )}
      </p>

      <div className="rounded-lg p-3 mb-6" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
        <h3 className="text-sm font-bold uppercase tracking-wide mb-2" style={{ color: COLORS.field }}>Skill assessment</h3>
        <p className="text-xs mb-3" style={{ color: COLORS.muted }}>
          The skill level fills in for the lineup builder until this player has logged at-bats. Use the note below for more nuance than the
          three levels can capture, things like "strong arm but new to hitting" or "fast but still learning the strike zone".
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <div>
            <label className="text-xs font-bold uppercase block mb-1" style={{ color: COLORS.field }}>Level</label>
            <select
              value={player.skillTier || ""}
              onChange={(e) => updatePlayer(player.id, { skillTier: e.target.value || null })}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: COLORS.line }}
            >
              <option value="">Not set</option>
              {SKILL_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <label className="text-xs font-bold uppercase block mb-1" style={{ color: COLORS.field }}>Notes</label>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => updatePlayer(player.id, { skillNote: noteDraft })}
          rows={3}
          placeholder="Anything coaches should know that the level alone doesn't capture..."
          className="w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: COLORS.line }}
        />
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
        {[["AB", cum.ab], ["H", cum.h], ["OBP", fmt3(cum.obp)], ["SLG", fmt3(cum.slg)], ["RBI", cum.rbi], ["TB", cum.tb]].map(([label, val]) => (
          <div key={label} className="rounded-lg p-3 text-center" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
            <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: COLORS.clay }}>{label}</div>
            <div className="text-lg font-mono font-extrabold tabular-nums" style={{ color: COLORS.field }}>{val}</div>
          </div>
        ))}
      </div>

      <h3 className="text-sm font-bold uppercase tracking-wide mb-2" style={{ color: COLORS.field }}>Game-by-game log (editable)</h3>
      <div className="overflow-x-auto rounded-lg" style={{ border: `1px solid ${COLORS.line}`, background: "white" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "#EAE4F7" }}>
            <tr>
              {["Date", "Opp", "AB", "1B", "2B", "3B", "HR", "RBI", "OBP", "SLG", ""].map((h) => (
                <th key={h} className="px-2 py-2 text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.field }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {playerGames.map((g) => {
              const line = getLine(g.id);
              const d = derive(line);
              const dirty = !!draft[g.id];
              return (
                <tr key={g.id} className="border-t" style={{ borderColor: COLORS.line }}>
                  <td className="px-2 py-1.5 whitespace-nowrap">{g.date}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-stone-500">{g.opponent || "—"}</td>
                  {["ab", "s", "d", "t", "hr", "rbi"].map((f) => (
                    <td key={f} className="px-1 py-1.5">
                      <NumBox value={line[f] ?? 0} onChange={(v) => setField(g.id, f, v)} onBlur={() => commit(g.id)} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 font-mono tabular-nums font-bold" style={{ color: COLORS.field }}>{fmt3(d.obp)}</td>
                  <td className="px-2 py-1.5 font-mono tabular-nums font-bold" style={{ color: COLORS.clay }}>{fmt3(d.slg)}</td>
                  <td className="px-2 py-1.5">{dirty && <span className="text-[10px] text-violet-500 font-bold">●</span>}</td>
                </tr>
              );
            })}
            {playerGames.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-6 text-center text-stone-400">No games logged for this player yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-400 mt-2">Changes save automatically when you click out of a box.</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   GAMES LIST + GAME DETAIL
--------------------------------------------------------------------------- */

function GamesListView({ games, trashedGames, lineups, onOpen, addGame, deleteGame, restoreGame, permanentlyDeleteGame }) {
  const [showNew, setShowNew] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [opponent, setOpponent] = useState("");

  const sorted = [...games].sort((a, b) => (a.date < b.date ? 1 : -1));
  const trashSorted = [...trashedGames].sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-extrabold" style={{ color: COLORS.field }}>Games</h2>
        <Btn icon={Plus} onClick={() => setShowNew((v) => !v)}>New Game</Btn>
      </div>

      {showNew && (
        <div className="flex items-end gap-3 mb-4 p-3 rounded-lg" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
          <div>
            <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block mt-1 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: COLORS.line }} />
          </div>
          <div>
            <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Opponent (optional)</label>
            <input value={opponent} onChange={(e) => setOpponent(e.target.value)} className="block mt-1 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: COLORS.line }} placeholder="e.g. St. Andrew's" />
          </div>
          <Btn icon={Save} onClick={() => { addGame(date, opponent); setOpponent(""); setShowNew(false); }}>Create</Btn>
        </div>
      )}

      <div className="grid gap-2">
        {sorted.map((g) => (
          <div key={g.id} onClick={() => onOpen(g.id)} className="flex items-center justify-between p-3 rounded-lg cursor-pointer hover:bg-violet-50/50" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
            <div>
              <div className="font-bold" style={{ color: COLORS.field }}>{g.date} {g.opponent && <span className="text-stone-500 font-normal">vs {g.opponent}</span>}</div>
              <div className="text-xs text-stone-400 flex items-center gap-2">
                <span>{(g.roster || []).length} player{(g.roster || []).length === 1 ? "" : "s"} logged</span>
                {lineups[g.id] && (
                  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: COLORS.field, color: "white" }}>
                    Lineup set
                  </span>
                )}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); deleteGame(g.id); }} className="text-stone-400 hover:text-red-700" title="Move to recycle bin">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {sorted.length === 0 && <div className="text-center text-stone-400 py-8">No games yet. Create one to start logging stats.</div>}
      </div>

      <div className="mt-6">
        <button onClick={() => setShowTrash((v) => !v)} className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide" style={{ color: COLORS.field }}>
          <Trash2 size={13} /> Recycle Bin {trashSorted.length > 0 ? `(${trashSorted.length})` : ""}
        </button>
        {showTrash && (
          <div className="grid gap-2 mt-2">
            {trashSorted.length === 0 && <div className="text-center text-stone-400 py-4 text-sm">Nothing in the recycle bin.</div>}
            {trashSorted.map((entry) => (
              <div key={entry.game.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: "#EFF1FE", border: `1px solid ${COLORS.line}` }}>
                <div>
                  <div className="font-bold text-sm" style={{ color: COLORS.ink }}>
                    {entry.game.date} {entry.game.opponent && <span className="text-stone-500 font-normal">vs {entry.game.opponent}</span>}
                  </div>
                  <div className="text-xs text-stone-400">Deleted {new Date(entry.deletedAt).toLocaleString()}</div>
                </div>
                <div className="flex gap-2">
                  <Btn small variant="ghost" icon={RotateCcw} onClick={() => restoreGame(entry.game.id)}>Restore</Btn>
                  <ConfirmDelete label="Delete forever" onConfirm={() => permanentlyDeleteGame(entry.game.id)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GameDetailView({ game, players, stats, lineups, onBack, setRoster, updateLine }) {
  const [pickerOpen, setPickerOpen] = useState((game.roster || []).length === 0);
  const [checked, setChecked] = useState(new Set(game.roster || []));

  const rosterIds = game.roster || [];
  const rosterPlayers = players.filter((p) => rosterIds.includes(p.id));
  const lineupOrder = lineups[game.id] || null;

  const togglePick = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm font-bold mb-3" style={{ color: COLORS.field }}>
        <ChevronLeft size={16} /> Back to games
      </button>
      <h2 className="text-xl font-extrabold mb-1" style={{ color: COLORS.field }}>{game.date} {game.opponent && <span className="text-stone-500 font-normal">vs {game.opponent}</span>}</h2>

      {pickerOpen ? (
        <div className="mt-4">
          <p className="text-sm mb-2" style={{ color: "#6B6280" }}>Select who played in this game:</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            {players.map((p) => (
              <label key={p.id} className="flex items-center gap-2 p-2 rounded-md cursor-pointer" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
                <input type="checkbox" checked={checked.has(p.id)} onChange={() => togglePick(p.id)} />
                <span className="text-sm font-medium" style={{ color: COLORS.ink }}>{p.name}</span>
                <GenderPill gender={p.gender} />
              </label>
            ))}
          </div>
          <Btn icon={Save} onClick={() => { setRoster(game.id, Array.from(checked)); setPickerOpen(false); }}>Confirm Roster</Btn>
        </div>
      ) : (
        <>
          <div className="flex justify-between items-center mt-2 mb-2 flex-wrap gap-2">
            <p className="text-sm" style={{ color: "#6B6280" }}>
              {lineupOrder
                ? "Players below are ordered by the saved batting lineup. Enter stats below, they save automatically as you click out of each box."
                : "Enter stats below. They save automatically as you click out of each box."}
            </p>
            <Btn variant="ghost" small onClick={() => { setChecked(new Set(rosterIds)); setPickerOpen(true); }}>Edit roster</Btn>
          </div>
          <GameStatsTable game={game} players={rosterPlayers} stats={stats} updateLine={updateLine} lineupOrder={lineupOrder} />
        </>
      )}
    </div>
  );
}

function GameStatsTable({ game, players, stats, updateLine, lineupOrder }) {
  const bump = (playerId, field, delta, alsoAB) => {
    const current = lineFor(stats, game.id, playerId);
    const patch = { [field]: Math.max(0, (Number(current[field]) || 0) + delta) };
    if (alsoAB) patch.ab = Math.max(0, (Number(current.ab) || 0) + delta);
    updateLine(game.id, playerId, { ...current, ...patch });
  };

  const orderedPlayers = lineupOrder
    ? [...players].sort((a, b) => {
        const ia = lineupOrder.indexOf(a.id);
        const ib = lineupOrder.indexOf(b.id);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      })
    : players;

  return (
    <div className="grid gap-3">
      {orderedPlayers.map((p) => {
        const line = lineFor(stats, game.id, p.id);
        const d = derive(line);
        const battingNumber = lineupOrder ? lineupOrder.indexOf(p.id) : -1;
        return (
          <div key={p.id} className="rounded-lg p-3" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-2">
                {battingNumber !== -1 && (
                  <span className="font-mono font-extrabold w-5 text-center text-sm" style={{ color: COLORS.clay }}>{battingNumber + 1}</span>
                )}
                <span className="font-bold" style={{ color: COLORS.ink }}>{p.name}</span>
                <GenderPill gender={p.gender} />
              </div>
              <span className="text-xs font-mono text-stone-500">
                {d.ab} AB · {d.h} H · OBP {fmt3(d.obp)} · SLG {fmt3(d.slg)} · {line.rbi || 0} RBI
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <Stepper label="AB" value={line.ab || 0} accent={COLORS.field}
                onDec={() => bump(p.id, "ab", -1, false)}
                onInc={() => bump(p.id, "ab", 1, false)} />
              <Stepper label="1B" value={line.s || 0} accent={COLORS.turf}
                onDec={() => bump(p.id, "s", -1, true)}
                onInc={() => bump(p.id, "s", 1, true)} />
              <Stepper label="2B" value={line.d || 0} accent={COLORS.turf}
                onDec={() => bump(p.id, "d", -1, true)}
                onInc={() => bump(p.id, "d", 1, true)} />
              <Stepper label="3B" value={line.t || 0} accent={COLORS.turf}
                onDec={() => bump(p.id, "t", -1, true)}
                onInc={() => bump(p.id, "t", 1, true)} />
              <Stepper label="HR" value={line.hr || 0} accent={COLORS.clay}
                onDec={() => bump(p.id, "hr", -1, true)}
                onInc={() => bump(p.id, "hr", 1, true)} />
              <Stepper label="RBI" value={line.rbi || 0} accent={COLORS.mustard}
                onDec={() => bump(p.id, "rbi", -1, false)}
                onInc={() => bump(p.id, "rbi", 1, false)} />
            </div>
            <p className="text-[11px] text-stone-400 mt-2">
              Tap 1B / 2B / 3B / HR to log a hit, that adds one at-bat for you automatically. Use the AB stepper by itself to log an out. Bump RBI right after the play that drove the run in.
            </p>
          </div>
        );
      })}
      {players.length === 0 && (
        <div className="px-3 py-6 text-center text-stone-400 rounded-lg" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
          No players on this roster yet.
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   LINEUP BUILDER
--------------------------------------------------------------------------- */

function LineupView({ players, games, stats, historical, lineups, saveLineup, teamName }) {
  const [gameId, setGameId] = useState("");
  const [checked, setChecked] = useState(new Set());
  const [order, setOrder] = useState(null);

  const sortedGames = [...games].sort((a, b) => (a.date < b.date ? 1 : -1));
  const playersById = useMemo(() => Object.fromEntries(players.map((p) => [p.id, p])), [players]);

  useEffect(() => {
    if (gameId) {
      const g = games.find((x) => x.id === gameId);
      setChecked(new Set(g?.roster || []));
      setOrder(lineups[gameId] || null);
    }
  }, [gameId]);

  const togglePick = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const generate = () => {
    const selected = Array.from(checked);
    const cumById = {};
    selected.forEach((id) => { cumById[id] = cumulativeFor(id, stats, historical); });
    setOrder(buildLineup(selected, playersById, cumById));
  };

  const move = (idx, dir) => {
    setOrder((cur) => {
      const arr = [...cur];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return arr;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return arr;
    });
  };

  const genders = order ? order.map((id) => playersById[id]?.gender || "M") : [];
  const maxMaleRun = order ? maxRunCyclic(genders, "M") : 0;
  const maxFemaleRun = order ? maxRunCyclic(genders, "F") : 0;
  const maleRuleOk = maxMaleRun <= 3;
  const femaleRunOk = maxFemaleRun <= 2;

  return (
    <div>
      <h2 className="text-xl font-extrabold mb-1" style={{ color: COLORS.field }}>Lineup Builder</h2>
      <p className="text-sm mb-4" style={{ color: "#6B6280" }}>
        Picks table-setters (high OBP) for the top of the order, power/RBI hitters in the heart of the order, never stacks more than 3 men in a row, and tries to avoid more than 2 women in a row, wrapping from the bottom of the order back to the top. The women's cap is a soft rule, a clearly elite hitter can stay in place rather than always being bumped out.
      </p>

      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Game (optional)</label>
          <select value={gameId} onChange={(e) => setGameId(e.target.value)} className="block mt-1 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: COLORS.line }}>
            <option value="">— no game / custom —</option>
            {sortedGames.map((g) => <option key={g.id} value={g.id}>{g.date} {g.opponent ? `vs ${g.opponent}` : ""}</option>)}
          </select>
        </div>
      </div>

      <p className="text-sm font-bold uppercase tracking-wide mb-2" style={{ color: COLORS.field }}>Available players for this lineup</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        {players.map((p) => (
          <label key={p.id} className="flex items-center gap-2 p-2 rounded-md cursor-pointer" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
            <input type="checkbox" checked={checked.has(p.id)} onChange={() => togglePick(p.id)} />
            <span className="text-sm font-medium">{p.name}</span>
            <GenderPill gender={p.gender} />
          </label>
        ))}
      </div>

      <div className="flex gap-2 mb-4">
        <Btn icon={RefreshCw} onClick={generate} disabled={checked.size === 0}>Generate Lineup</Btn>
        {order && gameId && <Btn variant="accent" icon={Save} onClick={() => saveLineup(gameId, order)}>Save to Game</Btn>}
        {order && <Btn variant="ghost" icon={Printer} onClick={() => window.print()}>Print Lineup</Btn>}
      </div>

      {order && (
        <div className="rounded-lg p-4" style={{ background: "#EFF1FE", border: `2px solid ${COLORS.mustard}` }}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-extrabold uppercase tracking-wide text-sm" style={{ color: COLORS.field }}>Suggested Batting Order</h3>
            <div className="flex gap-2">
              <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ background: maleRuleOk ? COLORS.field : "#9B3A1F", color: "white" }}>
                {maleRuleOk ? "Men's rule satisfied" : `Warning: ${maxMaleRun} men in a row`}
              </span>
              <span className="text-xs font-bold px-2 py-1 rounded-full" style={{ background: femaleRunOk ? COLORS.field : COLORS.clay, color: "white" }}>
                {femaleRunOk ? "Women's rule satisfied" : `${maxFemaleRun} women in a row (stats exception)`}
              </span>
            </div>
          </div>
          <ol className="grid gap-1.5">
            {order.map((id, idx) => {
              const p = playersById[id];
              const c = cumulativeFor(id, stats, historical);
              const estimated = c.ab === 0;
              return (
                <li key={id} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
                  <span className="font-mono font-extrabold w-6 text-center" style={{ color: COLORS.clay }}>{idx + 1}</span>
                  <span className="flex-1 font-semibold" style={{ color: COLORS.ink }}>{p?.name || "—"}</span>
                  <GenderPill gender={p?.gender} />
                  {estimated ? (
                    <span className="text-xs font-mono" style={{ color: COLORS.turf }} title="No at-bats logged yet, slotted using their skill level instead">
                      Est. from skill level{p?.skillTier ? ` (${SKILL_TIERS.find((t) => t.value === p.skillTier)?.label || p.skillTier})` : " (no level set)"}
                    </span>
                  ) : (
                    <span className="text-xs font-mono text-stone-500">OBP {fmt3(c.obp)} · SLG {fmt3(c.slg)} · RBI {c.rbi}</span>
                  )}
                  <div className="flex flex-col">
                    <button onClick={() => move(idx, -1)} className="text-stone-400 hover:text-stone-700" disabled={idx === 0}><ArrowUp size={14} /></button>
                    <button onClick={() => move(idx, 1)} className="text-stone-400 hover:text-stone-700" disabled={idx === order.length - 1}><ArrowDown size={14} /></button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {order && (
        <>
          <style>{`
            .print-lineup-sheet { display: none; }
            @media print {
              body * { visibility: hidden; }
              .print-lineup-sheet, .print-lineup-sheet * { visibility: visible; }
              .print-lineup-sheet {
                display: block !important;
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                padding: 24px;
              }
            }
          `}</style>
          <div className="print-lineup-sheet">
            <h1 style={{ fontSize: "20px", fontWeight: 800, marginBottom: "2px" }}>{teamName || "Batting Lineup"}</h1>
            <p style={{ fontSize: "13px", color: "#444", marginBottom: "16px" }}>
              {(() => {
                const g = games.find((x) => x.id === gameId);
                return g ? `${g.date}${g.opponent ? ` vs ${g.opponent}` : ""}` : "Batting Lineup";
              })()}
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr>
                  {["Batting number", "Name", "Gender"].map((h) => (
                    <th
                      key={h}
                      style={{ textAlign: "left", borderBottom: "2px solid #222", padding: "6px 8px", fontWeight: 800 }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.map((id, idx) => {
                  const p = playersById[id];
                  return (
                    <tr key={id}>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>{idx + 1}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>{p?.name || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>{p?.gender === "F" ? "Female" : "Male"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   HISTORICAL SEASON TOTALS (no per-game breakdown available)
--------------------------------------------------------------------------- */

function HistoryView({ players, historical, updateHistorical }) {
  const [draft, setDraft] = useState({});
  const getLine = (playerId) => draft[playerId] || historical[playerId] || emptyHistLine;
  const setField = (playerId, field, val) => setDraft((d) => ({ ...d, [playerId]: { ...getLine(playerId), [field]: val } }));
  const commit = (playerId) => { if (draft[playerId]) updateHistorical(playerId, draft[playerId]); };

  return (
    <div>
      <h2 className="text-xl font-extrabold mb-1" style={{ color: COLORS.field }}>Import Last Season's Totals</h2>
      <p className="text-sm mb-4" style={{ color: "#6B6280" }}>
        Enter at-bats, total hits, total bases run, and RBI for each player. These get folded into their career OBP, SLG, and RBI everywhere
        in the app, including the lineup builder, but won't show up as an individual game in their game log since there's no game-by-game
        breakdown for them. Total bases (not hit-type counts) is all that's needed here: a single counts as 1 base, a double 2, a triple 3,
        a home run 4, so SLG comes out the same either way.
      </p>
      <div className="overflow-x-auto rounded-lg" style={{ border: `1px solid ${COLORS.line}`, background: "white" }}>
        <table className="w-full text-sm">
          <thead style={{ background: "#EAE4F7" }}>
            <tr>
              {["Player", "AB", "H", "Total Bases", "RBI", "OBP", "SLG"].map((h) => (
                <th key={h} className="px-2 py-2 text-xs font-bold uppercase tracking-wider" style={{ color: COLORS.field }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const line = getLine(p.id);
              const d = deriveTotals(line);
              return (
                <tr key={p.id} className="border-t" style={{ borderColor: COLORS.line }}>
                  <td className="px-2 py-1.5 font-semibold flex items-center gap-2">{p.name} <GenderPill gender={p.gender} /></td>
                  {["ab", "h", "tb", "rbi"].map((f) => (
                    <td key={f} className="px-1 py-1.5">
                      <NumBox value={line[f] ?? 0} onChange={(v) => setField(p.id, f, v)} onBlur={() => commit(p.id)} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 font-mono tabular-nums font-bold" style={{ color: COLORS.field }}>{fmt3(d.obp)}</td>
                  <td className="px-2 py-1.5 font-mono tabular-nums font-bold" style={{ color: COLORS.clay }}>{fmt3(d.slg)}</td>
                </tr>
              );
            })}
            {players.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-stone-400">Add players on the Team Stats tab first.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-400 mt-2">Changes save automatically when you click out of a box.</p>
    </div>
  );
}


/* ---------------------------------------------------------------------------
   TEAMS HOME (pick a team, or start a new one)
--------------------------------------------------------------------------- */

function TeamsHome({ teams, onCreate, onOpen, onRename, onDelete }) {
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  return (
    <div className="min-h-full w-full" style={{ background: COLORS.bg, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: COLORS.field }}>
        <div className="max-w-3xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-extrabold tracking-tight" style={{ color: COLORS.bg }}>🥎 MCBC Softball Stat Tracker</h1>
          <p className="text-xs" style={{ color: "rgba(245,243,252,0.6)" }}>Pick a team to open, or start a new one.</p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-extrabold" style={{ color: COLORS.field }}>Teams</h2>
          <Btn icon={Plus} onClick={() => setShowNew((v) => !v)}>New Team</Btn>
        </div>

        {showNew && (
          <div className="flex items-end gap-3 mb-4 p-3 rounded-lg" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
            <div>
              <label className="text-xs font-bold uppercase" style={{ color: COLORS.field }}>Team name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="block mt-1 rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: COLORS.line }}
                placeholder="e.g. MCBC Thunder"
              />
            </div>
            <Btn icon={Save} onClick={() => { if (!name.trim()) return; onCreate(name.trim()); setName(""); setShowNew(false); }}>Create</Btn>
          </div>
        )}

        <div className="grid gap-2">
          {teams.map((t) => {
            const isEditing = editingId === t.id;
            return (
              <div
                key={t.id}
                onClick={() => !isEditing && onOpen(t.id)}
                className="flex items-center justify-between p-3 rounded-lg cursor-pointer hover:bg-violet-50/50"
                style={{ background: "white", border: `1px solid ${COLORS.line}` }}
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-md border px-2 py-1 text-sm"
                    style={{ borderColor: COLORS.line }}
                  />
                ) : (
                  <span className="font-bold" style={{ color: COLORS.ink }}>{t.name}</span>
                )}
                <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {isEditing ? (
                    <>
                      <button
                        onClick={() => { if (editName.trim()) onRename(t.id, editName.trim()); setEditingId(null); }}
                        className="text-stone-500 hover:text-green-700"
                      >
                        <Save size={15} />
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-stone-400 hover:text-stone-600"><X size={15} /></button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setEditingId(t.id); setEditName(t.name); }} className="text-stone-400 hover:text-stone-700"><Pencil size={14} /></button>
                      <ConfirmDelete label="Delete team" onConfirm={() => onDelete(t.id)} />
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {teams.length === 0 && (
            <div className="text-center text-stone-400 py-10 rounded-lg" style={{ background: "white", border: `1px solid ${COLORS.line}` }}>
              No teams yet. Create one to start tracking stats.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   TEAM WORKSPACE (everything scoped to a single selected team)
--------------------------------------------------------------------------- */

function TeamWorkspace({
  teamId, teamName, onExit,
  allPlayers, setAllPlayers,
  allGames, setAllGames,
  allStats, setAllStats,
  allLineups, setAllLineups,
  allHistorical, setAllHistorical,
  allTrash, setAllTrash,
}) {
  const players = allPlayers[teamId] || [];
  const games = allGames[teamId] || [];
  const stats = allStats[teamId] || {};
  const lineups = allLineups[teamId] || {};
  const historical = allHistorical[teamId] || {};
  const trashedGames = allTrash[teamId] || [];

  const [tab, setTab] = useState("team");
  const [openPlayerId, setOpenPlayerId] = useState(null);
  const [openGameId, setOpenGameId] = useState(null);

  const setPlayers = (next) => { const nextAll = { ...allPlayers, [teamId]: next }; setAllPlayers(nextAll); saveKey(KEYS.PLAYERS, nextAll); };
  const setGamesState = (next) => { const nextAll = { ...allGames, [teamId]: next }; setAllGames(nextAll); saveKey(KEYS.GAMES, nextAll); };
  const setStatsState = (next) => { const nextAll = { ...allStats, [teamId]: next }; setAllStats(nextAll); saveKey(KEYS.STATS, nextAll); };
  const setLineupsState = (next) => { const nextAll = { ...allLineups, [teamId]: next }; setAllLineups(nextAll); saveKey(KEYS.LINEUPS, nextAll); };
  const setHistoricalState = (next) => { const nextAll = { ...allHistorical, [teamId]: next }; setAllHistorical(nextAll); saveKey(KEYS.HISTORICAL, nextAll); };
  const setTrashState = (next) => { const nextAll = { ...allTrash, [teamId]: next }; setAllTrash(nextAll); saveKey(KEYS.TRASH, nextAll); };

  const addPlayer = (name, gender, skillTier) => {
    const next = [...players, { id: uid("p"), name, gender, skillTier: skillTier || null, skillNote: "" }];
    setPlayers(next);
  };
  const updatePlayer = (id, patch) => {
    const next = players.map((p) => (p.id === id ? { ...p, ...patch } : p));
    setPlayers(next);
  };
  const deletePlayer = (id) => {
    const next = players.filter((p) => p.id !== id);
    setPlayers(next);
    const nextStats = { ...stats };
    Object.keys(nextStats).forEach((k) => { if (k.split("::")[1] === id) delete nextStats[k]; });
    setStatsState(nextStats);
    const nextGames = games.map((g) => ({ ...g, roster: (g.roster || []).filter((pid) => pid !== id) }));
    setGamesState(nextGames);
    const nextHist = { ...historical }; delete nextHist[id];
    setHistoricalState(nextHist);
    if (openPlayerId === id) { setOpenPlayerId(null); setTab("team"); }
  };

  const addGame = (date, opponent) => {
    const next = [...games, { id: uid("g"), date, opponent, roster: [] }];
    setGamesState(next);
  };
  const deleteGame = (id) => {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    const gameStats = {};
    Object.entries(stats).forEach(([k, v]) => { if (k.split("::")[0] === id) gameStats[k] = v; });
    const trashEntry = { game, stats: gameStats, lineup: lineups[id] || null, deletedAt: new Date().toISOString() };
    setTrashState([...trashedGames, trashEntry]);

    const next = games.filter((g) => g.id !== id);
    setGamesState(next);
    const nextStats = { ...stats };
    Object.keys(nextStats).forEach((k) => { if (k.split("::")[0] === id) delete nextStats[k]; });
    setStatsState(nextStats);
    const nextLineups = { ...lineups }; delete nextLineups[id];
    setLineupsState(nextLineups);
    if (openGameId === id) { setOpenGameId(null); }
  };

  const restoreGame = (gameId) => {
    const entry = trashedGames.find((t) => t.game.id === gameId);
    if (!entry) return;
    setGamesState([...games, entry.game]);
    setStatsState({ ...stats, ...entry.stats });
    if (entry.lineup) setLineupsState({ ...lineups, [gameId]: entry.lineup });
    setTrashState(trashedGames.filter((t) => t.game.id !== gameId));
  };

  const permanentlyDeleteGame = (gameId) => {
    setTrashState(trashedGames.filter((t) => t.game.id !== gameId));
  };
  const setRoster = (gameId, roster) => {
    const next = games.map((g) => (g.id === gameId ? { ...g, roster } : g));
    setGamesState(next);
  };

  const updateLine = (gameId, playerId, line) => {
    const next = { ...stats, [statKey(gameId, playerId)]: { ...emptyLine, ...line } };
    setStatsState(next);
  };

  const saveLineup = (gameId, order) => {
    setLineupsState({ ...lineups, [gameId]: order });
  };

  const updateHistorical = (playerId, line) => {
    setHistoricalState({ ...historical, [playerId]: { ...emptyHistLine, ...line } });
  };

  const openPlayer = players.find((p) => p.id === openPlayerId);
  const openGame = games.find((g) => g.id === openGameId);

  return (
    <div className="min-h-full w-full" style={{ background: COLORS.bg, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: COLORS.field }}>
        <div className="max-w-5xl mx-auto px-4">
          <div className="py-4">
            <button onClick={onExit} className="flex items-center gap-1 text-xs font-bold mb-1" style={{ color: "rgba(245,243,252,0.75)" }}>
              <ChevronLeft size={13} /> All Teams
            </button>
            <h1 className="text-2xl font-extrabold tracking-tight" style={{ color: COLORS.bg }}>🥎 {teamName}</h1>
            <p className="text-xs" style={{ color: "rgba(245,243,252,0.6)" }}>MCBC Softball Stat Tracker</p>
          </div>
          <div className="flex gap-1">
            <TabBtn active={tab === "team"} onClick={() => { setTab("team"); setOpenPlayerId(null); }} icon={Table2}>Team Stats</TabBtn>
            <TabBtn active={tab === "games"} onClick={() => { setTab("games"); setOpenGameId(null); }} icon={ClipboardList}>Games</TabBtn>
            <TabBtn active={tab === "lineup"} onClick={() => setTab("lineup")} icon={ListOrdered}>Lineup Builder</TabBtn>
            <TabBtn active={tab === "history"} onClick={() => setTab("history")} icon={Users}>Last Season</TabBtn>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {tab === "team" && !openPlayer && (
          <TeamView players={players} games={games} stats={stats} historical={historical} onOpenPlayer={setOpenPlayerId} addPlayer={addPlayer} updatePlayer={updatePlayer} deletePlayer={deletePlayer} />
        )}
        {tab === "team" && openPlayer && (
          <PlayerView player={openPlayer} games={games} stats={stats} historical={historical} onBack={() => setOpenPlayerId(null)} updateLine={updateLine} updatePlayer={updatePlayer} />
        )}

        {tab === "games" && !openGame && (
          <GamesListView
            games={games}
            trashedGames={trashedGames}
            lineups={lineups}
            onOpen={setOpenGameId}
            addGame={addGame}
            deleteGame={deleteGame}
            restoreGame={restoreGame}
            permanentlyDeleteGame={permanentlyDeleteGame}
          />
        )}
        {tab === "games" && openGame && (
          <GameDetailView game={openGame} players={players} stats={stats} lineups={lineups} onBack={() => setOpenGameId(null)} setRoster={setRoster} updateLine={updateLine} />
        )}

        {tab === "lineup" && (
          <LineupView players={players} games={games} stats={stats} historical={historical} lineups={lineups} saveLineup={saveLineup} teamName={teamName} />
        )}

        {tab === "history" && (
          <HistoryView players={players} historical={historical} updateHistorical={updateHistorical} />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   APP ROOT (loads teams, migrates legacy single-team data, routes between
   the Teams Home picker and a selected team's workspace)
--------------------------------------------------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState([]);
  const [activeTeamId, setActiveTeamId] = useState(null);
  const [allPlayers, setAllPlayers] = useState({});
  const [allGames, setAllGames] = useState({});
  const [allStats, setAllStats] = useState({});
  const [allLineups, setAllLineups] = useState({});
  const [allHistorical, setAllHistorical] = useState({});
  const [allTrash, setAllTrash] = useState({});

  useEffect(() => {
    (async () => {
      // 1) Already on shared storage? Just load and go.
      const sharedTeamsExist = await existsRaw(KEYS.TEAMS, true);
      if (sharedTeamsExist) {
        const [t, p, g, s, l, h, tr] = await Promise.all([
          loadRaw(KEYS.TEAMS, true, []),
          loadRaw(KEYS.PLAYERS, true, {}),
          loadRaw(KEYS.GAMES, true, {}),
          loadRaw(KEYS.STATS, true, {}),
          loadRaw(KEYS.LINEUPS, true, {}),
          loadRaw(KEYS.HISTORICAL, true, {}),
          loadRaw(KEYS.TRASH, true, {}),
        ]);
        setTeams(t); setAllPlayers(p); setAllGames(g); setAllStats(s); setAllLineups(l); setAllHistorical(h); setAllTrash(tr);
        if (t.length === 1) setActiveTeamId(t[0].id);
        setLoading(false);
        return;
      }

      // 2) Nothing shared yet. Check for private multi-team data (the version
      // just before switching to shared storage) and copy it over.
      const privateTeamsExist = await existsRaw(KEYS.TEAMS, false);
      if (privateTeamsExist) {
        const [t, p, g, s, l, h, tr] = await Promise.all([
          loadRaw(KEYS.TEAMS, false, []),
          loadRaw(KEYS.PLAYERS, false, {}),
          loadRaw(KEYS.GAMES, false, {}),
          loadRaw(KEYS.STATS, false, {}),
          loadRaw(KEYS.LINEUPS, false, {}),
          loadRaw(KEYS.HISTORICAL, false, {}),
          loadRaw(KEYS.TRASH, false, {}),
        ]);
        await Promise.all([
          saveKey(KEYS.TEAMS, t),
          saveKey(KEYS.PLAYERS, p),
          saveKey(KEYS.GAMES, g),
          saveKey(KEYS.STATS, s),
          saveKey(KEYS.LINEUPS, l),
          saveKey(KEYS.HISTORICAL, h),
          saveKey(KEYS.TRASH, tr),
        ]);
        setTeams(t); setAllPlayers(p); setAllGames(g); setAllStats(s); setAllLineups(l); setAllHistorical(h); setAllTrash(tr);
        if (t.length === 1) setActiveTeamId(t[0].id);
        setLoading(false);
        return;
      }

      // 3) Check for the very first, pre-multi-team private data shape, and
      // fold it into a single "My Team" on shared storage.
      const privatePlayersExist = await existsRaw(KEYS.PLAYERS, false);
      if (privatePlayersExist) {
        const legacyId = uid("team");
        const [lp, lg, ls, ll, lh, lt] = await Promise.all([
          loadRaw(KEYS.PLAYERS, false, []),
          loadRaw(KEYS.GAMES, false, []),
          loadRaw(KEYS.STATS, false, {}),
          loadRaw(KEYS.LINEUPS, false, {}),
          loadRaw(KEYS.HISTORICAL, false, {}),
          loadRaw(KEYS.TRASH, false, []),
        ]);
        const newTeams = [{ id: legacyId, name: "My Team" }];
        const newPlayers = { [legacyId]: lp };
        const newGames = { [legacyId]: lg };
        const newStats = { [legacyId]: ls };
        const newLineups = { [legacyId]: ll };
        const newHistorical = { [legacyId]: lh };
        const newTrash = { [legacyId]: lt };
        setTeams(newTeams); setActiveTeamId(legacyId);
        setAllPlayers(newPlayers); setAllGames(newGames); setAllStats(newStats);
        setAllLineups(newLineups); setAllHistorical(newHistorical); setAllTrash(newTrash);
        await Promise.all([
          saveKey(KEYS.TEAMS, newTeams),
          saveKey(KEYS.PLAYERS, newPlayers),
          saveKey(KEYS.GAMES, newGames),
          saveKey(KEYS.STATS, newStats),
          saveKey(KEYS.LINEUPS, newLineups),
          saveKey(KEYS.HISTORICAL, newHistorical),
          saveKey(KEYS.TRASH, newTrash),
        ]);
        setLoading(false);
        return;
      }

      // 4) Brand new, nothing anywhere.
      setTeams([]); setAllPlayers({}); setAllGames({}); setAllStats({}); setAllLineups({}); setAllHistorical({}); setAllTrash({});
      setLoading(false);
    })();
  }, []);

  const createTeam = (name) => {
    const id = uid("team");
    const nextTeams = [...teams, { id, name }];
    setTeams(nextTeams); saveKey(KEYS.TEAMS, nextTeams);
    setActiveTeamId(id);
  };
  const renameTeam = (id, name) => {
    const nextTeams = teams.map((t) => (t.id === id ? { ...t, name } : t));
    setTeams(nextTeams); saveKey(KEYS.TEAMS, nextTeams);
  };
  const deleteTeam = (id) => {
    const nextTeams = teams.filter((t) => t.id !== id);
    setTeams(nextTeams); saveKey(KEYS.TEAMS, nextTeams);

    const stripTeam = (allState, setAllState, storageKey) => {
      const next = { ...allState };
      delete next[id];
      setAllState(next);
      saveKey(storageKey, next);
    };
    stripTeam(allPlayers, setAllPlayers, KEYS.PLAYERS);
    stripTeam(allGames, setAllGames, KEYS.GAMES);
    stripTeam(allStats, setAllStats, KEYS.STATS);
    stripTeam(allLineups, setAllLineups, KEYS.LINEUPS);
    stripTeam(allHistorical, setAllHistorical, KEYS.HISTORICAL);
    stripTeam(allTrash, setAllTrash, KEYS.TRASH);

    if (activeTeamId === id) setActiveTeamId(null);
  };

  if (loading) {
    return <div className="p-10 text-center" style={{ color: COLORS.field }}>Loading…</div>;
  }

  if (!activeTeamId) {
    return <TeamsHome teams={teams} onCreate={createTeam} onOpen={setActiveTeamId} onRename={renameTeam} onDelete={deleteTeam} />;
  }

  const activeTeam = teams.find((t) => t.id === activeTeamId);

  return (
    <TeamWorkspace
      teamId={activeTeamId}
      teamName={activeTeam?.name || "Team"}
      onExit={() => setActiveTeamId(null)}
      allPlayers={allPlayers} setAllPlayers={setAllPlayers}
      allGames={allGames} setAllGames={setAllGames}
      allStats={allStats} setAllStats={setAllStats}
      allLineups={allLineups} setAllLineups={setAllLineups}
      allHistorical={allHistorical} setAllHistorical={setAllHistorical}
      allTrash={allTrash} setAllTrash={setAllTrash}
    />
  );
}
