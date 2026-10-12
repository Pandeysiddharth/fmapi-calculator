/* Pricing engine — browser port of pricing/engine.py. Same inputs, same outputs. */

const CACHE_SCENARIO_SHARES = [0, 0.25, 0.5, 0.75, 1];
const MAX_COMPARE_MODELS = 5;

const DEFAULT_COMPLEXITIES = [
  { name: "Simple", input: 6.5, output: 6.5 },
  { name: "Medium", input: 17.7, output: 17.7 },
  { name: "Complex", input: 38.7, output: 38.7 },
];
const DEFAULT_TIERS = [
  { name: "1 to 2", queries: 20, simple: 0.8, medium: 0.2, complex: 0.0, clients: 1 },
  { name: "3 to 5", queries: 50, simple: 0.7, medium: 0.2, complex: 0.1, clients: 1 },
  { name: "6 to 10", queries: 100, simple: 0.7, medium: 0.2, complex: 0.1, clients: 1 },
  { name: "11 to 20", queries: 250, simple: 0.7, medium: 0.2, complex: 0.1, clients: 1 },
  { name: "21 to 50", queries: 500, simple: 0.7, medium: 0.2, complex: 0.1, clients: 1 },
  { name: "51 to 100", queries: 1000, simple: 0.6, medium: 0.3, complex: 0.1, clients: 1 },
  { name: "100+", queries: 2000, simple: 0.6, medium: 0.3, complex: 0.1, clients: 1 },
];
const DEFAULT_ASSUMPTIONS = {
  model: "GPT-5.4",
  context_band: "Short",
  usd_per_dbu: 0.07,
  token_units: "Thousands",
  cache_read_share: 0.0,
  regional_uplift: false,
  regional_uplift_rate: 0.10,
  billing_months: 12,
  extra_input_tokens_per_query: 0,
  cache_threshold_tokens: 1024,
  write_share_non_read: 0.0,
  write_duration: "Default",
};

class ScenarioError extends Error {}

function defaultScenario() {
  return JSON.parse(JSON.stringify({
    assumptions: DEFAULT_ASSUMPTIONS,
    complexities: DEFAULT_COMPLEXITIES,
    tiers: DEFAULT_TIERS,
    compare_models: ["GPT-5.4", "GPT-5.4 Mini", "Claude Sonnet 4.5"],
  }));
}

function num(v, name, lo, hi) {
  const x = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(x)) throw new ScenarioError(`${name} must be a number`);
  if (lo != null && x < lo) throw new ScenarioError(`${name} must be at least ${lo}`);
  if (hi != null && x > hi) throw new ScenarioError(`${name} must be at most ${hi}`);
  return x;
}

function normalise(scenario) {
  const s = defaultScenario();
  const a = s.assumptions;
  Object.entries(scenario.assumptions || {}).forEach(([k, v]) => { if (k in a) a[k] = v; });
  if (!RATE_CARD[a.model]) throw new ScenarioError(`Unknown model '${a.model}'`);
  if (!["Short", "Long"].includes(a.context_band)) throw new ScenarioError("context_band must be Short or Long");
  if (!["Tokens", "Thousands"].includes(a.token_units)) throw new ScenarioError("token_units must be Tokens or Thousands");
  if (!["Default", "1hr"].includes(a.write_duration)) throw new ScenarioError("write_duration must be Default or 1hr");
  a.usd_per_dbu = num(a.usd_per_dbu, "USD per DBU", 0);
  a.cache_read_share = num(a.cache_read_share, "Cache read share", 0, 1);
  a.regional_uplift = !!a.regional_uplift;
  a.regional_uplift_rate = num(a.regional_uplift_rate, "Regional uplift rate", 0);
  a.billing_months = num(a.billing_months, "Billing months", 0);
  a.extra_input_tokens_per_query = num(a.extra_input_tokens_per_query, "Additional input tokens", 0);
  a.cache_threshold_tokens = num(a.cache_threshold_tokens, "Cache threshold", 0);
  a.write_share_non_read = num(a.write_share_non_read, "Cache write share", 0, 1);

  const comps = scenario.complexities || DEFAULT_COMPLEXITIES;
  if (comps.length !== 3) throw new ScenarioError("Exactly three complexity profiles are required");
  s.complexities = comps.map((c, i) => ({
    name: String(c.name || DEFAULT_COMPLEXITIES[i].name),
    input: num(c.input ?? 0, `${c.name || "complexity"} input tokens`, 0),
    output: num(c.output ?? 0, `${c.name || "complexity"} output tokens`, 0),
  }));

  const tiers = scenario.tiers || DEFAULT_TIERS;
  if (!tiers.length) throw new ScenarioError("At least one user tier is required");
  s.tiers = tiers.map((t, i) => {
    const name = String(t.name || `Tier ${i + 1}`);
    return {
      name,
      queries: num(t.queries ?? 0, `${name} queries`, 0),
      simple: num(t.simple ?? 0, `${name} simple %`, 0, 1),
      medium: num(t.medium ?? 0, `${name} medium %`, 0, 1),
      complex: num(t.complex ?? 0, `${name} complex %`, 0, 1),
      clients: num(t.clients ?? 0, `${name} clients`, 0),
    };
  });

  const cmp = scenario.compare_models || [];
  if (!Array.isArray(cmp)) throw new ScenarioError("compare_models must be a list");
  const seen = [];
  cmp.forEach(m => {
    if (!RATE_CARD[m]) throw new ScenarioError(`Unknown model '${m}' in compare_models`);
    if (!seen.includes(m)) seen.push(m);
  });
  if (seen.length > MAX_COMPARE_MODELS) throw new ScenarioError(`Compare at most ${MAX_COMPARE_MODELS} models`);
  s.compare_models = seen;
  return s;
}

function priceModel(model, a) {
  const rc = RATE_CARD[model];
  const br = bandRates(model, a.context_band);
  const eligible = !!rc.regional_uplift_eligible;
  const uplift = (a.regional_uplift && eligible) ? a.regional_uplift_rate : 0;
  const eff = a.usd_per_dbu * (1 + uplift);
  const separate = rc.separate_write_tariff;
  const oneHrListed = br.cache_write_1hr != null;
  const wEff = separate ? a.write_share_non_read : 0;

  let writeDbu, rateStatus;
  if (!separate) { writeDbu = null; rateStatus = "NO SEPARATE TARIFF"; }
  else if (a.write_duration === "1hr") { writeDbu = br.cache_write_1hr; rateStatus = oneHrListed ? "LISTED" : "1-HOUR RATE NOT LISTED"; }
  else { writeDbu = br.cache_write_default; rateStatus = "LISTED"; }

  const notPriced = separate && writeDbu == null && wEff > 0;
  const r = a.cache_read_share;
  const writeAll = (1 - r) * wEff;
  const ordinary = 1 - r - writeAll;
  const inputUsd = br.input * eff, outputUsd = br.output * eff, readUsd = br.cache_read * eff;
  const writeUsd = (writeDbu || 0) * eff;

  return {
    model, provider: rc.provider, regional_uplift_eligible: eligible,
    effective_usd_per_dbu: eff,
    input_dbu: br.input, output_dbu: br.output, cache_read_dbu: br.cache_read, cache_write_dbu: writeDbu,
    input_usd: inputUsd, output_usd: outputUsd, cache_read_usd: readUsd, cache_write_usd: writeUsd,
    separate_write_tariff: separate, one_hour_write_listed: oneHrListed,
    write_share_non_read_effective: wEff, read_share: r, write_share_all: writeAll, ordinary_share: ordinary,
    blended_input_usd: ordinary * inputUsd + r * readUsd + writeAll * writeUsd,
    rate_card_status: rateStatus, estimate_status: notPriced ? "NOT PRICED" : "OK",
  };
}

function actualTokens(complexities, a) {
  const mult = a.token_units === "Tokens" ? 1 : 1000;
  return [complexities.map(c => {
    const ai = c.input * mult + a.extra_input_tokens_per_query, ao = c.output * mult;
    return { ...c, actual_input: ai, actual_output: ao, total_tokens: ai + ao,
             cache_check: ai < a.cache_threshold_tokens ? "Short input: verify cache eligibility" : "OK" };
  }), mult];
}

function cost(inT, outT, mp, withCache) {
  const u = TOKENS_PER_PRICING_UNIT;
  const ordT = withCache ? inT * mp.ordinary_share : inT;
  const rdT = withCache ? inT * mp.read_share : 0;
  const wrT = withCache ? inT * mp.write_share_all : 0;
  const ordC = ordT / u * mp.input_usd, rdC = rdT / u * mp.cache_read_usd, wrC = wrT / u * mp.cache_write_usd;
  const outC = outT / u * mp.output_usd;
  return { ordinary_tokens: ordT, read_tokens: rdT, write_tokens: wrT, ordinary_usd: ordC, read_usd: rdC,
           write_usd: wrC, output_usd: outC, total_usd: ordC + rdC + wrC + outC };
}

function tierRows(tiers, comps, mp, a) {
  const rows = tiers.map(t => {
    const mixTotal = t.simple + t.medium + t.complex;
    const q = t.queries, qs = [q * t.simple, q * t.medium, q * t.complex];
    const inTok = qs.reduce((acc, n, i) => acc + n * comps[i].actual_input, 0);
    const outTok = qs.reduce((acc, n, i) => acc + n * comps[i].actual_output, 0);
    const wc = cost(inTok, outTok, mp, true), nc = cost(inTok, outTok, mp, false);
    const savings = nc.total_usd - wc.total_usd;
    return {
      name: t.name, queries: q, clients: t.clients, simple: t.simple, medium: t.medium, complex: t.complex,
      mix_total: mixTotal, mix_ok: Math.abs(mixTotal - 1) < 1e-9,
      simple_queries: qs[0], medium_queries: qs[1], complex_queries: qs[2], portfolio_queries: q * t.clients,
      input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok,
      avg_tokens_per_query: q ? (inTok + outTok) / q : 0,
      ordinary_input_tokens: wc.ordinary_tokens, cache_read_tokens: wc.read_tokens, cache_write_tokens: wc.write_tokens,
      ordinary_input_usd: wc.ordinary_usd, cache_read_usd: wc.read_usd, cache_write_usd: wc.write_usd, output_usd: wc.output_usd,
      cost_with_cache: wc.total_usd, cost_no_cache: nc.total_usd, savings,
      savings_pct: nc.total_usd ? savings / nc.total_usd : 0,
      cost_year: wc.total_usd * a.billing_months,
      portfolio_month: wc.total_usd * t.clients, portfolio_year: wc.total_usd * t.clients * a.billing_months,
      portfolio_no_cache_month: nc.total_usd * t.clients,
      dbu_per_client_month: mp.effective_usd_per_dbu ? wc.total_usd / mp.effective_usd_per_dbu : 0,
    };
  });
  const wsum = k => rows.reduce((acc, r) => acc + r[k] * r.clients, 0);
  const pIn = wsum("input_tokens"), pOut = wsum("output_tokens");
  const pQ = rows.reduce((acc, r) => acc + r.portfolio_queries, 0);
  const pWith = wsum("cost_with_cache"), pNo = wsum("cost_no_cache");
  const portfolio = {
    clients: rows.reduce((acc, r) => acc + r.clients, 0), queries: pQ,
    input_tokens: pIn, output_tokens: pOut, total_tokens: pIn + pOut,
    avg_tokens_per_query: pQ ? (pIn + pOut) / pQ : 0,
    ordinary_input_tokens: wsum("ordinary_input_tokens"), cache_read_tokens: wsum("cache_read_tokens"),
    cache_write_tokens: wsum("cache_write_tokens"), ordinary_input_usd: wsum("ordinary_input_usd"),
    cache_read_usd: wsum("cache_read_usd"), cache_write_usd: wsum("cache_write_usd"), output_usd: wsum("output_usd"),
    cost_with_cache: pWith, cost_no_cache: pNo, savings: pNo - pWith, savings_pct: pNo ? (pNo - pWith) / pNo : 0,
    cost_year: pWith * a.billing_months,
    dbu_month: mp.effective_usd_per_dbu ? pWith / mp.effective_usd_per_dbu : 0,
  };
  return [rows, portfolio];
}

function checks(s, comps, rows, mp) {
  const a = s.assumptions;
  const list = [
    ["Tier mixes total 100%", rows.every(r => r.mix_ok), "Each tier must sum to 100%."],
    ["Selected model is valid", !!RATE_CARD[a.model], "Exactly one matching rate row."],
    ["Cache share is 0–100%", a.cache_read_share >= 0 && a.cache_read_share <= 1, "Token-weighted fraction."],
    ["Non-negative workload", s.tiers.every(t => t.queries >= 0 && t.clients >= 0) && comps.every(c => c.input >= 0 && c.output >= 0), "No negative tokens, mix, queries or clients."],
    ["Pricing bounds", a.usd_per_dbu > 0 && mp.input_usd >= 0 && mp.output_usd >= 0, "Rates and conversion assumptions are valid."],
    ["Input partition reconciles", Math.abs(mp.ordinary_share + mp.read_share + mp.write_share_all - 1) < 1e-9, "Ordinary + read + write input tokens = all input."],
    ["Cache rate <= input rate", mp.cache_read_usd <= mp.input_usd, "Selected cache-read discount is logical."],
    ["Write share 0–100%", a.write_share_non_read >= 0 && a.write_share_non_read <= 1, "Write share is a fraction of non-read input."],
    ["Required cache-write tariff available", mp.estimate_status === "OK", "Missing rates suppress pricing, never silently become free."],
  ];
  return list.map(([check, ok, meaning]) => ({ check, status: ok ? "PASS" : "FAIL", meaning }));
}

function calculate(scenario) {
  const s = normalise(scenario);
  const a = s.assumptions;
  const [comps, mult] = actualTokens(s.complexities, a);
  const mp = priceModel(a.model, a);
  comps.forEach(c => {
    const wc = cost(c.actual_input, c.actual_output, mp, true).total_usd;
    const nc = cost(c.actual_input, c.actual_output, mp, false).total_usd;
    c.usd_no_cache = nc; c.usd_with_cache = wc; c.savings = nc - wc;
  });
  const [tiers, portfolio] = tierRows(s.tiers, comps, mp, a);

  const comparison = MODEL_NAMES.map(m => {
    const mpm = priceModel(m, a);
    const [, p] = tierRows(s.tiers, comps, mpm, a);
    return {
      model: m, provider: mpm.provider, selected: m === a.model,
      input_usd: mpm.input_usd, output_usd: mpm.output_usd, cache_read_usd: mpm.cache_read_usd, cache_write_usd: mpm.cache_write_usd,
      write_share_non_read: mpm.write_share_non_read_effective, write_share_all: mpm.write_share_all,
      effective_usd_per_dbu: mpm.effective_usd_per_dbu, regional_uplift_eligible: mpm.regional_uplift_eligible,
      estimate_status: mpm.estimate_status,
      portfolio_no_cache_month: p.cost_no_cache, portfolio_with_cache_month: p.cost_with_cache,
      savings_month: p.savings, savings_pct: p.savings_pct, portfolio_year: p.cost_year,
    };
  });

  const cacheFor = (model) => CACHE_SCENARIO_SHARES.map(share => {
    const a2 = { ...a, cache_read_share: share };
    const mps = priceModel(model, a2);
    const [, p] = tierRows(s.tiers, comps, mps, a2);
    return { cache_read_share: share, portfolio_month: p.cost_with_cache, portfolio_year: p.cost_year,
             savings_month: p.savings, savings_pct: p.savings_pct, blended_input_usd: mps.blended_input_usd,
             output_usd_month: p.output_usd, cache_write_usd_month: p.cache_write_usd,
             cache_write_share_all: mps.write_share_all, status: mps.estimate_status };
  });
  const cache_scenarios = cacheFor(a.model);

  const side_by_side = s.compare_models.map(m => {
    const mpm = priceModel(m, a);
    const [rowsM, pM] = tierRows(s.tiers, comps, mpm, a);
    return {
      model: m, provider: mpm.provider, selected: m === a.model, pricing: mpm, estimate_status: mpm.estimate_status,
      tiers: rowsM.map(t => ({ name: t.name, cost_with_cache: t.cost_with_cache, cost_no_cache: t.cost_no_cache,
                               cost_year: t.cost_year, portfolio_month: t.portfolio_month })),
      portfolio: pM,
      cache_scenarios: cacheFor(m).map(c => ({ cache_read_share: c.cache_read_share, portfolio_month: c.portfolio_month,
                                                savings_pct: c.savings_pct, status: c.status })),
    };
  });
  const priced = side_by_side.filter(x => x.estimate_status === "OK");
  const cheapest = priced.length ? priced.reduce((b, x) => x.portfolio.cost_with_cache < b.portfolio.cost_with_cache ? x : b) : null;
  const base = cheapest ? cheapest.portfolio.cost_with_cache : 0;
  side_by_side.forEach(x => {
    x.cheapest = !!cheapest && x.model === cheapest.model;
    x.vs_cheapest_ratio = (base && x.estimate_status === "OK") ? x.portfolio.cost_with_cache / base : null;
  });

  const ch = checks(s, comps, tiers, mp);
  return {
    scenario: s, token_unit_multiplier: mult, pricing: mp, complexities: comps, tiers, portfolio, comparison,
    cache_scenarios, side_by_side, checks: ch,
    integrity_status: ch.every(c => c.status === "PASS") ? "ALL CHECKS PASS" : "CHECK FAILED",
    estimate_status: mp.estimate_status, not_priced: mp.estimate_status !== "OK",
  };
}

if (typeof module !== "undefined") module.exports = { calculate, defaultScenario, ScenarioError, MODEL_NAMES, RATE_CARD };
