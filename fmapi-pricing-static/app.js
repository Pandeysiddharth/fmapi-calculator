/* FMAPI pricing calculator — front-end controller (no build step). */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    scenario: null,       // {assumptions, complexities, tiers}
    models: [],
    result: null,
    basis: "client",      // ladder basis: client | portfolio
    groupByProvider: false,
    pending: null,
    rateSnapshot: "",
  };

  // ------------------------------------------------------------ formatting
  const fmt = {
    usd(v, forceDp) {
      if (v == null || Number.isNaN(v)) return "—";
      const a = Math.abs(v);
      const dp = forceDp != null ? forceDp : a >= 100 ? 2 : a >= 1 ? 4 : 6;
      return (v < 0 ? "−" : "") + "$" + a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    },
    pct(v, dp = 1) { return v == null ? "—" : (v * 100).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) + "%"; },
    int(v) { return v == null ? "—" : Math.round(v).toLocaleString("en-US"); },
    num(v, dp = 1) { return v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp }); },
    tokens(v) {
      if (v == null) return "—";
      if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (v >= 1e4) return (v / 1e3).toFixed(1) + "k";
      return fmt.num(v, 1);
    },
  };

  // ------------------------------------------------------------ engine (runs locally)
  let debounceTimer = null;
  function scheduleCalc(immediate = false) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recalc, immediate ? 0 : 120);
  }

  function recalc() {
    try {
      state.result = calculate(state.scenario);
      hideBanner();
      render();
    } catch (e) {
      showBanner(e.message, true);
    }
  }

  function download(kind) {
    const btn = kind === "xlsx" ? $("#btn-xlsx") : $("#btn-pdf");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Preparing…";
    setTimeout(() => {
      try {
        if (!state.result) state.result = calculate(state.scenario);
        if (kind === "xlsx") FMAPI_EXPORT.buildXlsx(state.result); else FMAPI_EXPORT.buildPdf(state.result);
      } catch (e) {
        showBanner(`Export failed: ${e.message}`, true);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    }, 30);
  }

  function showBanner(text, isError = false) {
    const b = $("#banner");
    b.textContent = text; b.hidden = false;
    b.classList.toggle("is-error", isError);
  }
  function hideBanner() { $("#banner").hidden = true; }

  // ------------------------------------------------------------ rail <-> state
  const A = () => state.scenario.assumptions;

  function bindRail() {
    const sel = $("#f-model");
    sel.innerHTML = "";
    const groups = { OpenAI: [], Anthropic: [] };
    state.models.forEach(m => (groups[m.provider] = groups[m.provider] || []).push(m));
    Object.entries(groups).forEach(([prov, ms]) => {
      const og = document.createElement("optgroup"); og.label = prov;
      ms.forEach(m => { const o = document.createElement("option"); o.value = m.name; o.textContent = m.name; og.appendChild(o); });
      sel.appendChild(og);
    });

    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on("#f-model", "change", e => { A().model = e.target.value; syncRail(); scheduleCalc(true); });
    on("#f-band", "change", e => { A().context_band = e.target.value; scheduleCalc(true); });
    on("#f-usd-dbu", "input", e => { A().usd_per_dbu = numOr(e.target.value, 0); scheduleCalc(); });
    on("#f-regional", "change", e => { A().regional_uplift = e.target.checked; scheduleCalc(true); });
    on("#f-months", "input", e => { A().billing_months = numOr(e.target.value, 0); scheduleCalc(); });
    on("#f-units", "change", e => { A().token_units = e.target.value; scheduleCalc(true); });
    on("#f-extra", "input", e => { A().extra_input_tokens_per_query = numOr(e.target.value, 0); scheduleCalc(); });
    on("#f-threshold", "input", e => { A().cache_threshold_tokens = numOr(e.target.value, 0); scheduleCalc(); });
    on("#f-read", "input", e => { A().cache_read_share = +e.target.value / 100; $("#o-read").value = e.target.value + "%"; scheduleCalc(); });
    on("#f-write", "input", e => { A().write_share_non_read = +e.target.value / 100; $("#o-write").value = e.target.value + "%"; scheduleCalc(); });
    on("#f-duration", "change", e => { A().write_duration = e.target.value; scheduleCalc(true); });

    on("#btn-reset", "click", () => { loadDefaults(); scheduleCalc(true); });
    on("#btn-xlsx", "click", () => download("xlsx"));
    on("#btn-pdf", "click", () => download("pdf"));
    on("#btn-add-tier", "click", () => {
      state.scenario.tiers.push({ name: `Tier ${state.scenario.tiers.length + 1}`, queries: 100, simple: 0.7, medium: 0.2, complex: 0.1, clients: 1 });
      scheduleCalc(true);
    });
    on("#f-cmp-provider", "change", e => { state.groupByProvider = e.target.checked; renderComparison(); });
    on("#btn-compare-add", "click", addCompareModel);
    on("#f-compare-add", "keydown", e => { if (e.key === "Enter") addCompareModel(); });
    $$(".seg button").forEach(b => b.addEventListener("click", () => {
      state.basis = b.dataset.basis;
      $$(".seg button").forEach(x => x.classList.toggle("on", x === b));
      renderLadder();
    }));
  }

  const CMP_COLORS = ["#0E6E6E", "#534AB7", "#D85A30", "#185FA5", "#993556"];
  const MAX_COMPARE = 5;

  function addCompareModel() {
    const sel = $("#f-compare-add");
    const m = sel.value;
    const list = state.scenario.compare_models || (state.scenario.compare_models = []);
    if (!m || list.includes(m) || list.length >= MAX_COMPARE) return;
    list.push(m);
    scheduleCalc(true);
  }

  function removeCompareModel(m) {
    state.scenario.compare_models = (state.scenario.compare_models || []).filter(x => x !== m);
    scheduleCalc(true);
  }

  function syncCompareSelect() {
    const sel = $("#f-compare-add");
    const list = state.scenario.compare_models || [];
    const full = list.length >= MAX_COMPARE;
    sel.innerHTML = "";
    const groups = {};
    state.models.forEach(m => (groups[m.provider] = groups[m.provider] || []).push(m));
    Object.entries(groups).forEach(([prov, ms]) => {
      const og = document.createElement("optgroup"); og.label = prov;
      ms.filter(m => !list.includes(m.name)).forEach(m => {
        const o = document.createElement("option"); o.value = m.name; o.textContent = m.name; og.appendChild(o);
      });
      if (og.children.length) sel.appendChild(og);
    });
    sel.disabled = full;
    $("#btn-compare-add").disabled = full;
    $("#btn-compare-add").textContent = full ? `Max ${MAX_COMPARE}` : "Add";
  }

  function numOr(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

  function syncRail() {
    const a = A();
    $("#f-model").value = a.model;
    $("#f-band").value = a.context_band;
    $("#f-usd-dbu").value = a.usd_per_dbu;
    $("#f-regional").checked = a.regional_uplift;
    $("#f-months").value = a.billing_months;
    $("#f-units").value = a.token_units;
    $("#f-extra").value = a.extra_input_tokens_per_query;
    $("#f-threshold").value = a.cache_threshold_tokens;
    $("#f-read").value = Math.round(a.cache_read_share * 100);
    $("#o-read").value = Math.round(a.cache_read_share * 100) + "%";
    $("#f-write").value = Math.round(a.write_share_non_read * 100);
    $("#o-write").value = Math.round(a.write_share_non_read * 100) + "%";
    $("#f-duration").value = a.write_duration;

    syncCompareSelect();
    const m = state.models.find(x => x.name === a.model) || {};
    $("#claude-controls").hidden = !m.separate_write_tariff;
    $("#model-note").textContent = m.context_note || "";
    $("#regional-note").textContent = m.regional_uplift_eligible ? "" : "(not eligible for this model)";
  }

  // ------------------------------------------------------------ render
  function render() {
    const r = state.result;
    if (!r) return;
    renderHeadline(r);
    renderRates(r);
    renderLadder();
    renderTiers(r);
    renderComplexities(r);
    renderComparison();
    renderCache(r);
    renderSideBySide(r);
    renderChecks(r);
    $("#ladder-model").textContent = `${r.scenario.assumptions.model}, ${r.scenario.assumptions.context_band.toLowerCase()} context`;
  }

  function renderHeadline(r) {
    const p = r.portfolio, a = r.scenario.assumptions;
    const fig = $("#h-monthly");
    fig.classList.toggle("is-amber", r.not_priced);
    fig.textContent = r.not_priced ? "Not priced" : fmt.usd(p.cost_with_cache);
    $("#h-meta").textContent = r.not_priced
      ? `${a.model} has no listed ${a.write_duration === "1hr" ? "1-hour" : ""} cache-write rate; set writes to 0% or choose the Default duration.`
      : `${a.model}, ${p.clients.toLocaleString()} clients, ${fmt.pct(a.cache_read_share, 0)} cached input${r.pricing.write_share_all ? `, ${fmt.pct(r.pricing.write_share_all, 0)} of input written` : ""}.`;
    $("#h-annual").textContent = r.not_priced ? "—" : fmt.usd(p.cost_year);
    $("#h-nocache").textContent = fmt.usd(p.cost_no_cache);
    $("#h-savings").textContent = r.not_priced ? "—" : `${fmt.usd(p.savings)} (${fmt.pct(p.savings_pct)})`;
    $("#h-clients").textContent = fmt.int(p.clients);
    $("#h-queries").textContent = fmt.int(p.queries);
    $("#h-tokens").textContent = fmt.tokens(p.total_tokens);
  }

  function renderRates(r) {
    const p = r.pricing;
    const rows = [
      ["Effective USD / DBU", fmt.num(p.effective_usd_per_dbu, 4)],
      ["Input", fmt.usd(p.input_usd, 4)],
      ["Output", fmt.usd(p.output_usd, 4)],
      ["Cache read", fmt.usd(p.cache_read_usd, 4)],
    ];
    if (p.separate_write_tariff) rows.push(["Cache write", p.cache_write_dbu == null ? "not listed" : fmt.usd(p.cache_write_usd, 4)]);
    rows.push(["Blended input", fmt.usd(p.blended_input_usd, 4)]);
    $("#rate-list").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

    const ws = $("#write-status");
    if (!p.separate_write_tariff) {
      ws.textContent = "No separate cache-write tariff is listed for this model; the write setting does not apply.";
      ws.classList.remove("is-amber");
    } else if (p.estimate_status !== "OK") {
      ws.textContent = "Not priced: the selected write duration has no listed rate. Choose Default or set writes to 0%.";
      ws.classList.add("is-amber");
    } else {
      ws.textContent = `Input billed as ${fmt.pct(p.ordinary_share, 0)} ordinary, ${fmt.pct(p.read_share, 0)} cache read, ${fmt.pct(p.write_share_all, 0)} cache write.`;
      ws.classList.remove("is-amber");
    }
  }

  function renderLadder() {
    const r = state.result; if (!r) return;
    const perClient = state.basis === "client";
    const rows = r.tiers.map(t => ({
      name: t.name,
      withC: perClient ? t.cost_with_cache : t.portfolio_month,
      noC: perClient ? t.cost_no_cache : t.portfolio_no_cache_month,
      clients: t.clients,
    }));
    const max = Math.max(1e-12, ...rows.map(x => Math.max(x.withC, x.noC)));
    $("#ladder").innerHTML = rows.map(x => `
      <div class="lname">${esc(x.name)}</div>
      <div class="lbar ${r.not_priced ? "is-amber" : ""}" title="${perClient ? "per client" : `${x.clients} clients`}">
        <div class="ghost" style="width:${(x.noC / max * 100).toFixed(2)}%"></div>
        <div class="fill" style="width:${r.not_priced ? 0 : (x.withC / max * 100).toFixed(2)}%"></div>
      </div>
      <div class="lval">${r.not_priced ? "—" : fmt.usd(x.withC)}<small>${perClient ? "per client / mo" : `${fmt.int(x.clients)} client${x.clients === 1 ? "" : "s"} / mo`}</small></div>
    `).join("");
  }

  function cellInput(value, attrs, cls = "") {
    return `<input class="cell-input ${cls}" type="number" value="${value}" ${attrs}>`;
  }

  function renderTiers(r) {
    const tbody = $("#tier-table tbody");
    tbody.innerHTML = r.tiers.map((t, i) => `
      <tr data-i="${i}">
        <td class="l"><input class="cell-input wide" type="text" data-k="name" value="${esc(t.name)}"></td>
        <td>${cellInput(t.queries, 'data-k="queries" min="0" step="1"')}</td>
        <td>${cellInput(round(t.simple * 100), 'data-k="simple" min="0" max="100" step="1"', t.mix_ok ? "" : "is-bad")}</td>
        <td>${cellInput(round(t.medium * 100), 'data-k="medium" min="0" max="100" step="1"', t.mix_ok ? "" : "is-bad")}</td>
        <td>${cellInput(round(t.complex * 100), 'data-k="complex" min="0" max="100" step="1"', t.mix_ok ? "" : "is-bad")}</td>
        <td>${cellInput(t.clients, 'data-k="clients" min="0" step="1"')}</td>
        <td class="dim">${fmt.tokens(t.total_tokens)}</td>
        <td class="sel">${r.not_priced ? "—" : fmt.usd(t.cost_with_cache)}</td>
        <td>${fmt.usd(t.cost_no_cache)}</td>
        <td class="${t.savings < 0 ? "red" : ""}">${r.not_priced ? "—" : fmt.pct(t.savings_pct)}</td>
        <td>${r.not_priced ? "—" : fmt.usd(t.cost_year)}</td>
        <td>${r.not_priced ? "—" : fmt.usd(t.portfolio_month)}</td>
        <td>${r.not_priced ? "—" : fmt.usd(t.portfolio_year)}</td>
        <td class="dim">${fmt.num(t.dbu_per_client_month, 4)}</td>
        <td><button class="row-remove" type="button" title="Remove tier" aria-label="Remove ${esc(t.name)}" ${r.tiers.length <= 1 ? "disabled" : ""}>×</button></td>
      </tr>`).join("");
    const p = r.portfolio;
    $("#tier-table tfoot").innerHTML = `
      <tr>
        <td class="l">Portfolio total</td>
        <td>${fmt.int(p.queries)}</td><td colspan="3" class="dim" style="text-align:left;font-weight:400">${r.tiers.every(t => t.mix_ok) ? "All mixes total 100%" : "A tier mix does not total 100%"}</td>
        <td>${fmt.int(p.clients)}</td>
        <td class="dim">${fmt.tokens(p.total_tokens)}</td>
        <td colspan="4"></td>
        <td>${r.not_priced ? "—" : fmt.usd(p.cost_with_cache)}</td>
        <td>${r.not_priced ? "—" : fmt.usd(p.cost_year)}</td>
        <td class="dim">${fmt.num(p.dbu_month, 4)}</td><td></td>
      </tr>`;

    $$("input", tbody).forEach(inp => inp.addEventListener("input", e => {
      const tr = e.target.closest("tr"), i = +tr.dataset.i, k = e.target.dataset.k;
      const t = state.scenario.tiers[i];
      if (k === "name") t.name = e.target.value;
      else if (["simple", "medium", "complex"].includes(k)) t[k] = numOr(e.target.value, 0) / 100;
      else t[k] = numOr(e.target.value, 0);
      scheduleCalc();
    }));
    $$(".row-remove", tbody).forEach(btn => btn.addEventListener("click", e => {
      const i = +e.target.closest("tr").dataset.i;
      state.scenario.tiers.splice(i, 1);
      scheduleCalc(true);
    }));
  }

  function renderComplexities(r) {
    const tbody = $("#cx-table tbody");
    const units = r.scenario.assumptions.token_units === "Thousands" ? "k" : "";
    tbody.innerHTML = r.complexities.map((c, i) => `
      <tr data-i="${i}">
        <td class="l">${esc(c.name)}</td>
        <td>${cellInput(c.input, 'data-k="input" min="0" step="0.1"')} ${units}</td>
        <td>${cellInput(c.output, 'data-k="output" min="0" step="0.1"')} ${units}</td>
        <td class="dim">${fmt.num(c.actual_input, 1)}</td>
        <td class="dim">${fmt.num(c.actual_output, 1)}</td>
        <td class="dim">${fmt.num(c.total_tokens, 1)}</td>
        <td>${fmt.usd(c.usd_no_cache, 8)}</td>
        <td class="sel">${r.not_priced ? "—" : fmt.usd(c.usd_with_cache, 8)}</td>
        <td class="l ${c.cache_check === "OK" ? "ok" : "amber"}">${esc(c.cache_check)}</td>
      </tr>`).join("");
    $$("input", tbody).forEach(inp => inp.addEventListener("input", e => {
      const i = +e.target.closest("tr").dataset.i, k = e.target.dataset.k;
      state.scenario.complexities[i][k] = numOr(e.target.value, 0);
      scheduleCalc();
    }));
  }

  function renderComparison() {
    const r = state.result; if (!r) return;
    const tbody = $("#cmp-table tbody");
    const row = c => `
      <tr data-model="${esc(c.model)}" class="${c.selected ? "is-selected" : ""}" tabindex="0">
        <td class="l">${esc(c.model)}${c.selected ? " (selected)" : ""}</td>
        <td class="l dim">${c.provider}</td>
        <td>${fmt.usd(c.input_usd, 2)}</td>
        <td>${fmt.usd(c.output_usd, 2)}</td>
        <td>${fmt.usd(c.cache_read_usd, 2)}</td>
        <td class="${c.cache_write_usd ? "" : "dim"}">${c.cache_write_usd ? fmt.usd(c.cache_write_usd, 2) : "—"}</td>
        <td>${fmt.usd(c.portfolio_no_cache_month)}</td>
        <td>${c.estimate_status === "OK" ? fmt.usd(c.portfolio_with_cache_month) : "—"}</td>
        <td class="${c.savings_pct < 0 ? "red" : ""}">${c.estimate_status === "OK" ? fmt.pct(c.savings_pct) : "—"}</td>
        <td>${c.estimate_status === "OK" ? fmt.usd(c.portfolio_year) : "—"}</td>
        <td class="l ${c.estimate_status === "OK" ? "ok" : "amber"}">${c.estimate_status === "OK" ? "OK" : "Not priced"}</td>
      </tr>`;
    let html = "";
    if (state.groupByProvider) {
      ["OpenAI", "Anthropic"].forEach(prov => {
        const rows = r.comparison.filter(c => c.provider === prov);
        if (!rows.length) return;
        html += `<tr class="group-head"><td colspan="11">${prov}</td></tr>` + rows.map(row).join("");
      });
    } else {
      html = [...r.comparison].sort((a, b) => a.portfolio_no_cache_month - b.portfolio_no_cache_month).map(row).join("");
    }
    tbody.innerHTML = html;
    $$("tr[data-model]", tbody).forEach(tr => {
      const pick = () => { A().model = tr.dataset.model; syncRail(); scheduleCalc(true); };
      tr.addEventListener("click", pick);
      tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
  }

  function renderCache(r) {
    $("#cache-table tbody").innerHTML = r.cache_scenarios.map(s => `
      <tr class="${Math.abs(s.cache_read_share - r.scenario.assumptions.cache_read_share) < 1e-9 ? "is-selected" : ""}">
        <td>${fmt.pct(s.cache_read_share, 0)}</td>
        <td>${s.status === "OK" ? fmt.usd(s.portfolio_month) : "—"}</td>
        <td>${s.status === "OK" ? fmt.usd(s.portfolio_year) : "—"}</td>
        <td class="${s.savings_month < 0 ? "red" : ""}">${s.status === "OK" ? fmt.usd(s.savings_month) : "—"}</td>
        <td class="${s.savings_pct < 0 ? "red" : ""}">${s.status === "OK" ? fmt.pct(s.savings_pct) : "—"}</td>
        <td>${fmt.usd(s.blended_input_usd, 4)}</td>
        <td>${fmt.usd(s.output_usd_month)}</td>
        <td>${s.status === "OK" ? fmt.usd(s.cache_write_usd_month) : "—"}</td>
        <td>${fmt.pct(s.cache_write_share_all, 0)}</td>
        <td class="l ${s.status === "OK" ? "ok" : "amber"}">${s.status === "OK" ? "OK" : "Not priced"}</td>
      </tr>`).join("");
  }

  function renderSideBySide(r) {
    const list = r.side_by_side || [];
    const color = i => CMP_COLORS[i % CMP_COLORS.length];
    $("#compare-chips").innerHTML = list.map((x, i) => `
      <span class="chip ${x.selected ? "is-selected" : ""}">
        <span class="swatch" style="background:${color(i)}"></span>${esc(x.model)}
        <button type="button" data-m="${esc(x.model)}" aria-label="Remove ${esc(x.model)} from comparison">×</button>
      </span>`).join("");
    $$("#compare-chips button").forEach(b => b.addEventListener("click", () => removeCompareModel(b.dataset.m)));
    syncCompareSelect();

    const show = list.length >= 1;
    $("#compare-empty").hidden = show;
    $("#compare-body").hidden = !show;
    if (!show) return;

    const ok = x => x.estimate_status === "OK";
    const dot = i => `<span class="dot" style="background:${color(i)}"></span>`;
    const head = `<th class="l"></th>` + list.map((x, i) => `<th>${dot(i)}${esc(x.model)}</th>`).join("");

    // Summary
    const sumRows = [
      ["Provider", x => `<span class="dim">${x.provider}</span>`, "l"],
      ["Input USD / 1M", x => fmt.usd(x.pricing.input_usd, 2)],
      ["Output USD / 1M", x => fmt.usd(x.pricing.output_usd, 2)],
      ["Cache read USD / 1M", x => fmt.usd(x.pricing.cache_read_usd, 2)],
      ["Cache write USD / 1M", x => x.pricing.separate_write_tariff ? (x.pricing.cache_write_dbu == null ? "not listed" : fmt.usd(x.pricing.cache_write_usd, 2)) : "—"],
      ["Portfolio / mo, with cache", x => ok(x) ? fmt.usd(x.portfolio.cost_with_cache) : "Not priced", "strong"],
      ["Portfolio / mo, no cache", x => fmt.usd(x.portfolio.cost_no_cache)],
      ["Savings from caching", x => ok(x) ? `${fmt.usd(x.portfolio.savings)} (${fmt.pct(x.portfolio.savings_pct)})` : "—"],
      ["Portfolio / yr", x => ok(x) ? fmt.usd(x.portfolio.cost_year) : "—"],
      ["DBU / mo", x => fmt.num(x.portfolio.dbu_month, 0)],
      ["Cost vs cheapest", x => x.vs_cheapest_ratio == null ? "—" : x.cheapest ? "cheapest" : `${fmt.num(x.vs_cheapest_ratio, 2)}×`],
    ];
    $("#compare-summary thead tr").innerHTML = head;
    $("#compare-summary tbody").innerHTML = sumRows.map(([label, fn, cls]) => `
      <tr><td class="l">${label}</td>${list.map(x => `<td class="${cls === "l" ? "l" : ""} ${cls === "strong" && x.cheapest ? "best" : ""} ${!ok(x) && cls === "strong" ? "amber" : ""}">${fn(x)}</td>`).join("")}</tr>`).join("");

    // Bars per tier
    const tiers = r.tiers.map(t => t.name);
    const max = Math.max(1e-12, ...list.filter(ok).flatMap(x => x.tiers.map(t => t.cost_with_cache)));
    $("#compare-bars").innerHTML = `<div class="cmp-legend" style="grid-column:1 / -1">${list.map((x, i) => `<span>${dot(i)}${esc(x.model)}</span>`).join("")}</div>` +
      tiers.map((name, ti) => `
        <div class="lname">${esc(name)}</div>
        <div class="group">${list.map((x, i) => {
          const v = x.tiers[ti].cost_with_cache;
          return `<div class="row"><div><div class="bar" style="width:${ok(x) ? (v / max * 100).toFixed(2) : 0}%;background:${color(i)}"></div></div><div class="val">${ok(x) ? fmt.usd(v) : "not priced"}</div></div>`;
        }).join("")}</div>`).join("");

    // Tier table
    $("#compare-tiers thead tr").innerHTML = `<th class="l">User tier</th>` + list.map((x, i) => `<th>${dot(i)}${esc(x.model)}</th>`).join("");
    $("#compare-tiers tbody").innerHTML = tiers.map((name, ti) => {
      const vals = list.map(x => ok(x) ? x.tiers[ti].cost_with_cache : null);
      const best = Math.min(...vals.filter(v => v != null));
      return `<tr><td class="l">${esc(name)}</td>${vals.map(v => `<td class="${v === best ? "best" : ""}">${v == null ? "—" : fmt.usd(v)}</td>`).join("")}</tr>`;
    }).join("");
    $("#compare-tiers tfoot").innerHTML = `<tr><td class="l">Portfolio total / mo</td>${list.map(x => `<td class="${x.cheapest ? "best" : ""}">${ok(x) ? fmt.usd(x.portfolio.cost_with_cache) : "—"}</td>`).join("")}</tr>`;

    // Cache sensitivity table
    $("#compare-cache thead tr").innerHTML = `<th>Cache-read share</th>` + list.map((x, i) => `<th>${dot(i)}${esc(x.model)}</th>`).join("");
    const shares = (list[0].cache_scenarios || []).map(s => s.cache_read_share);
    $("#compare-cache tbody").innerHTML = shares.map((sh, si) => `
      <tr class="${Math.abs(sh - r.scenario.assumptions.cache_read_share) < 1e-9 ? "is-selected" : ""}">
        <td>${fmt.pct(sh, 0)}</td>
        ${list.map(x => { const c = x.cache_scenarios[si]; return `<td>${c.status === "OK" ? `${fmt.usd(c.portfolio_month)} <span class="dim">(${fmt.pct(c.savings_pct, 0)})</span>` : "—"}</td>`; }).join("")}
      </tr>`).join("");
  }

  function renderChecks(r) {
    $("#checks").innerHTML = r.checks.map(c => `
      <li class="${c.status === "PASS" ? "" : "fail"}">
        <span>${esc(c.check)}<small>${esc(c.meaning)}</small></span><span>${c.status}</span>
      </li>`).join("");
  }

  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const round = v => Math.round(v * 1000) / 1000;

  // ------------------------------------------------------------ boot
  function loadDefaults() {
    state.scenario = defaultScenario();
    state.models = MODEL_NAMES.map(m => ({
      name: m, provider: RATE_CARD[m].provider,
      separate_write_tariff: RATE_CARD[m].separate_write_tariff,
      one_hour_write_listed: RATE_CARD[m].one_hour_write_listed,
      regional_uplift_eligible: !!RATE_CARD[m].regional_uplift_eligible,
      context_note: RATE_CARD[m].context_note,
    }));
    state.rateSnapshot = RATE_SNAPSHOT_DATE;
    $("#rate-footnote").textContent = `Rates: ${RATE_SOURCE}, snapshot ${RATE_SNAPSHOT_DATE}. Validate current prices, contract terms and endpoint support before quoting.`;
    syncRail();
  }

  try {
    loadDefaults();
    bindRail();
    syncRail();
    recalc();
  } catch (e) {
    showBanner(`Could not start the calculator: ${e.message}`, true);
  }
})();
