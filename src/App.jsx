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
  TOU6: "#4FD1C5",
  TOU7: "#8A6FD6",
  TOU8L: "#E8546A",
  TOU8M: "#5FA8E0",
  TOU2: "#B7D65B",
  TOU1: "#E0894F",
};

const METRICS = [
  { key: "total", label: "Total", dash: "0" },
  { key: "energy", label: "Electricity charge", dash: "6 3" },
  { key: "demand", label: "Demand charge", dash: "2 3" },
  { key: "fixed", label: "Fixed / Standing charge", dash: "8 4 2 4" },
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
    return <div style={styles.authWrap}><div style={styles.authCard}>Loading…</div></div>;
  }

  if (!session) {
    return (
      <div style={styles.authWrap}>
        <div style={styles.authCard}>
          <div style={styles.eyebrow}>BPC TARIFF CALCULATOR</div>
          <h1 style={styles.h1}>{authMode === "login" ? "Log in" : "Create account"}</h1>
          <form onSubmit={handleEmailAuth}>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>Email</span>
              <input style={styles.input} type="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>Password</span>
              <input style={styles.input} type="password" required value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </label>
            {authError && <div style={styles.warnBad}>{authError}</div>}
            <button type="submit" style={styles.modeBtnActive} disabled={authBusy}>
              {authMode === "login" ? "Log in" : "Sign up"}
            </button>
          </form>
          <button style={{ ...styles.modeBtn, marginTop: 10, width: "100%" }} onClick={handleGoogleAuth}>
            Continue with Google
          </button>
          <div style={styles.validationLine}>
            {authMode === "login" ? "No account yet? " : "Already have an account? "}
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); setAuthMode(authMode === "login" ? "signup" : "login"); }}
              style={{ color: "#F2A93B" }}
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
      <div style={styles.authWrap}>
        <div style={styles.authCard}>
          <div style={styles.eyebrow}>SETUP NEEDED</div>
          <h1 style={styles.h1}>Supabase config missing</h1>
          <p style={{ color: "#9FB3C8", fontSize: 13, lineHeight: 1.6 }}>
            Create a <code>.env.local</code> file in your project root (next to{" "}
            <code>package.json</code>) with:
          </p>
          <pre style={{ background: "#0C1622", padding: 12, borderRadius: 6, fontSize: 12, color: "#9FB3C8", overflowX: "auto" }}>
{`VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
VITE_SETUP_PASSWORD=your-chosen-password`}
          </pre>
          <p style={{ color: "#9FB3C8", fontSize: 13 }}>Then restart <code>npm run dev</code>.</p>
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
  const [demandKW, setDemandKW] = useState("56.550");
  const [billingMonth, setBillingMonth] = useState("2026-06");
  const [billingDate, setBillingDate] = useState("2026-06-17");
  const [prevMaxDemandReading, setPrevMaxDemandReading] = useState("52.100");
  const [prevMaxDemandBilled, setPrevMaxDemandBilled] = useState("48.900");
  const [meterNo, setMeterNo] = useState("84599936");

  const MAX_DEMAND_LIMIT = 744;

  const [maxKWh, setMaxKWh] = useState(30000);
  const [selectedTOUs, setSelectedTOUs] = useState(["TOU7", "TOU8L"]);
  const [selectedMetrics, setSelectedMetrics] = useState(["total"]);
  const [xAxisMode, setXAxisMode] = useState("kwh"); // 'kwh' | 'demand'
  const [maxDemandAxis, setMaxDemandAxis] = useState(500);
  const [chartDemandKW, setChartDemandKW] = useState(50); // DM charge slider — demand (kW) assumption used when X-axis = kWh consumed

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
    if (xAxisMode === "kwh") {
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
    } else {
      // xAxisMode === 'demand': kWh held fixed, demand (kW) varies
      const step = maxDemandAxis / points;
      for (let i = 0; i <= points; i++) {
        const dm = Math.round(i * step * 1000) / 1000;
        const row = { x: dm };
        selectedTOUs.forEach((tk) => {
          const b = computeBill(tk, derivedKWh, dm);
          if (!b) return;
          selectedMetrics.forEach((m) => {
            row[`${tk}__${m}`] = Math.round(toChartValue(b, m) * 100) / 100;
          });
        });
        rows.push(row);
      }
    }
    return rows;
  }, [maxKWh, maxDemandAxis, xAxisMode, selectedTOUs, selectedMetrics, chartDemandKW, derivedKWh]);

  return (
    <div style={styles.app}>
      <style>{fontImports}</style>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.boltMark}>⚡</div>
          <div>
            <div style={styles.eyebrow}>MILLENIUM OPTIONS · TARIFF DESK</div>
            <h1 style={styles.h1}>BPC Tariff Calculator</h1>
          </div>
        </div>
        <div style={styles.headerRight}>1 JULY 2025 SCHEDULE · VAT INCLUSIVE</div>
        <button style={{ ...styles.modeBtn, marginLeft: 12 }} onClick={() => supabase.auth.signOut()}>
          Log out ({session.user.email})
        </button>
      </header>

      {/* ---------------- MAXIMUM DEMAND RATCHET PANEL ---------------- */}
      <section style={styles.panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ ...styles.panelTitle, margin: 0 }}>Maximum Demand Ratchet</h2>
          <button style={styles.modeBtn} onClick={() => setShowSetup((s) => !s)}>
            {showSetup ? "Hide setup" : "Setup"}
          </button>
        </div>

        <div style={styles.validationLine}>
          Ratchet: <b>{ratchetPct}%</b> of the highest reading in the trailing{" "}
          <b>{mdWindow}-month</b> window &nbsp;·&nbsp; Window used this calc:{" "}
          <b>{effectiveWindow} months</b> ({ratchetResult.mode.replace(/-/g, " ")})
        </div>
        <div style={styles.validationLine}>
          Ratchet floor = <b>{ratchetResult.floor.toFixed(3)} kW</b> &nbsp;→&nbsp; Billed demand ={" "}
          <b>max({demandVal.toFixed(3)}, {ratchetResult.floor.toFixed(3)}) = {billedDemand.toFixed(3)} kW</b>
        </div>

        {showSetup && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #24374F" }}>
            {!setupUnlocked ? (
              <div style={styles.meterRow}>
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>Setup password</span>
                  <input
                    style={styles.input}
                    type="password"
                    value={setupPasswordInput}
                    onChange={(e) => setSetupPasswordInput(e.target.value)}
                  />
                </label>
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button style={styles.modeBtnActive} onClick={unlockSetup}>Unlock</button>
                </div>
                {setupError && <div style={styles.warnBad}>{setupError}</div>}
              </div>
            ) : (
              <div style={styles.meterRow}>
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>Ratchet % (default 90)</span>
                  <input
                    style={styles.input}
                    type="number"
                    min="0"
                    max="100"
                    value={ratchetPct}
                    onChange={(e) => setRatchetPct(parseFloat(e.target.value) || 0)}
                  />
                </label>
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>MD window</span>
                  <select
                    style={styles.input}
                    value={mdWindow}
                    onChange={(e) => setMdWindow(parseInt(e.target.value))}
                  >
                    <option value={6}>6 months</option>
                    <option value={12}>12 months</option>
                  </select>
                </label>
                <div style={{ gridColumn: "1 / -1" }}>
                  <button style={styles.modeBtnActive} onClick={saveSetup}>Save setup</button>
                </div>
              </div>
            )}

            <h3 style={{ ...styles.panelTitle, fontSize: 14, marginTop: 20 }}>Monthly MD history</h3>
            {historyLoading ? (
              <div style={styles.validationLine}>Loading history…</div>
            ) : (
              <table style={styles.billTable}>
                <tbody>
                  <tr style={styles.billRowMuted}>
                    <td>MONTH</td>
                    <td style={styles.billNum}>READING (kW)</td>
                    <td style={styles.billNum}>BILLED (kW)</td>
                  </tr>
                  {mdHistory.length === 0 && (
                    <tr><td colSpan={3} style={styles.billRowMuted}>No history saved yet — the manual "previous month" fields below will be used instead.</td></tr>
                  )}
                  {mdHistory.map((h) => (
                    <tr key={h.month}>
                      <td>{h.month}</td>
                      <td style={styles.billNum}>{Number(h.reading).toFixed(3)}</td>
                      <td style={styles.billNum}>{Number(h.billed).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ ...styles.meterRow, marginTop: 12 }}>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Add month (YYYY-MM)</span>
                <input style={styles.input} placeholder="2026-07" value={newHistMonth}
                  onChange={(e) => setNewHistMonth(e.target.value)} />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Reading (kW)</span>
                <input style={styles.input} type="number" step="0.001" value={newHistReading}
                  onChange={(e) => setNewHistReading(e.target.value)} />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Billed (kW)</span>
                <input style={styles.input} type="number" step="0.001" value={newHistBilled}
                  onChange={(e) => setNewHistBilled(e.target.value)} />
              </label>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button style={styles.modeBtnActive} onClick={addHistoryEntry}>Add to history</button>
              </div>
            </div>
            <div style={styles.validationLine}>
              Tip: after computing this month's bill above, add {billingMonth} with reading{" "}
              {demandVal.toFixed(3)} and billed {billedDemand.toFixed(3)} to carry the ratchet forward.
            </div>
          </div>
        )}
      </section>

      <div style={styles.grid}>
        {/* ---------------- INPUT PANEL ---------------- */}
        <section style={styles.panel}>
          <h2 style={styles.panelTitle}>Consumption &amp; Category</h2>

          <div style={styles.modeSwitch}>
            <button
              style={mode === "kwh" ? styles.modeBtnActive : styles.modeBtn}
              onClick={() => setMode("kwh")}
            >
              Enter kWh
            </button>
            <button
              style={mode === "meter" ? styles.modeBtnActive : styles.modeBtn}
              onClick={() => setMode("meter")}
            >
              Enter meter readings
            </button>
          </div>

          {mode === "kwh" ? (
            <label style={styles.field}>
              <span style={styles.fieldLabel}>kWh consumed</span>
              <input
                style={styles.input}
                type="number"
                min="0"
                value={kwhInput}
                onChange={(e) => setKwhInput(e.target.value)}
              />
            </label>
          ) : (
            <div style={styles.meterRow}>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Meter #</span>
                <input
                  style={styles.input}
                  value={meterNo}
                  onChange={(e) => setMeterNo(e.target.value)}
                />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Opening</span>
                <input
                  style={styles.input}
                  type="number"
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Closing</span>
                <input
                  style={styles.input}
                  type="number"
                  value={closing}
                  onChange={(e) => setClosing(e.target.value)}
                />
              </label>
              <label style={styles.field}>
                <span style={styles.fieldLabel}>Multiplier</span>
                <input
                  style={styles.input}
                  type="number"
                  value={multiplier}
                  onChange={(e) => setMultiplier(e.target.value)}
                />
              </label>
              <div style={styles.derivedKwh}>
                kWh = ({closing || 0} − {opening || 0}) × {multiplier || 1} ={" "}
                <b>{derivedKWh.toLocaleString()}</b>
              </div>
            </div>
          )}

          <label style={styles.field}>
            <span style={styles.fieldLabel}>Tariff category (TOU)</span>
            <select
              style={styles.input}
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

          <div style={styles.meterRow}>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>Billing month</span>
              <input
                style={styles.input}
                type="month"
                value={billingMonth}
                onChange={(e) => setBillingMonth(e.target.value)}
              />
            </label>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>
                Maximum demand (kW){t.demandRate === 0 ? " — n/a for this TOU" : ""}
              </span>
              <input
                style={styles.input}
                type="number"
                step="0.001"
                min="0"
                value={demandKW}
                onChange={(e) => setDemandKW(e.target.value)}
                disabled={t.demandRate === 0}
              />
            </label>
          </div>

          <div style={styles.validationLine}>
            Minimum plausible demand = kWh ÷ (days × 24h) = {derivedKWh.toLocaleString()} ÷{" "}
            {hours} = <b>{minDemand.toFixed(3)} kW</b>
          </div>
          {t.demandRate > 0 && (
            demandTooLow ? (
              <div style={styles.warnBad}>
                ⚠ Entered demand ({demandVal.toFixed(3)} kW) is below the minimum plausible
                average demand for this consumption. Check your reading.
              </div>
            ) : (
              <div style={styles.warnOk}>✓ Demand entry is consistent with consumption.</div>
            )
          )}
        </section>

        {/* ---------------- BILL PANEL ---------------- */}
        <section style={styles.billWrap}>
          <div style={styles.billTear} />
          <div style={styles.bill}>
            <div style={styles.billHeadRow}>
              <div style={styles.billLogo}>⚡ BOTSWANA POWER CORPORATION</div>
              <div style={styles.billTag}>TAX INVOICE (simulated)</div>
            </div>
            <div style={styles.billMeta}>
              <div>Tariff category: <b>{t.code} — {t.label}</b></div>
              <div>Billing days: <b>{daysInBillingMonth}</b></div>
              {mode === "meter" && <div>Meter #: <b>{meterNo}</b></div>}
            </div>

            <table style={styles.billTable}>
              <tbody>
                {mode === "meter" && (
                  <tr style={styles.billRowMuted}>
                    <td>METER {meterNo} — OPENING {opening} · CLOSING {closing} · MULT {multiplier}</td>
                    <td style={styles.billNum}>{derivedKWh.toLocaleString()} kWh</td>
                  </tr>
                )}
                <tr>
                  <td>ELECTRICITY CONSUMPTION</td>
                  <td style={styles.billNum}>{derivedKWh.toLocaleString()} kWh</td>
                </tr>
                {t.demandRate > 0 && (
                  <tr>
                    <td>MAXIMUM DEMAND CHARGE ({billedDemand.toFixed(3)} kW billed × {exVat(t.demandRate).toFixed(4)})</td>
                    <td style={styles.billNum}>{bill ? fmt(bill.demand) : "—"}</td>
                  </tr>
                )}
                <tr>
                  <td>
                    ELECTRICITY CHARGE{" "}
                    {t.tiered
                      ? `(tiered ≤/> ${t.tierLimit} kWh)`
                      : `(${exVat(t.energyRate).toFixed(4)}/kWh)`}
                  </td>
                  <td style={styles.billNum}>{bill ? fmt(bill.energy) : "—"}</td>
                </tr>
                <tr>
                  <td>STANDING CHARGE</td>
                  <td style={styles.billNum}>{bill ? fmt(bill.fixed) : "—"}</td>
                </tr>
                <tr style={styles.billSubtotal}>
                  <td>SUBTOTAL OF CURRENT CHARGES</td>
                  <td style={styles.billNum}>{bill ? fmt(bill.subtotal) : "—"}</td>
                </tr>
                <tr>
                  <td>VAT @ 14%</td>
                  <td style={styles.billNum}>{bill ? fmt(bill.vat) : "—"}</td>
                </tr>
                <tr>
                  <td>NATIONAL STANDARD COST LEVY ({derivedKWh.toLocaleString()} kWh × P0.10)</td>
                  <td style={styles.billNum}>{bill ? fmt(bill.levy) : "—"}</td>
                </tr>
              </tbody>
            </table>

            <div style={styles.billTotalRow}>
              <span>TOTAL AMOUNT INCLUDING VAT</span>
              <span style={styles.billTotalVal}>{bill ? fmt(bill.total) : "—"}</span>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- CHART PANEL ---------------- */}
      <section style={styles.panel}>
        <h2 style={styles.panelTitle}>
          Charge vs. {xAxisMode === "kwh" ? "Consumption" : "Maximum Demand"}
        </h2>

        <div style={styles.chartControls}>
          <div style={styles.controlGroup}>
            <span style={styles.controlLabel}>Tariff categories</span>
            <div style={styles.chipRow}>
              {TOU_KEYS.map((k) => (
                <label
                  key={k}
                  title={`${TARIFFS[k].code} — ${TARIFFS[k].label}`}
                  style={{
                    ...styles.chip,
                    ...styles.chipCompact,
                    borderColor: TOU_COLORS[k],
                    background: selectedTOUs.includes(k) ? TOU_COLORS[k] + "22" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedTOUs.includes(k)}
                    onChange={() => toggleTOU(k)}
                    style={{ accentColor: TOU_COLORS[k] }}
                  />
                  {TARIFFS[k].code}
                </label>
              ))}
            </div>
          </div>

          <div style={styles.controlGroup}>
            <span style={styles.controlLabel}>Charge components</span>
            <div style={styles.chipRow}>
              {METRICS.map((m) => (
                <label
                  key={m.key}
                  style={{
                    ...styles.chip,
                    borderColor: "#6B7280",
                    background: selectedMetrics.includes(m.key) ? "#6B728033" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedMetrics.includes(m.key)}
                    onChange={() => toggleMetric(m.key)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          <div style={styles.controlGroup}>
            <span style={styles.controlLabel}>X-axis variable</span>
            <div style={styles.modeSwitch}>
              <button
                style={xAxisMode === "kwh" ? styles.modeBtnActive : styles.modeBtn}
                onClick={() => setXAxisMode("kwh")}
              >
                kWh consumed
              </button>
              <button
                style={xAxisMode === "demand" ? styles.modeBtnActive : styles.modeBtn}
                onClick={() => setXAxisMode("demand")}
              >
                Maximum demand (kW)
              </button>
            </div>
          </div>

          <label style={styles.field}>
            <span style={styles.fieldLabel}>
              DM charge (demand assumption): {chartDemandKW.toFixed(1)} kW
            </span>
            <input
              type="range"
              min="0"
              max={MAX_DEMAND_LIMIT}
              step="0.5"
              value={chartDemandKW}
              onChange={(e) => setChartDemandKW(parseFloat(e.target.value))}
              style={{ width: "100%" }}
              disabled={xAxisMode === "demand"}
            />
            {xAxisMode === "demand" && (
              <span style={{ fontSize: 11, color: "#7C93AD" }}>
                Not used in this mode — demand is already the X-axis variable.
              </span>
            )}
          </label>

          {xAxisMode === "kwh" ? (
            <label style={styles.field}>
              <span style={styles.fieldLabel}>
                X-axis range (max kWh): {maxKWh.toLocaleString()} — demand held at{" "}
                {chartDemandKW.toFixed(1)} kW
              </span>
              <input
                type="range"
                min="1000"
                max="200000"
                step="1000"
                value={maxKWh}
                onChange={(e) => setMaxKWh(parseInt(e.target.value))}
                style={{ width: "100%" }}
              />
            </label>
          ) : (
            <label style={styles.field}>
              <span style={styles.fieldLabel}>
                X-axis range (max kW): {maxDemandAxis.toLocaleString()} — kWh held at{" "}
                {derivedKWh.toLocaleString()}
              </span>
              <input
                type="range"
                min="50"
                max="2000"
                step="10"
                value={maxDemandAxis}
                onChange={(e) => setMaxDemandAxis(parseInt(e.target.value))}
                style={{ width: "100%" }}
              />
            </label>
          )}
        </div>

        <div style={{ width: "100%", height: 420, marginTop: 16 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 10, right: 24, left: 8, bottom: 8 }}>
              <CartesianGrid stroke="#2A3B52" strokeDasharray="3 3" />
              <XAxis
                dataKey="x"
                tick={{ fill: "#9FB3C8", fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }}
                stroke="#3A4D66"
                tickFormatter={(v) => Math.round(v).toLocaleString()}
                allowDecimals={false}
                label={{
                  value: xAxisMode === "kwh" ? "kWh consumed" : "Maximum demand (kW)",
                  position: "insideBottom",
                  offset: -4,
                  fill: "#9FB3C8",
                }}
              />
              <YAxis
                domain={["auto", "auto"]}
                allowDataOverflow={false}
                tick={{ fill: "#9FB3C8", fontSize: 12, fontFamily: "IBM Plex Mono, monospace" }}
                stroke="#3A4D66"
                label={{ value: "Pula (P)", angle: -90, position: "insideLeft", fill: "#9FB3C8" }}
              />
              <Tooltip
                contentStyle={{
                  background: "#111D2E",
                  border: "1px solid #3A4D66",
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: 12,
                }}
                labelStyle={{ color: "#F2A93B" }}
                formatter={(v, name) => [fmt(v), name]}
              />
              <Legend wrapperStyle={{ fontFamily: "IBM Plex Sans, sans-serif", fontSize: 12 }} />
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
      </section>

      <footer style={styles.footer}>
        Rates ex-VAT are derived as (published VAT-inclusive rate) ÷ 1.14. VAT (14%) applies to
        Fixed + Electricity + Demand charges only; the P0.10/kWh National Standard Cost Levy is
        added after VAT. For reference only — not an official BPC invoice.
      </footer>
    </div>
  );
}

const fontImports = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
`;

const styles = {
  authWrap: {
    fontFamily: "'IBM Plex Sans', sans-serif",
    background: "#0C1622",
    color: "#E7EEF6",
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  authCard: {
    background: "#111D2E",
    border: "1px solid #24374F",
    borderRadius: 14,
    padding: 28,
    width: 360,
    maxWidth: "100%",
  },
  app: {
    fontFamily: "'IBM Plex Sans', sans-serif",
    background: "#0C1622",
    color: "#E7EEF6",
    minHeight: "100%",
    padding: "28px 28px 60px",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottom: "1px solid #24374F",
    paddingBottom: 16,
    marginBottom: 24,
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 14 },
  boltMark: {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: "linear-gradient(135deg,#6B3FA0,#8A6FD6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 22,
    boxShadow: "0 0 0 1px #3A2A55, 0 6px 18px -6px #6B3FA0AA",
  },
  eyebrow: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.14em",
    color: "#F2A93B",
    marginBottom: 2,
  },
  h1: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 26,
    margin: 0,
    fontWeight: 700,
    color: "#F4F7FB",
  },
  headerRight: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.08em",
    color: "#7C93AD",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1.15fr 1fr",
    gap: 20,
    alignItems: "start",
    marginBottom: 20,
  },
  panel: {
    background: "#111D2E",
    border: "1px solid #24374F",
    borderRadius: 14,
    padding: 22,
    marginBottom: 20,
  },
  panelTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 16,
    margin: "0 0 16px",
    color: "#F4F7FB",
  },
  modeSwitch: { display: "flex", gap: 8, marginBottom: 16 },
  modeBtn: {
    flex: 1,
    padding: "9px 10px",
    borderRadius: 4,
    border: "1px solid #2E4260",
    background: "transparent",
    color: "#9FB3C8",
    fontFamily: "'IBM Plex Sans', sans-serif",
    fontSize: 13,
    cursor: "pointer",
  },
  modeBtnActive: {
    flex: 1,
    padding: "9px 10px",
    borderRadius: 4,
    border: "1px solid #8A6FD6",
    background: "#8A6FD62A",
    color: "#F4F7FB",
    fontFamily: "'IBM Plex Sans', sans-serif",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 600,
  },
  field: { display: "block", marginBottom: 14 },
  fieldLabel: {
    display: "block",
    fontSize: 12,
    color: "#9FB3C8",
    marginBottom: 6,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 10px",
    borderRadius: 8,
    border: "1px solid #2E4260",
    background: "#0C1622",
    color: "#F4F7FB",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13.5,
    outline: "none",
  },
  meterRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 4,
  },
  derivedKwh: {
    gridColumn: "1 / -1",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12.5,
    color: "#F2A93B",
    background: "#F2A93B14",
    border: "1px dashed #F2A93B55",
    borderRadius: 8,
    padding: "8px 10px",
  },
  validationLine: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12,
    color: "#9FB3C8",
    marginTop: 4,
  },
  warnBad: {
    marginTop: 8,
    fontSize: 12.5,
    color: "#FCA5A5",
    background: "#E8546A1A",
    border: "1px solid #E8546A55",
    borderRadius: 8,
    padding: "8px 10px",
  },
  warnOk: {
    marginTop: 8,
    fontSize: 12.5,
    color: "#B7D65B",
    background: "#B7D65B14",
    border: "1px solid #B7D65B44",
    borderRadius: 8,
    padding: "8px 10px",
  },
  billWrap: { position: "relative" },
  billTear: {
    height: 10,
    background:
      "radial-gradient(circle at 6px 0, transparent 5px, #0C1622 5px) 0 0/12px 10px repeat-x",
  },
  bill: {
    background: "#F4F1EA",
    color: "#1B1330",
    borderRadius: "0 0 14px 14px",
    padding: "22px 22px 18px",
    fontFamily: "'IBM Plex Mono', monospace",
    boxShadow: "0 18px 40px -18px #00000090",
  },
  billHeadRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    borderBottom: "2px solid #5B2C7A",
    paddingBottom: 10,
    marginBottom: 10,
  },
  billLogo: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 700,
    fontSize: 14.5,
    color: "#5B2C7A",
    letterSpacing: "0.01em",
  },
  billTag: { fontSize: 10.5, color: "#7A6B8F", letterSpacing: "0.08em" },
  billMeta: { fontSize: 12, color: "#4A3B5C", marginBottom: 12, lineHeight: 1.7 },
  billTable: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  billRowMuted: { color: "#8A7B9C" },
  billNum: { textAlign: "right", whiteSpace: "nowrap", paddingLeft: 12 },
  billSubtotal: { borderTop: "1px solid #C9BEDD", fontWeight: 600 },
  billTotalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 12,
    borderTop: "2px solid #5B2C7A",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15,
    fontWeight: 700,
    color: "#5B2C7A",
  },
  billTotalVal: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 17 },
  chartControls: { display: "flex", flexDirection: "column", gap: 14 },
  controlGroup: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  controlLabel: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11.5,
    letterSpacing: "0.06em",
    color: "#7C93AD",
    whiteSpace: "nowrap",
  },
  chipRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 4,
    border: "1px solid",
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
  },
  chipCompact: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 600,
    letterSpacing: "0.02em",
    padding: "6px 12px",
  },
  footer: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    color: "#5A7089",
    marginTop: 8,
    lineHeight: 1.6,
    maxWidth: 900,
  },
};
