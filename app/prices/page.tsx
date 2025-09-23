// app/prices/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

/* =========================
   Types
   ========================= */

type Inputs = {
  drug: string;
  zip: string;
  qty: number;
  limit: number;
  includeMock: boolean;
  includeNadac: boolean;
  includeGoodRx: boolean;
  includeFlorida: boolean;
  includeRxNorm: boolean;
  flCounty: string;
  chains: string; // comma-separated
  form: string;
  strength: string;
  dedupe: "none" | "chain" | "pharmacy";
};

type PriceRow = {
  drug: string;
  form?: string;
  strength?: string;
  qty: number;
  totalPrice: number;
  unitPrice: number;
  pricingUnit?: string;
  packageSize?: string;
  pharmacy?: string;
  ndc?: string;
  zip?: string | null;
  chain?: string;
  address?: string;
  city?: string;
  state?: string;
  source: string;
  dataset: string;
  effectiveDate?: string;
  lastUpdated?: string;
  notes?: string;
};

type ApiResponse = {
  ok: boolean;
  count: number;
  privacy: string;
  inputs: any;
  results: PriceRow[];
  groupSummary?: Array<{ chain: string; count: number; minTotal: number }>;
  transparency: any;
};

/* =========================
   Pure helpers (module scope)
   ========================= */

function pretty(n?: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function toCSV(rows: PriceRow[]) {
  const cols = ["pharmacy","chain","dataset","drug","strength","qty","totalPrice","unitPrice","city","state","ndc","source"];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(",");
  const lines = rows.map(r => cols.map(c => esc((r as any)[c])).join(","));
  return [header, ...lines].join("\n");
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function curlForApi(origin: string, apiUrl: string) {
  const safe = apiUrl.startsWith("/") ? apiUrl : `/${apiUrl}`;
  return `curl -s "${origin}${safe}" -H "Accept: application/json"`;
}

function bgForDelta(delta: number) {
  if (!Number.isFinite(delta) || delta < 0) return undefined;
  if (delta <= 0.01) return "#ecfdf5"; // lowest
  if (delta <= 2)    return "#f0fdf4"; // near min
  if (delta <= 10)   return "#fffbeb"; // within $10
  return "#fef2f2";                   // pricier
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-block",
      fontSize: 11,
      padding: "2px 6px",
      borderRadius: 999,
      border: "1px solid #e5e7eb",
      background: "#f8fafc",
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 8px",
        borderRadius: 999,
        border: `1px solid ${active ? "#0ea5e9" : "#e5e7eb"}`,
        background: active ? "#e0f2fe" : "#f8fafc",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Th({ label, onClick, active, dir }: { label: string; onClick?: () => void; active?: boolean; dir?: "asc"|"desc" }) {
  const arrow = active ? (dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th
      onClick={onClick}
      style={{
        position: "sticky",
        top: 0,
        background: "white",
        borderBottom: "1px solid #eee",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        zIndex: 1,
      }}
    >
      {label}{arrow}
    </th>
  );
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i}>
          <div style={{
            height: 12, borderRadius: 6,
            background: "linear-gradient(90deg,#f3f4f6,#e5e7eb,#f3f4f6)",
            backgroundSize: "200% 100%",
            animation: "mf-shimmer 1.2s infinite"
          }} />
        </td>
      ))}
    </tr>
  );
}

const shimmerKeyframes = `
@keyframes mf-shimmer { 
  0% { background-position: 200% 0; } 
  100% { background-position: -200% 0; } 
}`;

/* =========================
   Page component
   ========================= */

type SortKey = "totalPrice" | "unitPrice" | "pharmacy" | "chain" | "dataset" | "qty" | "city" | "ndc";

export default function PricesPlayground() {
  // toast
  const [toast, setToast] = useState<string | null>(null);
  function notify(msg: string, ms = 2200) {
    setToast(msg);
    window.setTimeout(() => setToast(null), ms);
  }

  // inputs
  const [inputs, setInputs] = useState<Inputs>({
    drug: "atorvastatin",
    zip: "85001",
    qty: 90,
    limit: 25,
    includeMock: true,
    includeNadac: true,
    includeGoodRx: false,
    includeFlorida: false,
    includeRxNorm: true,
    flCounty: "",
    chains: "",
    form: "",
    strength: "",
    dedupe: "none",
  });

  // data fetch state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [rateHeaders, setRateHeaders] = useState<Record<string, string>>({});

  // memo URL
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set("drug", inputs.drug.trim());
    if (inputs.zip.trim()) params.set("zip", inputs.zip.trim());
    params.set("qty", String(inputs.qty));
    params.set("limit", String(inputs.limit));
    params.set("includeMock", String(inputs.includeMock));
    params.set("includeNadac", String(inputs.includeNadac));
    params.set("includeGoodRx", String(inputs.includeGoodRx));
    params.set("includeFlorida", String(inputs.includeFlorida));
    params.set("includeRxNorm", String(inputs.includeRxNorm));
    if (inputs.flCounty.trim()) params.set("flCounty", inputs.flCounty.trim());
    if (inputs.chains.trim()) params.set("chains", inputs.chains.trim().toLowerCase());
    if (inputs.form.trim()) params.set("form", inputs.form.trim());
    if (inputs.strength.trim()) params.set("strength", inputs.strength.trim());
    params.set("dedupe", inputs.dedupe);
    return `/api/prices?${params.toString()}`;
  }, [inputs]);

  function onChange<K extends keyof Inputs>(key: K, val: Inputs[K]) {
    setInputs((prev) => ({ ...prev, [key]: val }));
  }

  // localStorage + URL sync
  useEffect(() => {
    try {
      const saved = localStorage.getItem("mf.inputs.v1");
      if (saved) setInputs((p) => ({ ...p, ...JSON.parse(saved) }));
    } catch {}
    // hydrate from URL
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.size) {
        const bool = (v: string | null, fb: boolean) => (v == null ? fb : v.toLowerCase() === "true");
        setInputs((p) => ({
          ...p,
          drug: sp.get("drug") ?? p.drug,
          zip: sp.get("zip") ?? p.zip,
          qty: Number(sp.get("qty") ?? p.qty) || p.qty,
          limit: Number(sp.get("limit") ?? p.limit) || p.limit,
          includeMock: bool(sp.get("includeMock"), p.includeMock),
          includeNadac: bool(sp.get("includeNadac"), p.includeNadac),
          includeGoodRx: bool(sp.get("includeGoodRx"), p.includeGoodRx),
          includeFlorida: bool(sp.get("includeFlorida"), p.includeFlorida),
          includeRxNorm: bool(sp.get("includeRxNorm"), p.includeRxNorm),
          flCounty: sp.get("flCounty") ?? p.flCounty,
          chains: (sp.get("chains") ?? p.chains).toLowerCase(),
          form: sp.get("form") ?? p.form,
          strength: sp.get("strength") ?? p.strength,
          dedupe: (sp.get("dedupe") as Inputs["dedupe"]) ?? p.dedupe,
        }));
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem("mf.inputs.v1", JSON.stringify(inputs)); } catch {}
    // update page URL
    const u = new URL(window.location.href);
    const qs = apiUrl.slice("/api/prices?".length); // keep it simple
    const target = `${u.pathname}?${qs}`;
    if (u.search !== `?${qs}`) window.history.replaceState({}, "", target);
  }, [inputs, apiUrl]);

  // sorting
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "totalPrice", dir: "asc" });
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  const sortedResults = useMemo(() => {
    const rows = [...(data?.results || [])];
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a: any, b: any) => {
      const A = a?.[key], B = b?.[key];
      if (typeof A === "number" && typeof B === "number") return (A - B) * mul;
      const sA = (A ?? "").toString().toLowerCase();
      const sB = (B ?? "").toString().toLowerCase();
      return sA.localeCompare(sB) * mul;
    });
    return rows;
  }, [data, sort]);

  // dataset chips
  const [datasetFilter, setDatasetFilter] = useState<Set<string>>(new Set());
  const availableChains = useMemo(
    () => Array.from(new Set((data?.results || []).map(r => r.chain).filter(Boolean) as string[])).sort(),
    [data]
  );
  const availableDatasets = useMemo(
    () => Array.from(new Set((data?.results || []).map(r => r.dataset))).sort(),
    [data]
  );
  function toggleDataset(ds: string) {
    setDatasetFilter(prev => {
      const next = new Set(prev);
      next.has(ds) ? next.delete(ds) : next.add(ds);
      return next;
    });
  }

  const visibleResults = useMemo(() => {
    const rows = sortedResults;
    if (!datasetFilter.size) return rows;
    return rows.filter(r => datasetFilter.has(r.dataset));
  }, [sortedResults, datasetFilter]);

  const cheapestTotal = useMemo(() => {
    if (!visibleResults.length) return null;
    return visibleResults.reduce((min, r) => Math.min(min, r.totalPrice), Infinity);
  }, [visibleResults]);

  // fetch
  async function run() {
    if (!inputs.drug.trim()) {
      const msg = "Please enter a drug name";
      setError(msg);
      notify(`❌ ${msg}`);
      return;
    }
    const safeApiUrl = apiUrl.startsWith("/") ? apiUrl : `/${apiUrl}`;

    setLoading(true);
    setError(null);
    setData(null);
    setRateHeaders({});
    notify(`Fetching ${window.location.origin}${safeApiUrl}`);

    try {
      const res = await fetch(safeApiUrl, { method: "GET" });
      const rh = {
        "x-ratelimit-limit": res.headers.get("x-ratelimit-limit") || "",
        "x-ratelimit-remaining": res.headers.get("x-ratelimit-remaining") || "",
        "x-ratelimit-reset": res.headers.get("x-ratelimit-reset") || "",
        "medifindr-privacy": res.headers.get("medifindr-privacy") || "",
        "cache-control": res.headers.get("cache-control") || "",
      };
      setRateHeaders(rh);

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        await res.text();
        throw new Error(`Non-JSON response (${res.status} ${res.statusText})`);
      }
      const json = (await res.json()) as ApiResponse;

      if (!res.ok || json.ok === false) {
        const msg = (json as any)?.error || `Request failed (${res.status})`;
        setError(msg);
        notify(`❌ ${msg}`);
        return;
      }

      setData(json);
      notify(`✅ Loaded ${json.count ?? (json.results?.length ?? 0)} row(s)`);
    } catch (e: any) {
      const msg = e?.message || "Network error";
      setError(msg);
      notify(`❌ ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  // actions
  function exportCSV() {
    if (!data?.results?.length) return;
    const csv = toCSV(visibleResults.length ? visibleResults : data.results);
    downloadCSV(csv, `prices-${inputs.drug}-${Date.now()}.csv`);
  }

  async function copyCurl() {
    const curl = curlForApi(window.location.origin, apiUrl);
    await navigator.clipboard.writeText(curl);
    notify("cURL copied to clipboard");
  }

  // styles
  const inputStyle: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: "1px solid #ccc", outline: "none" };
  const btnPrimary: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, background: "black", color: "white", border: "1px solid black", cursor: "pointer" };
  const btnGhost: React.CSSProperties = { padding: "10px 14px", borderRadius: 10, background: "transparent", color: "black", border: "1px solid #ccc", textDecoration: "none" };
  const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "separate", borderSpacing: 0, border: "1px solid #eee" };

  return (
    <div style={{ padding: "28px", maxWidth: 1200, margin: "0 auto", fontFamily: "system-ui, Arial, sans-serif" }}>
      <style>{shimmerKeyframes}</style>

      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 16 }}>mediFindr — Prices Playground</h1>

      {/* Controls */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, 1fr)",
          gap: 12,
          alignItems: "end",
          marginBottom: 16,
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 16,
        }}
      >
        <Field label="Drug" col={3}>
          <input value={inputs.drug} onChange={(e) => onChange("drug", e.target.value)} placeholder="e.g., atorvastatin" style={inputStyle} />
        </Field>
        <Field label="ZIP (optional)" col={2}>
          <input value={inputs.zip} onChange={(e) => onChange("zip", e.target.value)} placeholder="85001" style={inputStyle} />
        </Field>
        <Field label="Qty" col={2}>
          <input value={inputs.qty} onChange={(e) => onChange("qty", Math.max(1, Number(e.target.value) || 1))} type="number" min={1} max={5000} style={inputStyle} />
        </Field>
        <Field label="Limit" col={2}>
          <input value={inputs.limit} onChange={(e) => onChange("limit", Math.max(1, Number(e.target.value) || 1))} type="number" min={1} max={50} style={inputStyle} />
        </Field>
        <Field label="Chains (comma-separated)" col={3}>
          <input value={inputs.chains} onChange={(e) => onChange("chains", e.target.value)} placeholder="walmart,cvs" style={inputStyle} />
        </Field>
        <Field label="Florida County (opt)" col={3}>
          <input value={inputs.flCounty} onChange={(e) => onChange("flCounty", e.target.value)} placeholder="Miami-Dade" style={inputStyle} />
        </Field>
        <Field label="Form (filter)" col={2}>
          <input value={inputs.form} onChange={(e) => onChange("form", e.target.value)} placeholder="tablet" style={inputStyle} />
        </Field>
        <Field label="Strength (filter)" col={2}>
          <input value={inputs.strength} onChange={(e) => onChange("strength", e.target.value)} placeholder="20 mg" style={inputStyle} />
        </Field>
        <Field label="Dedupe" col={2}>
          <select value={inputs.dedupe} onChange={(e) => onChange("dedupe", e.target.value as any)} style={inputStyle}>
            <option value="none">None</option>
            <option value="chain">Cheapest per chain</option>
            <option value="pharmacy">Cheapest per pharmacy</option>
          </select>
        </Field>
        <Field label="Include sources" col={12}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <label><input type="checkbox" checked={inputs.includeMock}     onChange={(e) => onChange("includeMock", e.target.checked)} /> Mock</label>
            <label><input type="checkbox" checked={inputs.includeNadac}    onChange={(e) => onChange("includeNadac", e.target.checked)} /> NADAC</label>
            <label><input type="checkbox" checked={inputs.includeGoodRx}   onChange={(e) => onChange("includeGoodRx", e.target.checked)} /> GoodRx</label>
            <label><input type="checkbox" checked={inputs.includeFlorida}  onChange={(e) => onChange("includeFlorida", e.target.checked)} /> Florida</label>
            <label><input type="checkbox" checked={inputs.includeRxNorm}   onChange={(e) => onChange("includeRxNorm", e.target.checked)} /> RxNorm</label>
          </div>
        </Field>
        <div style={{ gridColumn: "span 12", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={run} disabled={loading} style={btnPrimary}>{loading ? "Loading..." : "Fetch prices"}</button>
          <a href={apiUrl} target="_blank" rel="noreferrer" style={btnGhost} title="Open raw API response">Open raw API</a>
          <button onClick={async () => { await copyCurl(); }} disabled={loading} style={btnGhost} title="Copy a cURL for this request">Copy cURL</button>
          <button onClick={exportCSV} disabled={loading || !(data?.results?.length)} style={btnGhost} title="Export current table to CSV">Export CSV</button>
        </div>
      </div>

      <div style={{ fontSize: 12, color: "#666", marginBottom: 12 }}>
        Request URL: <code>{apiUrl}</code>
      </div>

      {error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary */}
          <section style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Result summary</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <KV k="ok" v={String(data.ok)} />
              <KV k="count" v={String(data.count)} />
              <KV k="privacy" v={data.privacy} />
              <KV k="Rate limit" v={`${rateHeaders["x-ratelimit-remaining"] || "?"} / ${rateHeaders["x-ratelimit-limit"] || "?"}`} />
              <KV k="Reset (ms)" v={rateHeaders["x-ratelimit-reset"] || "?"} />
            </div>
          </section>

          {/* Group by chain */}
          {data.groupSummary && data.groupSummary.length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>By chain</h3>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th>Rows</th>
                    <th>Min Total</th>
                    <th>Δ vs min</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groupSummary.map((g) => (
                    <tr key={g.chain}>
                      <td>{g.chain}</td>
                      <td>{g.count}</td>
                      <td>{pretty(g.minTotal)}</td>
                      <td>{cheapestTotal == null ? "—" : pretty(Math.max(0, g.minTotal - cheapestTotal))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* RESULTS */}
          <section>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Results</h2>

            {/* caveats */}
            {data?.transparency?.caveats?.length ? (
              <div style={{
                margin: "8px 0 12px",
                padding: 10,
                border: "1px solid #fee2e2",
                background: "#fff7f7",
                color: "#7f1d1d",
                borderRadius: 8,
                fontSize: 13
              }}>
                <strong style={{ marginRight: 6 }}>Notes:</strong>
                <ul style={{ margin: "6px 0 0 18px" }}>
                  {data.transparency.caveats.map((c: string, i: number) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            ) : null}

            {/* chips */}
            {(availableChains.length > 0 || availableDatasets.length > 0) && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                {/* Chains */}
                {availableChains.length > 0 && (
                  <>
                    <strong style={{ fontSize: 12, color: "#555" }}>Chains:</strong>
                    {availableChains.map(ch => {
                      const selected = (inputs.chains || "").split(",").map(s => s.trim()).filter(Boolean);
                      const active = selected.includes(ch);
                      return (
                        <Chip
                          key={ch}
                          active={active}
                          onClick={() => {
                            const next = new Set(selected);
                            active ? next.delete(ch) : next.add(ch);
                            onChange("chains", Array.from(next).join(","));
                            run();
                          }}
                        >
                          {ch}
                        </Chip>
                      );
                    })}
                  </>
                )}
                {/* Datasets */}
                {availableDatasets.length > 0 && (
                  <>
                    <strong style={{ fontSize: 12, color: "#555", marginLeft: 8 }}>Datasets:</strong>
                    {availableDatasets.map(ds => (
                      <Chip key={ds} active={datasetFilter.has(ds)} onClick={() => toggleDataset(ds)}>
                        {ds}
                      </Chip>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* scroll wrapper */}
            <div style={{ maxHeight: "60vh", overflow: "auto", borderRadius: 8, border: "1px solid #eee" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <Th label="Pharmacy" onClick={() => toggleSort("pharmacy")} active={sort.key==="pharmacy"} dir={sort.dir} />
                    <Th label="Chain"    onClick={() => toggleSort("chain")}    active={sort.key==="chain"}    dir={sort.dir} />
                    <Th label="Dataset"  onClick={() => toggleSort("dataset")}  active={sort.key==="dataset"}  dir={sort.dir} />
                    <Th label="Drug" />
                    <Th label="Strength" />
                    <Th label="Qty"      onClick={() => toggleSort("qty")}      active={sort.key==="qty"}      dir={sort.dir} />
                    <Th label="Total"    onClick={() => toggleSort("totalPrice")} active={sort.key==="totalPrice"} dir={sort.dir} />
                    <Th label="Δ vs min" />
                    <Th label="Unit"     onClick={() => toggleSort("unitPrice")}  active={sort.key==="unitPrice"}  dir={sort.dir} />
					<Th label="Δ vs NADAC/unit" />
                    <Th label="City"     onClick={() => toggleSort("city")}     active={sort.key==="city"}     dir={sort.dir} />
                    <Th label="NDC"      onClick={() => toggleSort("ndc")}      active={sort.key==="ndc"}      dir={sort.dir} />
                    <th style={{ minWidth: 120 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <>
                      {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} cols={12} />)}
                    </>
                  ) : visibleResults.length > 0 ? (
                    visibleResults.map((r, i) => {
                      const delta = cheapestTotal == null ? null : r.totalPrice - cheapestTotal;
                      const rowStyle: React.CSSProperties =
                        delta == null ? {} : {
                          background: bgForDelta(delta)!,
                          boxShadow:
                            delta <= 0.01 ? "inset 4px 0 #10b981" :
                            delta <= 2    ? "inset 4px 0 #34d399" :
                            delta <= 10   ? "inset 4px 0 #f59e0b" :
                                            "inset 4px 0 #ef4444",
                        };
                      return (
                        <tr key={i} style={rowStyle}>
                          <td>{r.pharmacy || "—"}</td>
                          <td>{r.chain ? <Badge>{r.chain}</Badge> : "—"}</td>
                          <td><Badge>{r.dataset}</Badge></td>
                          <td>{r.drug}</td>
                          <td>{r.strength || "—"}</td>
                          <td>{r.qty}</td>
                          <td>
                            <strong>{pretty(r.totalPrice)}</strong>
                            {delta != null && delta <= 0.01 && (
                              <span style={{ marginLeft: 8, fontSize: 11, color: "#065f46", border: "1px solid #a7f3d0", padding: "2px 6px", borderRadius: 999 }}>
                                lowest
                              </span>
                            )}
                          </td>
                          <td>{cheapestTotal == null ? "—" : pretty(Math.max(0, delta!))}</td>
                          <td>{typeof r.unitPrice === "number" ? r.unitPrice.toFixed(4) : "—"}</td>
						  <td>
							  {(() => {
								const uMin = data?.transparency?.nadacBaseline?.unitMin;
								if (typeof uMin !== "number" || typeof r.unitPrice !== "number") return "—";
								const d = Number((r.unitPrice - uMin).toFixed(4)); // precise & pretty
								// tiny label
								const badgeStyle: React.CSSProperties =
								  d <= -0.01 ? { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46" } :
								  Math.abs(d) <= 0.02 ? { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" } :
								  d <= 0.10 ? { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" } :
											  { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" };
								return (
								  <>
									{d >= 0 ? "+" : ""}{d.toFixed(4)}
									&nbsp;<span style={{ ...badgeStyle, padding: "2px 6px", borderRadius: 999, fontSize: 11 }}>
									  {d <= -0.01 ? "below" : Math.abs(d) <= 0.02 ? "≈" : "above"}
									</span>
								  </>
								);
							  })()}
							</td>

                          <td>{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                          <td>{r.ndc || "—"}</td>
                          <td><a href={r.source} target="_blank" rel="noreferrer">open</a></td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={13} style={{ textAlign: "center", color: "#666" }}>
                        {data?.results?.length
                          ? "No rows match current filters."
                          : "No rows returned. Try enabling sources or adjust inputs."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Transparency / debug */}
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer" }}>Transparency / debug</summary>
            <pre style={{ fontSize: 12, background: "#f8fafc", padding: 12, borderRadius: 8, overflow: "auto" }}>
              {JSON.stringify(data?.transparency ?? {}, null, 2)}
            </pre>
          </details>
        </>
      )}

      {/* initial hint */}
      {!data && !error && (
        <div style={{ color: "#555", marginTop: 12 }}>
          Tip: try <code>atorvastatin</code> with Mock/NADAC, or enable Florida after dropping your sample CSV/XLSX in <code>/public</code>.
        </div>
      )}

      {/* toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 50,
            background: "#111827",
            color: "white",
            padding: "10px 14px",
            borderRadius: 10,
            boxShadow: "0 10px 20px rgba(0,0,0,0.2)",
            fontSize: 14,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/* =========================
   Small UI helpers
   ========================= */

function Field({ label, col, children }: { label: string; col: number; children: React.ReactNode }) {
  return (
    <label style={{ gridColumn: `span ${col}`, display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "#555" }}>{label}</span>
      {children}
    </label>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 10px", background: "#f8fafc", borderRadius: 8 }}>
      <strong style={{ fontSize: 12 }}>{k}:</strong>
      <span style={{ fontSize: 12 }}>{v}</span>
    </div>
  );
}
