// app/api/prices/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

/** =======================
 * Config (env + defaults)
 * ======================= */
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000);    // 1 min
const RATE_MAX = Number(process.env.RATE_MAX ?? 30);                    // 30 req/min/IP
const GOODRX_RATE_MAX = Number(process.env.GOODRX_RATE_MAX ?? 8);       // GoodRx calls/min/IP

const CACHE_TTL_RXNORM_MS = Number(process.env.CACHE_TTL_RXNORM_MS ?? 86_400_000); // 24h
const CACHE_TTL_NADAC_MS  = Number(process.env.CACHE_TTL_NADAC_MS  ?? 15 * 60_000); // 15m
const CACHE_TTL_GOODRX_MS = Number(process.env.CACHE_TTL_GOODRX_MS ?? 60_000);      // 60s

const FL_TEMPLATE = (process.env.FL_MYRX_EXPORT_URL_TEMPLATE || "").trim();
const FL_TEST_REL = (process.env.FL_MYRX_TEST_XLS || "").trim(); // e.g. "/florida-sample.csv"

/** =======================
 * Global state (dev-safe)
 * ======================= */
type CacheEntry = { expires: number; data: any };
type Bucket = Map<string, CacheEntry>;

const g = globalThis as any;
g.__medi_cache ??= new Map<string, Bucket>();          // bucketName -> key -> entry
g.__medi_rl ??= new Map<string, { count: number; resetAt: number }>(); // rate-limit map
function bucket(name: string): Bucket {
  if (!g.__medi_cache.has(name)) g.__medi_cache.set(name, new Map());
  return g.__medi_cache.get(name);
}

/** =======================
 * Types
 * ======================= */
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
  source: string;                 // provenance (no secrets)
  dataset: string;                // "GoodRx" | "NADAC..." | "Florida MyFloridaRX" | "Mock"
  effectiveDate?: string;
  lastUpdated?: string;
  notes?: string;
};

type GoodRxInput = { drug: string; qty: number; zip?: string | null; limit: number };
type RxNormResolved = { rxcui: string | null; name: string | null; ndcs: string[]; resolutionSourceUrl: string | null; ndcsSourceUrl: string | null };

/** =======================
 * Utilities
 * ======================= */
function isFiveDigitZip(v?: string | null) { return !!v && /^\d{5}$/.test(v); }
function toNumberSafe(n: any, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }
function getClientKey(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = (fwd.split(",")[0] || req.headers.get("x-real-ip") || "anon").trim();
  return `ip:${ip}`;
}
function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const rec = g.__medi_rl.get(key);
  if (!rec || now >= rec.resetAt) {
    const next = { count: 1, resetAt: now + windowMs };
    g.__medi_rl.set(key, next);
    return { allowed: true, remaining: max - 1, resetAt: next.resetAt };
  }
  if (rec.count >= max) return { allowed: false, remaining: 0, resetAt: rec.resetAt };
  rec.count += 1;
  return { allowed: true, remaining: max - rec.count, resetAt: rec.resetAt };
}
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" as RequestCache }); }
  finally { clearTimeout(id); }
}
async function fetchJSONCached(url: string, init: RequestInit, ttlMs: number, bucketName: string): Promise<any | null> {
  if (ttlMs > 0) {
    const b = bucket(bucketName);
    const hit = b.get(url);
    if (hit && hit.expires > Date.now()) return hit.data;
  }
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) return null;
  const data = await res.json();
  if (ttlMs > 0) bucket(bucketName).set(url, { data, expires: Date.now() + ttlMs });
  return data;
}
function deriveChain(name?: string) {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (/\bwalmart\b/.test(n)) return "walmart";
  if (/\bcvs\b/.test(n)) return "cvs";
  if (/\bwalgreens\b/.test(n)) return "walgreens";
  if (/\bcostco\b/.test(n)) return "costco";
  if (/\bsafeway\b/.test(n)) return "safeway";
  if (/\bkroger\b/.test(n)) return "kroger";
  return n.trim();
}

/** =======================
 * Mock layer
 * ======================= */
const MOCK: Array<PriceRow & { zipCoverage?: string[] }> = [
  {
    drug: "atorvastatin", form: "tablet", strength: "20 mg", qty: 30,
    totalPrice: 9.99, unitPrice: 9.99 / 30, pharmacy: "Walmart (Mock)",
    zipCoverage: ["85001", "85002", "85281", "99999"],
    source: "mock://walmart/atorvastatin-20mg-30", dataset: "Mock", lastUpdated: "2025-09-01T00:00:00Z",
  },
  {
    drug: "atorvastatin", form: "tablet", strength: "10 mg", qty: 30,
    totalPrice: 11.49, unitPrice: 11.49 / 30, pharmacy: "CVS (Mock)",
    zipCoverage: ["85001", "85018", "85281"],
    source: "mock://cvs/atorvastatin-10mg-30", dataset: "Mock", lastUpdated: "2025-08-27T00:00:00Z",
  },
  {
    drug: "metformin", form: "tablet", strength: "500 mg", qty: 60,
    totalPrice: 6.5, unitPrice: 6.5 / 60, pharmacy: "Costco (Mock)",
    zipCoverage: ["85001", "85281"],
    source: "mock://costco/metformin-500mg-60", dataset: "Mock", lastUpdated: "2025-09-05T00:00:00Z",
  },
];

/** =======================
 * NADAC (HealthData.gov)
 * ======================= */
const NADAC_DATASET_ID = "3tha-57c6";
const NADAC_BASE = `https://healthdata.gov/resource/${NADAC_DATASET_ID}.json`;

async function fetchNadac(drugQuery: string, qty: number, limit: number) {
  const params = new URLSearchParams({
    $select:
      "ndc, generic_name, ndc_description, effective_date, nadac_per_unit, pricing_unit, package_size",
    $where:
      `upper(generic_name) like upper('%25${encodeURIComponent(drugQuery)}%25') OR upper(ndc_description) like upper('%25${encodeURIComponent(drugQuery)}%25')`,
    $order: "effective_date DESC",
    $limit: String(Math.min(Math.max(limit, 1), 50)),
  });
  const url = `${NADAC_BASE}?${params.toString()}`;
  const data = await fetchJSONCached(url, {}, CACHE_TTL_NADAC_MS, "nadac");
  const rows: PriceRow[] = Array.isArray(data)
    ? data.map((r: any) => {
        const unit = toNumberSafe(r?.nadac_per_unit);
        const total = Number((unit * qty).toFixed(4));
        return {
          drug: (r?.generic_name || "").toLowerCase(),
          qty, unitPrice: unit, totalPrice: total,
          pricingUnit: r?.pricing_unit || undefined, packageSize: r?.package_size || undefined,
          ndc: r?.ndc || undefined, zip: null,
          source: url, dataset: "NADAC (HealthData.gov 2024)",
          effectiveDate: r?.effective_date || undefined,
          notes: "NADAC is an acquisition cost benchmark (not retail price).",
        };
      })
    : [];
  return { rows, sourceUrl: url };
}

/** =======================
 * GoodRx (feature-flagged)
 * ======================= */
const GOODRX_BASE = "https://api.goodrx.com/v2/price"; // placeholder; adjust per contract

async function fetchGoodRxPrices(input: GoodRxInput): Promise<{ rows: PriceRow[]; url: string }> {
  const apiKey = process.env.GOODRX_API_KEY;
  if (!apiKey) return { rows: [], url: GOODRX_BASE };

  const qs = new URLSearchParams({
    name: input.drug,
    quantity: String(input.qty),
    ...(input.zip ? { zip: input.zip } : {}),
    limit: String(Math.min(Math.max(input.limit, 1), 10)),
  });
  const url = `${GOODRX_BASE}?${qs.toString()}`;

  const init: RequestInit = { method: "GET", headers: { "x-api-key": apiKey, accept: "application/json" } };
  const data =
    CACHE_TTL_GOODRX_MS > 0
      ? await fetchJSONCached(url, init, CACHE_TTL_GOODRX_MS, "goodrx")
      : await (async () => {
          const res = await fetchWithTimeout(url, init);
          if (!res.ok) return null;
          return res.json();
        })();

  if (!data) return { rows: [], url };

  const items = Array.isArray(data?.results || data?.prices || data)
    ? (data.results || data.prices || data)
    : [];

  const rows: PriceRow[] = items.map((p: any) => {
    const unitPrice = toNumberSafe(p?.price_per_unit ?? p?.unit_price ?? p?.price);
    const totalPrice = toNumberSafe(p?.total_price ?? unitPrice * input.qty);
    const pharmacyName = p?.pharmacy_name || p?.pharmacy;
    return {
      drug: (p?.generic_name || p?.name || input.drug).toLowerCase(),
      form: p?.form || undefined, strength: p?.strength || undefined,
      qty: input.qty,
      unitPrice: Number(unitPrice.toFixed(4)),
      totalPrice: Number(totalPrice.toFixed(4)),
      pharmacy: pharmacyName, chain: deriveChain(pharmacyName),
      pricingUnit: p?.pricing_unit || undefined, packageSize: p?.package_size || undefined,
      ndc: p?.ndc || undefined, zip: input.zip || null,
      source: url, dataset: "GoodRx",
      effectiveDate: p?.effective_date || p?.updated_at || undefined,
      notes: "Consumer-facing discount price (volatile; do not store long-term).",
    };
  });

  return { rows, url };
}

/** =======================
 * RxNorm resolver
 * ======================= */
const RXNAV_FIND = (name: string, search: 0 | 1 | 2 | 9) =>
  `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(name)}&search=${search}`;
const RXNAV_NDCS = (rxcui: string) =>
  `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`;

async function resolveRxNorm(drugFreeText: string): Promise<RxNormResolved> {
  let rxcui: string | null = null;
  let sourceUrl: string | null = null;

  // normalized search
  let url = RXNAV_FIND(drugFreeText, 1);
  let data = await fetchJSONCached(url, {}, CACHE_TTL_RXNORM_MS, "rxnorm_find");
  let ids = data?.rxnormdata?.idGroup?.rxnormId;
  if (!Array.isArray(ids) || !ids.length) {
    // approximate fallback
    url = RXNAV_FIND(drugFreeText, 9);
    data = await fetchJSONCached(url, {}, CACHE_TTL_RXNORM_MS, "rxnorm_find");
    ids = data?.rxnormdata?.idGroup?.rxnormId;
  }
  if (Array.isArray(ids) && ids.length) { rxcui = String(ids[0]); sourceUrl = url; }

  let ndcs: string[] = [];
  let name: string | null = null;
  let ndcsUrl: string | null = null;

  if (rxcui) {
    ndcsUrl = RXNAV_NDCS(rxcui);
    const ndcJson = await fetchJSONCached(ndcsUrl, {}, CACHE_TTL_RXNORM_MS, "rxnorm_ndcs");
    const arr = ndcJson?.rxnormdata?.ndcGroup?.ndcList?.ndc;
    if (Array.isArray(arr)) ndcs = arr.map(String);

    const nameUrl = `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}.json`;
    const nameJson = await fetchJSONCached(nameUrl, {}, CACHE_TTL_RXNORM_MS, "rxnorm_name");
    name = nameJson?.rxnormdata?.idGroup?.name ?? null;
  }

  return { rxcui, name, ndcs, resolutionSourceUrl: sourceUrl, ndcsSourceUrl: ndcsUrl };
}

/** =======================
 * Florida MyFloridaRX fetcher
 * - Live export via FL_MYRX_EXPORT_URL_TEMPLATE (placeholders: {drug}, {county})
 * - Dev sample via FL_MYRX_TEST_XLS (CSV/XLSX in /public)
 * - Fallback to /public/florida-sample.csv if present
 * ======================= */
function pick(row: any, keys: string[], fallback?: string) {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return fallback;
}
function parseFloridaWorkbook(
  buf: ArrayBuffer | Buffer,
  sourceUrl: string,
  requestedDrug: string,
  qty: number,
  limit: number
) {
  const wb = XLSX.read(buf, { type: "buffer" }); // handles .csv and .xlsx
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json: any[] = XLSX.utils.sheet_to_json(sheet);

  const rows: PriceRow[] = json.slice(0, limit).map((r) => {
    const pharmacyName = pick(r, ["Pharmacy", "Pharmacy Name", "Name"]);
    const drugName = pick(r, ["Drug Name", "Drug"]);
    const quantity = Number(pick(r, ["Quantity", "Qty"], "30"));
    const priceStr = pick(r, ["Price", "Usual and Customary Price", "U&C"]);
    const city = pick(r, ["City"]);
    const address = pick(r, ["Address", "Street"]);
    const ndc = pick(r, ["NDC", "NDC Code"]);
    const unitPrice = ((Number(priceStr || 0)) / (quantity || 1)) || 0;

    return {
      drug: (drugName || requestedDrug || "").toLowerCase(),
      qty,
      unitPrice: Number(unitPrice.toFixed(4)),
      totalPrice: Number((unitPrice * qty).toFixed(4)),
      pharmacy: pharmacyName,
      chain: deriveChain(pharmacyName),
      ndc,
      pricingUnit: "per unit",
      zip: null,
      address, city, state: "FL",
      source: sourceUrl,
      dataset: "Florida MyFloridaRX",
      notes: "Retail 'usual & customary' price from paid-claims-derived data; updated monthly.",
    };
  });

  return { rows, url: sourceUrl };
}
async function fetchFloridaMyRxExcel(
  req: NextRequest,
  drug: string,
  qty: number,
  county?: string,
  limit = 50
): Promise<{ rows: PriceRow[]; url: string }> {
  // 1) Live export via template
  if (FL_TEMPLATE) {
    const url = FL_TEMPLATE
      .replace("{drug}", encodeURIComponent(drug))
      .replace("{county}", encodeURIComponent(county || "All Counties"));
    const res = await fetchWithTimeout(url, {}, 12_000);
    if (!res.ok) return { rows: [], url };
    const arrayBuf = await res.arrayBuffer();
    return parseFloridaWorkbook(arrayBuf, url, drug, qty, limit);
  }

  // 2) Dev file via env (CSV/XLSX inside /public)
  const relFromEnv = FL_TEST_REL.replace(/^\//, ""); // strip leading slash
  if (relFromEnv) {
    const abs = path.join(process.cwd(), "public", relFromEnv);
    const buf = await fs.readFile(abs); // throws if missing
    return parseFloridaWorkbook(buf, "/" + relFromEnv, drug, qty, limit);
  }

  // 3) Fallback to /public/florida-sample.csv if present
  try {
    const fallbackRel = "florida-sample.csv";
    const abs = path.join(process.cwd(), "public", fallbackRel);
    const buf = await fs.readFile(abs);
    return parseFloridaWorkbook(buf, "/" + fallbackRel, drug, qty, limit);
  } catch {
    // none found
    return { rows: [], url: "" };
  }
}

/** =======================
 * Handler
 * ======================= */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Inputs
  const rawDrug = (searchParams.get("drug") || "").trim();
  const zip = (searchParams.get("zip") || "").trim();
  const qty = Math.min(Math.max(Number(searchParams.get("qty") || 30), 1), 5000);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 25), 1), 50);

  const includeMock = (searchParams.get("includeMock") || "true").toLowerCase() !== "false";
  const includeNadac = (searchParams.get("includeNadac") || "true").toLowerCase() !== "false";
  const includeRxNorm = (searchParams.get("includeRxNorm") || "true").toLowerCase() !== "false";
  const includeFlorida = (searchParams.get("includeFlorida") || "false").toLowerCase() === "true";
  const flCounty = (searchParams.get("flCounty") || "").trim();
  const includeGoodRxParam = (searchParams.get("includeGoodRx") || "").toLowerCase();
  const includeGoodRx =
    includeGoodRxParam === "true" || (includeGoodRxParam !== "false" && !!process.env.GOODRX_API_KEY);

  const chainParam = (searchParams.get("chains") || "").toLowerCase();
  const chainSet = new Set(chainParam.split(",").map(s => s.trim()).filter(Boolean));

  const privacy = (searchParams.get("privacy") || "on").toLowerCase(); // "on" | "off"
  
  const dedupe = (searchParams.get("dedupe") || "none").toLowerCase() as "none" | "chain" | "pharmacy";
  const formFilter = (searchParams.get("form") || "").toLowerCase();
  const strengthFilter = (searchParams.get("strength") || "").toLowerCase();

  // Validate
  if (!rawDrug) {
    return NextResponse.json(
      { ok: false, error: "Missing required query param: drug (e.g., ?drug=atorvastatin)" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (zip && !isFiveDigitZip(zip)) {
    return NextResponse.json(
      { ok: false, error: "Invalid zip. Use 5 digits, e.g., 85001" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Rate limit (per IP)
  const clientKey = getClientKey(req);
  const rl = rateLimit(clientKey, RATE_MAX, RATE_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded. Please try again shortly." },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "X-RateLimit-Limit": String(RATE_MAX),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rl.resetAt),
          "mediFindr-privacy": privacy,
        },
      }
    );
  }

  // RxNorm normalization
  let normalizedDrug = rawDrug.toLowerCase();
  let rxnorm: RxNormResolved | null = null;
  if (includeRxNorm) {
    try {
      rxnorm = await resolveRxNorm(normalizedDrug);
      if (rxnorm?.name) normalizedDrug = rxnorm.name.toLowerCase();
    } catch {}
  }

  // Prepare transparency
  const transparency: any = {
    datasets: [] as Array<{ name: string; homepage?: string; info?: string }>,
    caveats: [] as string[],
    attempted: [] as string[],
    resolution: rxnorm
      ? { rxcui: rxnorm.rxcui, canonicalName: rxnorm.name, ndcCount: rxnorm.ndcs.length, sourceUrl: rxnorm.resolutionSourceUrl, ndcsSourceUrl: rxnorm.ndcsSourceUrl }
      : null,
    debug: {
      FL_MYRX_TEST_XLS: FL_TEST_REL || null,
      FL_MYRX_EXPORT_URL_TEMPLATE: FL_TEMPLATE || null,
    },
  };

  // Aggregate rows
  let rows: PriceRow[] = [];

  // GoodRx (separate throttle)
  if (includeGoodRx) {
    const goodrxKey = `${clientKey}|goodrx`;
    const grl = rateLimit(goodrxKey, GOODRX_RATE_MAX, RATE_WINDOW_MS);
    if (grl.allowed) {
      transparency.attempted.push("GoodRx");
      try {
        const { rows: grxRows } = await fetchGoodRxPrices({ drug: normalizedDrug, qty, zip: zip || null, limit });
        if (grxRows.length) {
          rows.push(...grxRows);
          transparency.datasets.push({ name: "GoodRx", info: "Consumer-facing discount cash prices.", homepage: "https://www.goodrx.com/" });
          transparency.caveats.push("GoodRx prices change frequently; do not store long-term.");
        }
      } catch {}
    } else {
      transparency.caveats.push("GoodRx calls throttled for this client to protect upstream limits.");
    }
  }

  // NADAC
  if (includeNadac) {
    transparency.attempted.push("NADAC");
    try {
      const { rows: nadacRows } = await fetchNadac(normalizedDrug, qty, limit);
      if (nadacRows.length) {
        rows.push(...nadacRows);
        transparency.datasets.push({ name: "NADAC (HealthData.gov)", info: "Open benchmark of pharmacy acquisition cost; updated weekly.", homepage: "https://www.medicaid.gov/medicaid/nadac" });
        transparency.caveats.push("NADAC is acquisition cost, not retail price.");
      } else {
        transparency.caveats.push("No NADAC rows matched this query.");
      }
    } catch {}
  }
  
	  // Compute min per-unit from NADAC rows (if any)
	const nadacUnitMin = (Array.isArray(nadacRows) && nadacRows.length)
	  ? Math.min(...nadacRows.map(r => Number(r.unitPrice)).filter(n => Number.isFinite(n)))
	  : null;

	// Expose it for the UI
	(transparency as any).nadacBaseline = {
	  unitMin: Number.isFinite(nadacUnitMin) ? nadacUnitMin : null,
	  note: "Minimum NADAC per-unit for the resolved drug form/strength.",
	};


  // Florida
  if (includeFlorida) {
    transparency.attempted.push("Florida MyFloridaRX");
    try {
      const { rows: flRows, url: flUrl } = await fetchFloridaMyRxExcel(req, normalizedDrug, qty, flCounty || undefined, limit);
      transparency.florida = { url: flUrl, count: flRows.length };
      if (flRows.length) {
        rows.push(...flRows);
        transparency.datasets.push({ name: "Florida MyFloridaRX", info: "Pharmacy-level 'usual & customary' retail prices (monthly).", homepage: "https://prescription.healthfinder.fl.gov/" });
        transparency.caveats.push("Florida-only dataset based on paid claims; prices change frequently.");
      } else {
        transparency.caveats.push("Florida MyFloridaRX returned no rows for this query.");
      }
    } catch {
      transparency.caveats.push("Florida MyFloridaRX fetch error.");
    }
  }

  // Mock
  if (includeMock) {
    transparency.attempted.push("Mock");
    const mockFiltered = MOCK
      .filter((r) => r.drug.toLowerCase().includes(normalizedDrug))
      .filter((r) => (zip ? (r as any).zipCoverage?.includes(zip) : true))
      .map((r) => ({
        ...r,
        qty,
        unitPrice: Number((r.totalPrice / r.qty).toFixed(4)),
        totalPrice: Number(((r.totalPrice / r.qty) * qty).toFixed(4)),
        zip: zip || null,
        chain: deriveChain(r.pharmacy),
      }));
    rows.push(...mockFiltered);
    transparency.datasets.push({ name: "Mock", info: "Demonstration data for development." });
  }

  // Chain filter
  if (chainSet.size) {
    rows = rows.filter(r => r.chain && chainSet.has(r.chain));
    transparency.caveats.push("Chain filter applied; non-chain datasets without a pharmacy (e.g., NADAC) are omitted.");
  }
  
	// Optional form/strength filters
	if (formFilter) {
	  rows = rows.filter(r => (r.form || "").toLowerCase().includes(formFilter));
	  transparency.caveats.push(`Form filter applied: "${formFilter}".`);
	}
	if (strengthFilter) {
	  rows = rows.filter(r => (r.strength || "").toLowerCase().includes(strengthFilter));
	  transparency.caveats.push(`Strength filter applied: "${strengthFilter}".`);
	}
	
	if (dedupe === "chain" || dedupe === "pharmacy") {
	  const keyFn = dedupe === "chain"
		? (r: PriceRow) => r.chain || r.pharmacy || "unknown"
		: (r: PriceRow) => r.pharmacy || "unknown";

	  const picked = new Map<string, PriceRow>();
	  for (const r of rows) {
		const k = keyFn(r);
		const prev = picked.get(k);
		if (!prev || r.totalPrice < prev.totalPrice) picked.set(k, r);
	  }
	  rows = Array.from(picked.values());
	  transparency.caveats.push(`Deduped by ${dedupe}; kept the cheapest per ${dedupe}.`);
	}



  // Sort + limit
  rows.sort((a, b) => a.totalPrice - b.totalPrice);
  const results = rows.slice(0, limit);

  // Optional group summary by chain
  const groupSummary: Array<{ chain: string; count: number; minTotal: number }> = [];
  if (results.length) {
    const m = new Map<string, { count: number; min: number }>();
    for (const r of results) {
      if (!r.chain) continue;
      const rec = m.get(r.chain) || { count: 0, min: Number.POSITIVE_INFINITY };
      rec.count += 1;
      rec.min = Math.min(rec.min, r.totalPrice);
      m.set(r.chain, rec);
    }
    for (const [chain, rec] of m) groupSummary.push({ chain, count: rec.count, minTotal: Number(rec.min.toFixed(4)) });
  }

  // Headers
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "mediFindr-privacy": privacy,
    "X-RateLimit-Limit": String(RATE_MAX),
    "X-RateLimit-Remaining": String(Math.max(0, rl.remaining)),
    "X-RateLimit-Reset": String(rl.resetAt),
  };

  return NextResponse.json(
    {
      ok: true,
      count: results.length,
      privacy,
      inputs: {
        drug: rawDrug,
        normalizedDrug,
        zip: zip || null,
        qty,
        limit,
        includeGoodRx,
        includeNadac,
        includeMock,
        includeRxNorm,
        includeFlorida,
        flCounty: flCounty || null,
        chains: chainParam || null,
		dedupe,
		form: formFilter || null,
		strength: strengthFilter || null,
      },
      results,
      groupSummary,
      transparency,
    },
    { headers }
  );
}
