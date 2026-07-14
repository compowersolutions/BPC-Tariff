import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { createClient } from "@supabase/supabase-js";
import "./App.css";

/* ---------------------------------------------------------------
   SUPABASE CONFIG — now read from environment variables, NOT
   hardcoded here. This means re-pasting a future version of this
   file will never wipe out your credentials again.

   Create a file named `.env.local` in your project root (same
   folder as package.json) containing:

     VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
     VITE_SUPABASE_ANON_KEY=your-anon-public-key
     VITE_SETUP_PASSWORD=your-chosen-setup-password

   Vite loads .env.local automatically — restart `npm run dev`
   after creating/editing it. Never commit .env.local to git
   (add it to .gitignore) — .env.example (no real values) is fine
   to commit as a template for teammates.
----------------------------------------------------------------- */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SETUP_PASSWORD = import.meta.env.VITE_SETUP_PASSWORD || ""; // gates ratchet%/window edits — UI convenience only, not real security

const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = supabaseConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/* ---------------------------------------------------------------
   BPC TARIFF DATA — 1 July 2025, VAT inclusive (as published)
   Ex-VAT rate = published rate / 1.14
   VAT (14%) is applied to (Fixed + Energy + Demand) only.
   Levy (P0.10/kWh) is added AFTER VAT — not itself VAT-able.
----------------------------------------------------------------- */
const VAT_RATE = 0.14;
const LEVY_RATE = 0.10;

const TARIFFS = {
  TOU4: {
    label: "Domestic",
    code: "TOU4",
    fixed: 32.22,
    demandRate: 0,
    tiered: true,
    tierLimit: 200,
    tier1Rate: 0.6887,
    tier2Rate: 1.4346,
  },
  TOU6: {
    label: "Small Business",
    code: "TOU6",
    fixed: 131.16,
    demandRate: 0,
    tiered: true,
    tierLimit: 500,
    tier1Rate: 1.4286,
    tier2Rate: 2.2065,
  },
  TOU7: {
    label: "Medium Business",
    code: "TOU7",
    fixed: 131.16,
    demandRate: 353.1668,
    tiered: false,
    energyRate: 1.2589,
  },
  TOU8L: {
    label: "Large Business",
    code: "TOU8",
    fixed: 131.16,
    demandRate: 332.4329,
    tiered: false,
    energyRate: 1.1350,
  },
  TOU8M: {
    label: "Mining",
    code: "TOU8",
    fixed: 131.16,
    demandRate: 356.1781,
    tiered: false,
    energyRate: 1.2161,
  },
  TOU2: {
    label: "Government",
    code: "TOU2",
    fixed: 131.16,
    demandRate: 0,
    tiered: false,
    energyRate: 3.3996,
  },
  TOU1: {
    label: "Water Pumping",
    code: "TOU1",
    fixed: 131.16,
    demandRate: 0,
    tiered: false,
    energyRate: 2.3608,
  },
};

const TOU_KEYS = Object.keys(TARIFFS);
const TOU_COLORS = {
  TOU4: "#F2A93B",
  TOU6: "#00A99A",
  TOU7: "#8A6FD6",
  TOU8L: "#E8546A",
  TOU8M: "#3E7CB1",
  TOU2: "#7CA23C",
  TOU1: "#E0894F",
};

const METRICS = [
  { key: "total", label: "Total", dash: "0" },
  { key: "energy", label: "Electricity charge", dash: "6 3" },
  { key: "demand", label: "Demand charge", dash: "2 3" },
  { key: "fixed", label: "Fixed Charge", dash: "8 4 2 4" },
  { key: "levy", label: "Levy", dash: "1 4" },
];

/* Ex-VAT helper */
const exVat = (v) => v / (1 + VAT_RATE);

function energyExVat(t, kWh) {
  if (t.tiered) {
    if (kWh <= t.tierLimit) return kWh * exVat(t.tier1Rate);
    return t.tierLimit * exVat(t.tier1Rate) + (kWh - t.tierLimit) * exVat(t.tier2Rate);
  }
  return kWh * exVat(t.energyRate);
}

function computeBill(tariffKey, kWh, demandKW) {
  const t = TARIFFS[tariffKey];
  if (!t || !isFinite(kWh) || kWh < 0) return null;
  const fixed = exVat(t.fixed);
  const energy = energyExVat(t, kWh);
  const demand = t.demandRate > 0 ? Math.max(0, demandKW || 0) * exVat(t.demandRate) : 0;
  const subtotal = fixed + energy + demand;
  const vat = subtotal * VAT_RATE;
  const levy = kWh * LEVY_RATE;
  const total = subtotal + vat + levy;
  return { fixed, energy, demand, subtotal, vat, levy, total, kWh, demandKW: demandKW || 0 };
}

/* ---------------------------------------------------------------
   MAXIMUM DEMAND RATCHET ENGINE
   Rule (as confirmed with the client):
   - Reference floor = ratchetPct% of the highest RAW READING in the
     trailing window (6 or 12 months), recomputed fresh each month —
     NEVER from billed amounts, so an expired peak correctly decays
     out of the window instead of re-inflating itself forever.
   - If the window isn't fully populated yet (new user, history still
     filling up), fall back to a last-month-only rule:
       · if last month's reading === last month's billed, last month
         WAS the max-setter → floor = ratchetPct% × last month's billed
       · otherwise → floor = last month's billed (already ratcheted)
   - Billed demand this month = max(floor, current reading)
----------------------------------------------------------------- */
const DEFAULT_RATCHET_PCT = 90;

function computeRatchetFloor(history, windowSize, ratchetPct) {
  if (!history || history.length === 0) return { floor: 0, mode: "no-history", basis: null };

  // Sort most-recent month first
  const sorted = [...history].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  const windowEntries = sorted.slice(0, windowSize);
  const fullWindow = windowEntries.length >= windowSize;

  if (fullWindow) {
    const maxReading = Math.max(...windowEntries.map((e) => Number(e.reading) || 0));
    return {
      floor: (ratchetPct / 100) * maxReading,
      mode: "full-window",
      basis: maxReading,
    };
  }

  // Fallback: last month only
  const lastMonth = sorted[0];
  const wasMaxSetter = Math.abs((Number(lastMonth.reading) || 0) - (Number(lastMonth.billed) || 0)) < 1e-6;
  if (wasMaxSetter) {
    return {
      floor: (ratchetPct / 100) * (Number(lastMonth.billed) || 0),
      mode: "fallback-was-max",
      basis: lastMonth.billed,
    };
  }
  return {
    floor: Number(lastMonth.billed) || 0,
    mode: "fallback-carry",
    basis: lastMonth.billed,
  };
}

const fmt = (n) =>
  "P" +
  (n || 0).toLocaleString("en-BW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Compact large numbers to at most 3 significant digits + K (e.g. 12345 -> "12.3K",
// 100000 -> "100K") — keeps axis ticks and slider labels from crowding the layout.
const formatK = (n) => {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  let s = (n / 1000).toPrecision(3);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s + "K";
};

function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleEmailAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    const fn = authMode === "login" ? supabase.auth.signInWithPassword : supabase.auth.signUp;
    const { error } = await fn({ email, password });
    if (error) setAuthError(error.message);
    setAuthBusy(false);
  };

  const handleGoogleAuth = async () => {
    setAuthError("");
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  };

  if (session === undefined) {
    return (
      <div className="auth-wrap">
        <style>{fontImports}</style>
        <div className="auth-card">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-wrap">
        <style>{fontImports}</style>
        <div className="auth-card">
          <div className="eyebrow">BPC TARIFF CALCULATOR</div>
          <h1 className="h1" style={{ marginBottom: 20 }}>
            {authMode === "login" ? "Log in" : "Create account"}
          </h1>
          <form onSubmit={handleEmailAuth}>
            <label className="field">
              <span className="field-label">Email</span>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                className="input"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {authError && <div className="warn-bad">{authError}</div>}
            <button type="submit" className="btn btn-primary btn-block" disabled={authBusy}>
              {authMode === "login" ? "Log in" : "Sign up"}
            </button>
          </form>
          <button
            className="btn btn-outline btn-block"
            style={{ marginTop: 10 }}
            onClick={handleGoogleAuth}
          >
            Continue with Google
          </button>
          <div className="validation-line" style={{ marginTop: 16, fontSize: 12.5 }}>
            {authMode === "login" ? "No account yet? " : "Already have an account? "}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); setAuthMode(authMode === "login" ? "signup" : "login"); }}
              className="link-accent"
            >
              {authMode === "login" ? "Sign up" : "Log in"}
            </a>
          </div>
        </div>
      </div>
    );
  }

  return children(session);
}

export default function App() {
  if (!supabaseConfigured) {
    return (
      <div className="auth-wrap">
        <style>{fontImports}</style>
        <div className="auth-card">
          <div className="eyebrow">SETUP NEEDED</div>
          <h1 className="h1" style={{ marginBottom: 14 }}>Supabase config missing</h1>
          <p style={{ color: "var(--muted-foreground)", fontSize: 13, lineHeight: 1.6 }}>
            Create a <code>.env.local</code> file in your project root (next to{" "}
            <code>package.json</code>) with:
          </p>
          <pre
            style={{
              background: "var(--muted)",
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              color: "var(--foreground)",
              overflowX: "auto",
            }}
          >
{`VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
VITE_SETUP_PASSWORD=your-chosen-password`}
          </pre>
          <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
            Then restart <code>npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthGate>
      {(session) => <Calculator session={session} />}
    </AuthGate>
  );
}

function Calculator({ session }) {
  const userId = session.user.id;

  /* ---------------- Ratchet setup (password-gated) ---------------- */
  const [ratchetPct, setRatchetPct] = useState(DEFAULT_RATCHET_PCT);
  const [mdWindow, setMdWindow] = useState(12); // 6 or 12
  const [effectiveWindow, setEffectiveWindow] = useState(12); // only steps down on high->low switch
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [setupPasswordInput, setSetupPasswordInput] = useState("");
  const [setupError, setSetupError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  // High -> low window change recomputes/rechecks immediately.
  // Low -> high does NOT take effect until the next month's save.
  useEffect(() => {
    if (mdWindow < effectiveWindow) setEffectiveWindow(mdWindow);
  }, [mdWindow]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlockSetup = () => {
    if (setupPasswordInput === SETUP_PASSWORD) {
      setSetupUnlocked(true);
      setSetupError("");
    } else {
      setSetupError("Incorrect password.");
    }
  };

  /* ---------------- MD history (per-user, from Supabase) ---------------- */
  const [mdHistory, setMdHistory] = useState([]); // [{month:'2026-05', reading, billed}]
  const [historyLoading, setHistoryLoading] = useState(true);
  const [newHistMonth, setNewHistMonth] = useState("");
  const [newHistReading, setNewHistReading] = useState("");
  const [newHistBilled, setNewHistBilled] = useState("");

  useEffect(() => {
    (async () => {
      setHistoryLoading(true);
      const { data, error } = await supabase
        .from("md_history")
        .select("month, reading, billed")
        .eq("user_id", userId)
        .order("month", { ascending: false })
        .limit(12);
      if (!error && data) setMdHistory(data);
      setHistoryLoading(false);
    })();
  }, [userId]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("user_settings")
        .select("ratchet_pct, md_window")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) {
        if (data.ratchet_pct) setRatchetPct(data.ratchet_pct);
        if (data.md_window) { setMdWindow(data.md_window); setEffectiveWindow(data.md_window); }
      }
    })();
  }, [userId]);

  const saveSetup = async () => {
    await supabase.from("user_settings").upsert({
      user_id: userId,
      ratchet_pct: ratchetPct,
      md_window: mdWindow,
    });
  };

  const addHistoryEntry = async () => {
    if (!newHistMonth || newHistReading === "" || newHistBilled === "") return;
    const entry = {
      user_id: userId,
      month: newHistMonth,
      reading: parseFloat(newHistReading) || 0,
      billed: parseFloat(newHistBilled) || 0,
    };
    const { error } = await supabase.from("md_history").upsert(entry, { onConflict: "user_id,month" });
    if (!error) {
      setMdHistory((prev) => [entry, ...prev.filter((e) => e.month !== entry.month)]);
      setNewHistMonth("");
      setNewHistReading("");
      setNewHistBilled("");
      // A low->high window change only takes effect from here (next save) onward
      setEffectiveWindow(mdWindow);
    }
  };

  const [mode, setMode] = useState("kwh"); // 'kwh' | 'meter'
  const [kwhInput, setKwhInput] = useState("16170");
  const [opening, setOpening] = useState("34079.00");
  const [closing, setClosing] = useState("34618.00");
  const [multiplier, setMultiplier] = useState("30");
  const [tariffKey, setTariffKey] = useState("TOU7");
  const [demandKW, setDemandKW] = useState("0");
  const [billingMonth, setBillingMonth] = useState("2026-06");
  const [billingDate, setBillingDate] = useState("2026-06-17");
  const [prevMaxDemandReading, setPrevMaxDemandReading] = useState("52.100");
  const [prevMaxDemandBilled, setPrevMaxDemandBilled] = useState("48.900");
  const [meterNo, setMeterNo] = useState("84599936");

  const MAX_DEMAND_LIMIT = 744;

  const [maxKWh, setMaxKWh] = useState(30000);
  const [selectedTOUs, setSelectedTOUs] = useState(["TOU7", "TOU8L"]);
  const [selectedMetrics, setSelectedMetrics] = useState(["total"]);
  const [chartDemandKW, setChartDemandKW] = useState(50); // DM charge slider — demand (kW) assumption used for the chart
  const [yAxisMax, setYAxisMax] = useState(50000); // vertical (Y-axis) range slider — Pula

  const derivedKWh =
    mode === "kwh"
      ? parseFloat(kwhInput) || 0
      : Math.max(0, (parseFloat(closing) || 0) - (parseFloat(opening) || 0)) *
        (parseFloat(multiplier) || 1);

  const t = TARIFFS[tariffKey];
  const [billYear, billMonthNum] = billingMonth.split("-").map(Number);
  const daysInBillingMonth =
    billYear && billMonthNum ? new Date(billYear, billMonthNum, 0).getDate() : 30;
  const hours = daysInBillingMonth * 24;
  const minDemand = derivedKWh / hours;
  const demandVal = Math.min(parseFloat(demandKW) || 0, MAX_DEMAND_LIMIT);

  // Auto-suggest demand = kWh ÷ (24 × days in month) until the user types
  // into the demand field themselves — after that, it's fully manual.
  const demandTouchedRef = useRef(false);
  useEffect(() => {
    if (!demandTouchedRef.current) {
      setDemandKW(minDemand > 0 ? minDemand.toFixed(3) : "0");
    }
  }, [minDemand]);

  // Default the previous-month manual fields from the actual stored history
  // (last entry = "our logic using previous 12 months"), once, without
  // overwriting anything the user has since edited by hand.
  const prevMonthDefaultsSynced = useRef(false);
  useEffect(() => {
    if (!prevMonthDefaultsSynced.current && mdHistory.length > 0) {
      const sorted = [...mdHistory].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
      const last = sorted[0];
      setPrevMaxDemandReading(String(last.reading));
      setPrevMaxDemandBilled(String(last.billed));
      prevMonthDefaultsSynced.current = true;
    }
  }, [mdHistory]);

  const chartDemandSynced = useRef(false);
  useEffect(() => {
    if (!chartDemandSynced.current && demandVal > 0) {
      setChartDemandKW(demandVal);
      chartDemandSynced.current = true;
    }
  }, [demandVal]);
  const demandTooLow = t.demandRate > 0 && demandVal > 0 && demandVal < minDemand - 1e-6;

  // If Supabase history is empty (brand-new user), fall back to the two manual
  // "previous month" fields as a single-entry seed so the fallback rule still works.
  const effectiveHistory =
    mdHistory.length > 0
      ? mdHistory
      : parseFloat(prevMaxDemandReading) || parseFloat(prevMaxDemandBilled)
      ? [{
          month: "manual-previous",
          reading: parseFloat(prevMaxDemandReading) || 0,
          billed: parseFloat(prevMaxDemandBilled) || 0,
        }]
      : [];

  const ratchetResult = computeRatchetFloor(effectiveHistory, effectiveWindow, ratchetPct);
  const billedDemand = Math.max(demandVal, ratchetResult.floor);
  const bill = computeBill(tariffKey, derivedKWh, billedDemand);

  const toggleTOU = (key) =>
    setSelectedTOUs((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  const toggleMetric = (key) =>
    setSelectedMetrics((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );

  // Chart shows all components incl. VAT (the itemized bill table below
  // intentionally keeps its ex-VAT + VAT breakdown, per standard billing format).
  const inclVatKeys = new Set(["energy", "demand", "fixed"]);
  const toChartValue = (b, m) => (inclVatKeys.has(m) ? b[m] * (1 + VAT_RATE) : b[m]);

  const chartData = useMemo(() => {
    const points = 60; // fixed plotting resolution
    const rows = [];
    const step = maxKWh / points;
    for (let i = 0; i <= points; i++) {
      const kWh = Math.round(i * step);
      const row = { x: kWh };
      selectedTOUs.forEach((tk) => {
        const b = computeBill(tk, kWh, chartDemandKW);
        if (!b) return;
        selectedMetrics.forEach((m) => {
          row[`${tk}__${m}`] = Math.round(toChartValue(b, m) * 100) / 100;
        });
      });
      rows.push(row);
    }
    return rows;
  }, [maxKWh, selectedTOUs, selectedMetrics, chartDemandKW]);

  return (
    <div className="app">
      <style>{fontImports}</style>
      <header className="header">
        <div className="header-left">
          <div className="bolt-mark">⚡</div>
          <div>
            <div className="eyebrow">MILLENIUM OPTIONS · TARIFF DESK</div>
            <h1 className="h1">BPC Tariff Calculator</h1>
          </div>
        </div>
        <div className="header-actions">
          <div className="header-right">1 JULY 2025 SCHEDULE · VAT INCLUSIVE</div>
          <button className="btn btn-outline btn-sm" onClick={() => supabase.auth.signOut()}>
            Log out ({session.user.email})
          </button>
        </div>
      </header>

      {/* ---------------- MAXIMUM DEMAND RATCHET PANEL ---------------- */}
      <section className="panel">
        <div className="panel-head-row">
          <h2 className="panel-title">Maximum Demand Ratchet</h2>
          <button className="btn btn-outline btn-sm" onClick={() => setShowSetup((s) => !s)}>
            {showSetup ? "Hide setup" : "Setup"}
          </button>
        </div>

        <div className="validation-line">
          Ratchet: <b>{ratchetPct}%</b> of the highest reading in the trailing{" "}
          <b>{mdWindow}-month</b> window &nbsp;·&nbsp; Window used this calc:{" "}
          <b>{effectiveWindow} months</b> ({ratchetResult.mode.replace(/-/g, " ")})
        </div>
        <div className="validation-line">
          Ratchet floor = <b>{ratchetResult.floor.toFixed(3)} kW</b> &nbsp;→&nbsp; Billed demand ={" "}
          <b>max({demandVal.toFixed(3)}, {ratchetResult.floor.toFixed(3)}) = {billedDemand.toFixed(3)} kW</b>
        </div>

        {showSetup && (
          <div className="setup-section">
            {!setupUnlocked ? (
              <div className="meter-row">
                <label className="field">
                  <span className="field-label">Setup password</span>
                  <input
                    className="input"
                    type="password"
                    value={setupPasswordInput}
                    onChange={(e) => setSetupPasswordInput(e.target.value)}
                  />
                </label>
                <div className="field-actions">
                  <button className="btn btn-primary" onClick={unlockSetup}>Unlock</button>
                </div>
                {setupError && <div className="warn-bad">{setupError}</div>}
              </div>
            ) : (
              <div className="meter-row">
                <label className="field">
                  <span className="field-label">Ratchet % (default 90)</span>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    max="100"
                    value={ratchetPct}
                    onChange={(e) => setRatchetPct(parseFloat(e.target.value) || 0)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">MD window</span>
                  <select
                    className="input"
                    value={mdWindow}
                    onChange={(e) => setMdWindow(parseInt(e.target.value))}
                  >
                    <option value={6}>6 months</option>
                    <option value={12}>12 months</option>
                  </select>
                </label>
                <div className="field-full">
                  <button className="btn btn-primary" onClick={saveSetup}>Save setup</button>
                </div>
              </div>
            )}

            <h3 className="panel-title" style={{ fontSize: 14, marginTop: 20 }}>Monthly MD history</h3>
            {historyLoading ? (
              <div className="validation-line">Loading history…</div>
            ) : (
              <table className="data-table">
                <tbody>
                  <tr className="data-table-muted">
                    <td>MONTH</td>
                    <td className="data-table-num">READING (kW)</td>
                    <td className="data-table-num">BILLED (kW)</td>
                  </tr>
                  {mdHistory.length === 0 && (
                    <tr><td colSpan={3} className="data-table-muted">No history saved yet — the manual "previous month" fields below will be used instead.</td></tr>
                  )}
                  {mdHistory.map((h) => (
                    <tr key={h.month}>
                      <td>{h.month}</td>
                      <td className="data-table-num">{Number(h.reading).toFixed(3)}</td>
                      <td className="data-table-num">{Number(h.billed).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="meter-row" style={{ marginTop: 12 }}>
              <label className="field">
                <span className="field-label">Add month (YYYY-MM)</span>
                <input className="input" placeholder="2026-07" value={newHistMonth}
                  onChange={(e) => setNewHistMonth(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Reading (kW)</span>
                <input className="input" type="number" step="0.001" value={newHistReading}
                  onChange={(e) => setNewHistReading(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Billed (kW)</span>
                <input className="input" type="number" step="0.001" value={newHistBilled}
                  onChange={(e) => setNewHistBilled(e.target.value)} />
              </label>
              <div className="field-actions">
                <button className="btn btn-primary" onClick={addHistoryEntry}>Add to history</button>
              </div>
            </div>
            <div className="validation-line">
              Tip: after computing this month's bill above, add {billingMonth} with reading{" "}
              {demandVal.toFixed(3)} and billed {billedDemand.toFixed(3)} to carry the ratchet forward.
            </div>
          </div>
        )}
      </section>

      <div className="grid">
        {/* ---------------- INPUT PANEL ---------------- */}
        <section className="panel panel-compact">
          <h2 className="panel-title">Consumption &amp; Category</h2>

          <div className="segmented">
            <button
              className={`segmented-btn${mode === "kwh" ? " active" : ""}`}
              onClick={() => setMode("kwh")}
            >
              Enter kWh
            </button>
            <button
              className={`segmented-btn${mode === "meter" ? " active" : ""}`}
              onClick={() => setMode("meter")}
            >
              Enter meter readings
            </button>
          </div>

          {mode === "kwh" ? (
            <label className="field">
              <span className="field-label">kWh consumed</span>
              <input
                className="input"
                type="number"
                min="0"
                value={kwhInput}
                onChange={(e) => setKwhInput(e.target.value)}
              />
            </label>
          ) : (
            <div className="meter-row">
              <label className="field">
                <span className="field-label">Meter #</span>
                <input
                  className="input"
                  value={meterNo}
                  onChange={(e) => setMeterNo(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Opening</span>
                <input
                  className="input"
                  type="number"
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Closing</span>
                <input
                  className="input"
                  type="number"
                  value={closing}
                  onChange={(e) => setClosing(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Multiplier</span>
                <input
                  className="input"
                  type="number"
                  value={multiplier}
                  onChange={(e) => setMultiplier(e.target.value)}
                />
              </label>
              <div className="derived-kwh">
                kWh = ({closing || 0} − {opening || 0}) × {multiplier || 1} ={" "}
                <b>{derivedKWh.toLocaleString()}</b>
              </div>
            </div>
          )}

          <label className="field">
            <span className="field-label">Tariff category (TOU)</span>
            <select
              className="input"
              value={tariffKey}
              onChange={(e) => setTariffKey(e.target.value)}
            >
              {TOU_KEYS.map((k) => (
                <option key={k} value={k}>
                  {TARIFFS[k].code} — {TARIFFS[k].label}
                </option>
              ))}
            </select>
          </label>

          <div className="meter-row">
            <label className="field">
              <span className="field-label">Billing month</span>
              <input
                className="input"
                type="month"
                value={billingMonth}
                onChange={(e) => setBillingMonth(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">
                Maximum demand (kW){t.demandRate === 0 ? " — n/a for this TOU" : ""}
              </span>
              <input
                className="input"
                type="number"
                step="0.001"
                min="0"
                value={demandKW}
                onChange={(e) => {
                  demandTouchedRef.current = true;
                  setDemandKW(e.target.value);
                }}
                disabled={t.demandRate === 0}
              />
            </label>
          </div>

          <div className="meter-row">
            <label className="field">
              <span className="field-label">
                Previous month's demand reading (kW)
              </span>
              <input
                className="input"
                type="number"
                step="0.001"
                min="0"
                value={prevMaxDemandReading}
                onChange={(e) => setPrevMaxDemandReading(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">
                Previous month's demand billed (kW)
              </span>
              <input
                className="input"
                type="number"
                step="0.001"
                min="0"
                value={prevMaxDemandBilled}
                onChange={(e) => setPrevMaxDemandBilled(e.target.value)}
              />
            </label>
          </div>
          <div className="validation-line">
            Defaults to last month's stored history (if available) — editable.
          </div>

          <div className="validation-line">
            Minimum plausible demand = kWh ÷ (days × 24h) = {derivedKWh.toLocaleString()} ÷{" "}
            {hours} = <b>{minDemand.toFixed(3)} kW</b>
          </div>
          {t.demandRate > 0 && (
            demandTooLow ? (
              <div className="warn-bad">
                ⚠ Entered demand ({demandVal.toFixed(3)} kW) is below the minimum plausible
                average demand for this consumption. Check your reading.
              </div>
            ) : (
              <div className="warn-ok">✓ Demand entry is consistent with consumption.</div>
            )
          )}
        </section>

        {/* ---------------- BILL PANEL ---------------- */}
        <section className="bill-wrap">
          <div className="bill-tear" />
          <div className="bill">
            <div className="bill-head-row">
              <div className="bill-logo">⚡ BOTSWANA POWER CORPORATION</div>
              <div className="bill-tag">TAX INVOICE (simulated)</div>
            </div>
            <div className="bill-meta">
              <div>Tariff category: <b>{t.code} — {t.label}</b></div>
              <div>Billing days: <b>{daysInBillingMonth}</b></div>
              {mode === "meter" && <div>Meter #: <b>{meterNo}</b></div>}
            </div>

            <table className="bill-table">
              <tbody>
                {mode === "meter" && (
                  <tr className="bill-row-muted">
                    <td>METER {meterNo} — OPENING {opening} · CLOSING {closing} · MULT {multiplier}</td>
                    <td className="bill-num">{derivedKWh.toLocaleString()} kWh</td>
                  </tr>
                )}
                <tr>
                  <td>ELECTRICITY CONSUMPTION</td>
                  <td className="bill-num">{derivedKWh.toLocaleString()} kWh</td>
                </tr>
                {t.demandRate > 0 && (
                  <tr>
                    <td>DEMAND CHARGE ({demandVal.toFixed(3)} kW read · {billedDemand.toFixed(3)} kW billed × {exVat(t.demandRate).toFixed(4)})</td>
                    <td className="bill-num">{bill ? fmt(bill.demand) : "—"}</td>
                  </tr>
                )}
                <tr>
                  <td>
                    ELECTRICITY CHARGE{" "}
                    {t.tiered
                      ? `(tiered ≤/> ${t.tierLimit} kWh)`
                      : `(${exVat(t.energyRate).toFixed(4)}/kWh)`}
                  </td>
                  <td className="bill-num">{bill ? fmt(bill.energy) : "—"}</td>
                </tr>
                <tr>
                  <td>STANDING CHARGE</td>
                  <td className="bill-num">{bill ? fmt(bill.fixed) : "—"}</td>
                </tr>
                <tr className="bill-subtotal">
                  <td>SUBTOTAL OF CURRENT CHARGES</td>
                  <td className="bill-num">{bill ? fmt(bill.subtotal) : "—"}</td>
                </tr>
                <tr>
                  <td>VAT @ 14%</td>
                  <td className="bill-num">{bill ? fmt(bill.vat) : "—"}</td>
                </tr>
                <tr>
                  <td>NATIONAL STANDARD COST LEVY ({derivedKWh.toLocaleString()} kWh × P0.10)</td>
                  <td className="bill-num">{bill ? fmt(bill.levy) : "—"}</td>
                </tr>
              </tbody>
            </table>

            <div className="bill-total-row">
              <span>TOTAL AMOUNT INCLUDING VAT</span>
              <span className="bill-total-val">{bill ? fmt(bill.total) : "—"}</span>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- CHART PANEL ---------------- */}
      <section className="panel">
        <h2 className="panel-title">Charge vs. Consumption</h2>

        <div className="chart-controls">
          <div className="control-group">
            <span className="control-label">Tariff categories</span>
            <div className="chip-row">
              {TOU_KEYS.map((k) => (
                <label
                  key={k}
                  title={`${TARIFFS[k].code} — ${TARIFFS[k].label}`}
                  className={`chip chip-compact${selectedTOUs.includes(k) ? " chip-checked" : ""}`}
                  style={{ "--chip-color": TOU_COLORS[k] }}
                >
                  <input
                    type="checkbox"
                    checked={selectedTOUs.includes(k)}
                    onChange={() => toggleTOU(k)}
                  />
                  {TARIFFS[k].code}
                </label>
              ))}
            </div>
          </div>

          <div className="control-group">
            <span className="control-label">Charge components</span>
            <div className="chip-row">
              {METRICS.map((m, i) => (
                <React.Fragment key={m.key}>
                  {i === 1 && <span className="operator-symbol">=</span>}
                  {i > 1 && <span className="operator-symbol">+</span>}
                  <label
                    className={`chip${selectedMetrics.includes(m.key) ? " chip-checked" : ""}`}
                    style={{ "--chip-color": "#6B7280" }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedMetrics.includes(m.key)}
                      onChange={() => toggleMetric(m.key)}
                    />
                    {m.label}
                  </label>
                </React.Fragment>
              ))}
            </div>
          </div>

          <label className="slider-field">
            <span className="slider-label">
              DM charge (demand assumption): {chartDemandKW.toFixed(1)} kW
            </span>
            <input
              type="range"
              min="0"
              max={MAX_DEMAND_LIMIT}
              step="0.5"
              value={chartDemandKW}
              onChange={(e) => setChartDemandKW(parseFloat(e.target.value))}
            />
          </label>

          <label className="slider-field">
            <span className="slider-label">
              X-axis range (max kWh): {formatK(maxKWh)} — demand held at{" "}
              {chartDemandKW.toFixed(1)} kW
            </span>
            <input
              type="range"
              min="300"
              max="100000"
              step="100"
              value={maxKWh}
              onChange={(e) => setMaxKWh(parseInt(e.target.value))}
            />
          </label>

        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <div className="y-slider-wrap">
            <span className="y-slider-cap">{formatK(yAxisMax)}</span>
            <div className="y-slider-track">
              <input
                type="range"
                className="slider-vertical"
                min="500"
                max="200000"
                step="500"
                value={yAxisMax}
                onChange={(e) => setYAxisMax(parseInt(e.target.value))}
              />
            </div>
          </div>

          <div style={{ width: "100%", height: 420 }}>
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 10, right: 24, left: 4, bottom: 30 }}>
                <CartesianGrid stroke="#D8DFE8" strokeDasharray="3 3" />
                <XAxis
                  dataKey="x"
                  tick={{ fill: "#5A6B85", fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }}
                  stroke="#B9C5D4"
                  tickFormatter={formatK}
                  allowDecimals={false}
                  label={{
                    value: "kWh consumed",
                    position: "insideBottom",
                    offset: -8,
                    fill: "#5A6B85",
                  }}
                />
                <YAxis
                  domain={[0, yAxisMax]}
                  allowDataOverflow={true}
                  tick={{ fill: "#5A6B85", fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }}
                  stroke="#B9C5D4"
                  tickFormatter={formatK}
                  label={{ value: "Pula (P)", angle: -90, position: "insideLeft", fill: "#5A6B85" }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#FFFFFF",
                    border: "1px solid #D8DFE8",
                    borderRadius: 8,
                    fontFamily: "IBM Plex Mono, monospace",
                    fontSize: 12,
                    boxShadow: "0 8px 24px -12px rgba(13,30,52,0.25)",
                  }}
                  labelStyle={{ color: "#1D3656", fontWeight: 600 }}
                  formatter={(v, name) => [fmt(v), name]}
                />
                <Legend
                  verticalAlign="top"
                  height={32}
                  wrapperStyle={{ fontFamily: "DM Sans, sans-serif", fontSize: 12 }}
                />
                {selectedTOUs.flatMap((tk) =>
                  selectedMetrics.map((m) => (
                    <Line
                      key={`${tk}__${m}`}
                      type="monotone"
                      dataKey={`${tk}__${m}`}
                      name={`${TARIFFS[tk].code} · ${METRICS.find((x) => x.key === m).label}`}
                    stroke={TOU_COLORS[tk]}
                    strokeDasharray={METRICS.find((x) => x.key === m).dash}
                    dot={false}
                    strokeWidth={2}
                  />
                ))
              )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <footer className="footer">
        Rates ex-VAT are derived as (published VAT-inclusive rate) ÷ 1.14. VAT (14%) applies to
        Fixed + Electricity + Demand charges only; the P0.10/kWh National Standard Cost Levy is
        added after VAT. For reference only — not an official BPC invoice.
      </footer>
    </div>
  );
}

const fontImports = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;
