/* Client-side exports. Libraries are loaded from cdnjs in index.html:
   - SheetJS (XLSX) for the workbook
   - jsPDF + jsPDF-AutoTable for the PDF
   Both are value snapshots of the result shown on screen. */

(() => {
  "use strict";

  const now = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const ok = x => x.estimate_status === "OK";
  const pct = v => v == null ? "" : (v * 100).toFixed(1) + "%";
  const usd = (v, d = 6) => v == null ? "" : "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const int = v => v == null ? "" : Math.round(v).toLocaleString("en-US");
  const n1 = v => v == null ? "" : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const n4 = v => v == null ? "" : v.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  function assumptionRows(r) {
    const a = r.scenario.assumptions, p = r.pricing;
    return [
      ["Model", a.model], ["Provider", p.provider], ["Context pricing band", a.context_band],
      ["USD per DBU", a.usd_per_dbu], ["Regional processing uplift", a.regional_uplift ? "Yes" : "No"],
      ["Regional uplift rate", a.regional_uplift_rate], ["Effective USD / DBU", p.effective_usd_per_dbu],
      ["Token units in source table", a.token_units], ["Token-unit multiplier", r.token_unit_multiplier],
      ["Additional input tokens per query", a.extra_input_tokens_per_query],
      ["Cache screening threshold (tokens)", a.cache_threshold_tokens],
      ["Input tokens billed as cache reads", a.cache_read_share],
      ["Cache writes: % of non-read input (Claude)", a.write_share_non_read],
      ["Claude cache-write duration", a.write_duration], ["Billing months per year", a.billing_months],
      ["Input USD / 1M tokens", p.input_usd], ["Output USD / 1M tokens", p.output_usd],
      ["Cache read USD / 1M tokens", p.cache_read_usd], ["Cache write USD / 1M tokens", p.cache_write_usd],
      ["Blended input USD / 1M tokens", p.blended_input_usd],
      ["Ordinary / read / write share of input", `${pct(p.ordinary_share)} / ${pct(p.read_share)} / ${pct(p.write_share_all)}`],
      ["Rate-card status", p.rate_card_status], ["Estimate status", r.estimate_status], ["Integrity status", r.integrity_status],
    ];
  }

  function fileStem(r) {
    const m = r.scenario.assumptions.model.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-|-$/g, "");
    const d = new Date(), pad = x => String(x).padStart(2, "0");
    return `FMAPI-pricing-${m}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  }

  function saveBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ Excel
  function buildXlsx(r) {
    if (typeof XLSX === "undefined") throw new Error("The spreadsheet library did not load. Check your network and try again.");
    const a = r.scenario.assumptions, p = r.pricing, port = r.portfolio;
    const wb = XLSX.utils.book_new();
    const sheet = (name, aoa, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws["!cols"] = widths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    sheet("Dashboard", [
      ["FMAPI serving cost estimate"],
      [`${a.model} • ${a.context_band} context • Standard Pay Per Token • USD • exported ${now()}`],
      [],
      ["Scenario", "Value", "", "Portfolio metric", "Value"],
      ["Selected model", a.model, "", "Clients entered", port.clients],
      ["Context band", a.context_band, "", "Queries / month", port.queries],
      ["Cached input share", a.cache_read_share, "", "Monthly cost USD", r.not_priced ? "NOT PRICED" : port.cost_with_cache],
      ["Claude write share of non-reads", p.write_share_non_read_effective, "", "Annual cost USD", r.not_priced ? "" : port.cost_year],
      ["Effective USD / DBU", p.effective_usd_per_dbu, "", "No-cache monthly USD", port.cost_no_cache],
      ["Input USD / 1M", p.input_usd, "", "Monthly savings USD", r.not_priced ? "" : port.savings],
      ["Output USD / 1M", p.output_usd, "", "Total savings %", r.not_priced ? "" : port.savings_pct],
      ["Cache read USD / 1M", p.cache_read_usd, "", "Estimate status", r.estimate_status],
      ["Cache write USD / 1M", p.cache_write_usd, "", "Integrity status", r.integrity_status],
      [],
      ["User tier", "Queries / client / month", "Clients", "No-cache USD/mo", "With-cache USD/mo", "Savings USD/mo", "With-cache USD/year", "Portfolio USD/mo"],
      ...r.tiers.map(t => [t.name, t.queries, t.clients, t.cost_no_cache, t.cost_with_cache, t.savings, t.cost_year, t.portfolio_month]),
      ["Portfolio total", port.queries, port.clients, port.cost_no_cache, port.cost_with_cache, port.savings, port.cost_year, port.cost_with_cache],
      [],
      ["Per-client columns are for ONE client in the tier; Portfolio multiplies by the entered client count."],
      ["Caching percentages model billing only; they do not enable endpoint caching. Serving cost only — excludes app compute, storage, network, taxes and margin."],
      [`Rates: ${RATE_SOURCE}, snapshot ${RATE_SNAPSHOT_DATE}. Validate current prices, contract and endpoint support before quoting.`],
    ], [30, 20, 4, 26, 18, 16, 18, 18]);

    sheet("Assumptions", [["Assumption", "Value"], ...assumptionRows(r)], [44, 24]);

    sheet("Usage", [
      [`Source units: ${a.token_units} (multiplier ×${r.token_unit_multiplier}). Actual columns are tokens after conversion.`],
      ["Complexity", "Input / query (source units)", "Output / query (source units)", "Actual input / query", "Actual output / query", "Total tokens / query", "No-cache USD / query", "With-cache USD / query", "Savings USD / query", "Cache planning check"],
      ...r.complexities.map(c => [c.name, c.input, c.output, c.actual_input, c.actual_output, c.total_tokens, c.usd_no_cache, c.usd_with_cache, c.savings, c.cache_check]),
      [],
      ["User tier", "Queries / client / month", "Simple %", "Medium %", "Complex %", "Mix total", "Mix check", "Simple queries", "Medium queries", "Complex queries", "Clients in tier", "Portfolio queries / month"],
      ...r.tiers.map(t => [t.name, t.queries, t.simple, t.medium, t.complex, t.mix_total, t.mix_ok ? "OK" : "CHECK", t.simple_queries, t.medium_queries, t.complex_queries, t.clients, t.portfolio_queries]),
    ], [16, 16, 16, 14, 14, 14, 16, 16, 16, 34]);

    const tkeys = ["name", "queries", "input_tokens", "output_tokens", "total_tokens", "avg_tokens_per_query", "ordinary_input_tokens", "cache_read_tokens", "cache_write_tokens", "ordinary_input_usd", "cache_read_usd", "cache_write_usd", "output_usd", "cost_with_cache", "cost_no_cache", "savings", "savings_pct", "cost_year", "clients", "portfolio_month", "portfolio_year", "dbu_per_client_month"];
    sheet("Tier Pricing", [
      ["User tier", "Queries / month", "Input tokens / month", "Output tokens / month", "Total tokens / month", "Avg tokens / query", "Ordinary input tokens", "Cache-read input tokens", "Cache-write input tokens", "Ordinary input USD/mo", "Cache-read USD/mo", "Cache-write USD/mo", "Output USD/mo", "Cost USD/mo with cache", "Cost USD/mo no cache", "Savings USD/mo", "Savings %", "Cost USD/year", "Clients", "Portfolio USD/mo", "Portfolio USD/year", "DBU / client / month"],
      ...r.tiers.map(t => tkeys.map(k => t[k])),
      ["Portfolio total", port.queries, port.input_tokens, port.output_tokens, port.total_tokens, port.avg_tokens_per_query, port.ordinary_input_tokens, port.cache_read_tokens, port.cache_write_tokens, port.ordinary_input_usd, port.cache_read_usd, port.cache_write_usd, port.output_usd, port.cost_with_cache, port.cost_no_cache, port.savings, port.savings_pct, port.cost_year, port.clients, port.cost_with_cache, port.cost_year, port.dbu_month],
      [],
      ["Cost = ordinary input × input rate + cache-read input × read rate + cache-write input × write rate + output × output rate; token components ÷ 1,000,000."],
    ], [16, ...Array(21).fill(15)]);

    sheet("Model Comparison", [
      ["Model", "Provider", "Input USD/M", "Output USD/M", "Cache read USD/M", "Cache write USD/M", "Portfolio USD/mo no cache", "Portfolio USD/mo with cache", "Savings USD/mo", "Savings %", "Portfolio USD/year", "Effective USD/DBU", "Estimate status", "Selected"],
      ...r.comparison.map(c => [c.model, c.provider, c.input_usd, c.output_usd, c.cache_read_usd, c.cache_write_usd, c.portfolio_no_cache_month, c.portfolio_with_cache_month, c.savings_month, c.savings_pct, c.portfolio_year, c.effective_usd_per_dbu, c.estimate_status, c.selected ? "SELECTED" : ""]),
      [],
      ["Negative savings are valid: cache writes can cost more than ordinary input with little reuse. GPT rows ignore the Claude write allocation."],
    ], [20, 11, 13, 13, 14, 14, 18, 18, 14, 10, 16, 13, 14, 10]);

    const sbs = r.side_by_side || [];
    if (sbs.length) {
      const names = sbs.map(x => x.model);
      sheet("Compare", [
        ["Compare models — same workload side by side"],
        ["Metric", ...names],
        ["Provider", ...sbs.map(x => x.provider)],
        ["Input USD / 1M", ...sbs.map(x => x.pricing.input_usd)],
        ["Output USD / 1M", ...sbs.map(x => x.pricing.output_usd)],
        ["Cache read USD / 1M", ...sbs.map(x => x.pricing.cache_read_usd)],
        ["Cache write USD / 1M", ...sbs.map(x => x.pricing.separate_write_tariff ? x.pricing.cache_write_usd : "")],
        ["Portfolio USD/mo with cache", ...sbs.map(x => ok(x) ? x.portfolio.cost_with_cache : "NOT PRICED")],
        ["Portfolio USD/mo no cache", ...sbs.map(x => x.portfolio.cost_no_cache)],
        ["Savings USD/mo", ...sbs.map(x => ok(x) ? x.portfolio.savings : "")],
        ["Savings %", ...sbs.map(x => ok(x) ? x.portfolio.savings_pct : "")],
        ["Portfolio USD/year", ...sbs.map(x => ok(x) ? x.portfolio.cost_year : "")],
        ["DBU / month", ...sbs.map(x => x.portfolio.dbu_month)],
        ["Cost vs cheapest (×)", ...sbs.map(x => x.vs_cheapest_ratio ?? "")],
        [],
        ["Cost USD / client / month by tier", ...names],
        ...sbs[0].tiers.map((t, i) => [t.name, ...sbs.map(x => ok(x) ? x.tiers[i].cost_with_cache : "")]),
        ["Portfolio total / month", ...sbs.map(x => ok(x) ? x.portfolio.cost_with_cache : "")],
        [],
        ["Portfolio USD/mo by cache-read share", ...names],
        ...sbs[0].cache_scenarios.map((c, i) => [c.cache_read_share, ...sbs.map(x => x.cache_scenarios[i].status === "OK" ? x.cache_scenarios[i].portfolio_month : "")]),
        [],
        ["Blank cells mean the scenario is NOT PRICED for that model (a required cache-write rate is not listed). Never read a blank as free."],
      ], [30, ...names.map(() => 20)]);
    }

    sheet("Cache Scenarios", [
      ["Cache-read share of input", "Portfolio USD/mo", "Portfolio USD/year", "Monthly savings USD", "Total savings %", "Blended input USD/M", "Output USD/mo (unchanged)", "Cache-write USD/mo", "Cache-write share of all input", "Scenario status"],
      ...r.cache_scenarios.map(s => [s.cache_read_share, s.portfolio_month, s.portfolio_year, s.savings_month, s.savings_pct, s.blended_input_usd, s.output_usd_month, s.cache_write_usd_month, s.cache_write_share_all, s.status]),
    ], [22, 16, 16, 18, 14, 18, 20, 16, 22, 14]);

    sheet("Model Rates", [
      [`Published pricing snapshot ${RATE_SNAPSHOT_DATE}, not a live price feed. Blank write cells mean no separate price is listed, NOT a free cache write.`],
      ["Model", "Provider", "Short input", "Short output", "Short cache read", "Long input", "Long output", "Long cache read", "Short cache write", "Short write (1hr)", "Long cache write", "Long write (1hr)", "Regional uplift eligible", "Context note"],
      ...MODEL_NAMES.map(m => { const rc = RATE_CARD[m]; return [m, rc.provider, rc.short_in, rc.short_out, rc.short_read, rc.long_in, rc.long_out, rc.long_read, rc.short_write ?? "", rc.short_write_1hr ?? "", rc.long_write ?? "", rc.long_write_1hr ?? "", rc.regional_uplift_eligible ? "Yes" : "No", rc.context_note]; }),
    ], [20, 11, 12, 12, 14, 12, 12, 14, 15, 15, 15, 15, 14, 36]);

    sheet("Checks", [["Check", "Status", "Meaning"], ...r.checks.map(c => [c.check, c.status, c.meaning])], [40, 10, 60]);

    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fileStem(r) + ".xlsx");
  }

  // ------------------------------------------------------------------ PDF
  function buildPdf(r) {
    const J = window.jspdf && window.jspdf.jsPDF;
    if (!J) throw new Error("The PDF library did not load. Check your network and try again.");
    const a = r.scenario.assumptions, p = r.pricing, port = r.portfolio;
    const doc = new J({ orientation: "landscape", unit: "mm", format: "a4" });
    if (typeof doc.autoTable !== "function") throw new Error("The PDF table plugin did not load. Check your network and try again.");
    const W = doc.internal.pageSize.getWidth(), M = 14;
    const ink = [28, 36, 48], teal = [14, 110, 110], tint = [238, 243, 243], amber = [184, 116, 26], grey = [91, 102, 117];
    const tableStyle = { styles: { font: "helvetica", fontSize: 7.5, cellPadding: 1.4, textColor: ink, lineColor: [213, 220, 227], lineWidth: 0.2 },
                         headStyles: { fillColor: ink, textColor: 255, fontStyle: "bold", halign: "center" },
                         bodyStyles: {}, alternateRowStyles: {}, margin: { left: M, right: M }, theme: "grid" };
    let y = M;

    const h2 = (text) => { doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...ink); doc.text(text, M, y); y += 5; };
    const small = (text) => { doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...grey); const lines = doc.splitTextToSize(text, W - 2 * M); doc.text(lines, M, y); y += lines.length * 3.4 + 1.5; };
    const table = (head, body, opts = {}) => {
      doc.autoTable({ ...tableStyle, ...opts, head: [head], body, startY: y,
                      columnStyles: Object.assign({ 0: { halign: "left" } }, ...head.slice(1).map((_, i) => ({ [i + 1]: { halign: "right" } })), opts.columnStyles || {}) });
      y = doc.lastAutoTable.finalY + 6;
    };

    // Page 1
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(...ink); doc.text("FMAPI serving cost estimate", M, y + 4); y += 10;
    small(`${a.model} (${p.provider}) • ${a.context_band} context band • Standard Pay Per Token • exported ${now()}`);
    y += 2;
    const headline = [
      ["Clients entered", int(port.clients), "Monthly cost (with cache)", r.not_priced ? "NOT PRICED" : usd(port.cost_with_cache)],
      ["Queries / month", int(port.queries), "Annual cost", r.not_priced ? "—" : usd(port.cost_year)],
      ["Total tokens / month", int(port.total_tokens), "No-cache monthly cost", usd(port.cost_no_cache)],
      ["Cached input share", pct(a.cache_read_share), "Monthly savings", r.not_priced ? "—" : `${usd(port.savings)} (${pct(port.savings_pct)})`],
      ["Estimate status", r.estimate_status, "Integrity status", r.integrity_status],
    ];
    doc.autoTable({ ...tableStyle, theme: "plain", body: headline, startY: y, styles: { ...tableStyle.styles, fontSize: 8.5 },
                    columnStyles: { 1: { halign: "right", fontStyle: "bold" }, 3: { halign: "right", fontStyle: "bold" } },
                    didParseCell: c => { if (r.not_priced && c.row.index === 0 && c.column.index === 3) c.cell.styles.textColor = amber; } });
    y = doc.lastAutoTable.finalY + 6;
    if (r.not_priced) small("NOT PRICED — a cache-write price required by this scenario is not listed in the rate snapshot. Totals are suppressed. Choose the Default write duration, set the write allocation to 0%, or obtain a verified tariff.");

    h2("Cost by user tier");
    const tierBody = r.tiers.map(t => [t.name, int(t.queries), int(t.clients), usd(t.cost_no_cache), usd(t.cost_with_cache), usd(t.savings), pct(t.savings_pct), usd(t.cost_year), usd(t.portfolio_month), usd(t.portfolio_year)]);
    tierBody.push(["Portfolio total", int(port.queries), int(port.clients), usd(port.cost_no_cache), usd(port.cost_with_cache), usd(port.savings), pct(port.savings_pct), usd(port.cost_year), usd(port.cost_with_cache), usd(port.cost_year)]);
    table(["User tier", "Queries / client / mo", "Clients", "No-cache USD/mo", "With-cache USD/mo", "Savings USD/mo", "Savings %", "USD / client / year", "Portfolio USD/mo", "Portfolio USD/year"], tierBody,
          { didParseCell: c => { if (c.section === "body" && c.row.index === tierBody.length - 1) { c.cell.styles.fillColor = tint; c.cell.styles.fontStyle = "bold"; } } });
    small("Per-client columns show one client in the tier; portfolio columns multiply by the client count. Serving cost only — excludes app compute, storage, network, taxes, tool/search fees and commercial margin.");

    // Page 2 — assumptions + usage
    doc.addPage(); y = M;
    h2("Assumptions");
    const ar = assumptionRows(r).map(([k, v]) => [k, typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 && !String(k).includes("USD") ? pct(v) : String(k).includes("USD /") || String(k).includes("USD per") ? n4(v) : v.toLocaleString("en-US", { maximumFractionDigits: 6 })) : String(v)]);
    const half = Math.ceil(ar.length / 2);
    const merged = ar.slice(0, half).map((row, i) => [...row, ...(ar[half + i] || ["", ""])]);
    doc.autoTable({ ...tableStyle, theme: "plain", body: merged, startY: y, columnStyles: { 1: { halign: "right" }, 3: { halign: "right" } } });
    y = doc.lastAutoTable.finalY + 6;
    h2("Complexity profiles (actual tokens per query)");
    table(["Complexity", "Input (source units)", "Output (source units)", "Actual input", "Actual output", "Total tokens", "No-cache USD / query", "With-cache USD / query", "Cache planning check"],
          r.complexities.map(c => [c.name, n1(c.input), n1(c.output), n1(c.actual_input), n1(c.actual_output), n1(c.total_tokens), usd(c.usd_no_cache, 8), usd(c.usd_with_cache, 8), c.cache_check]),
          { columnStyles: { 8: { halign: "left" } } });
    h2("User tiers — workload mix");
    table(["User tier", "Queries / client / mo", "Simple %", "Medium %", "Complex %", "Mix check", "Simple queries", "Medium queries", "Complex queries", "Clients", "Portfolio queries / mo"],
          r.tiers.map(t => [t.name, int(t.queries), pct(t.simple), pct(t.medium), pct(t.complex), t.mix_ok ? "OK" : "CHECK", n1(t.simple_queries), n1(t.medium_queries), n1(t.complex_queries), int(t.clients), int(t.portfolio_queries)]));

    // Compare page
    const sbs = r.side_by_side || [];
    if (sbs.length) {
      doc.addPage(); y = M;
      h2("Compare models — same workload side by side");
      small("User-chosen models priced on the identical workload, context band, DBU price and caching assumptions. The cheapest priced model is highlighted.");
      const names = sbs.map(x => x.model);
      const best = sbs.findIndex(x => x.cheapest);
      const hl = c => { if (c.section === "body" && best >= 0 && c.column.index === best + 1) c.cell.styles.fillColor = tint; };
      table(["Metric", ...names], [
        ["Provider", ...sbs.map(x => x.provider)],
        ["Input / output / cache read USD per 1M", ...sbs.map(x => `${usd(x.pricing.input_usd, 2)} / ${usd(x.pricing.output_usd, 2)} / ${usd(x.pricing.cache_read_usd, 2)}`)],
        ["Portfolio / mo, with cache", ...sbs.map(x => ok(x) ? usd(x.portfolio.cost_with_cache) : "NOT PRICED")],
        ["Portfolio / mo, no cache", ...sbs.map(x => usd(x.portfolio.cost_no_cache))],
        ["Savings from caching", ...sbs.map(x => ok(x) ? `${usd(x.portfolio.savings)} (${pct(x.portfolio.savings_pct)})` : "—")],
        ["Portfolio / yr", ...sbs.map(x => ok(x) ? usd(x.portfolio.cost_year) : "—")],
        ["Cost vs cheapest", ...sbs.map(x => x.cheapest ? "cheapest" : x.vs_cheapest_ratio ? x.vs_cheapest_ratio.toFixed(2) + "×" : "—")],
      ], { didParseCell: hl });
      h2("Cost per client per month by tier");
      const tb = sbs[0].tiers.map((t, i) => [t.name, ...sbs.map(x => ok(x) ? usd(x.tiers[i].cost_with_cache) : "—")]);
      tb.push(["Portfolio total / month", ...sbs.map(x => ok(x) ? usd(x.portfolio.cost_with_cache) : "—")]);
      table(["User tier", ...names], tb, { didParseCell: c => { hl(c); if (c.section === "body" && c.row.index === tb.length - 1) c.cell.styles.fontStyle = "bold"; } });
      h2("Portfolio cost per month by cache-read share");
      table(["Cache-read share", ...names], sbs[0].cache_scenarios.map((c, i) => [pct(c.cache_read_share), ...sbs.map(x => x.cache_scenarios[i].status === "OK" ? usd(x.cache_scenarios[i].portfolio_month) : "—")]), { didParseCell: hl });
    }

    // Model comparison + cache scenarios
    doc.addPage(); y = M;
    h2("Model comparison — same workload, different model");
    small("Identical workload, context band, DBU price and cache shares for each model. Write share applies only to models with a separately priced cache write. Negative savings are valid.");
    table(["Model", "Provider", "Input USD/M", "Output USD/M", "Cache read USD/M", "Cache write USD/M", "Portfolio USD/mo no cache", "Portfolio USD/mo with cache", "Savings %", "Portfolio USD/year", "Status"],
          r.comparison.map(c => [c.model + (c.selected ? " (selected)" : ""), c.provider, usd(c.input_usd, 2), usd(c.output_usd, 2), usd(c.cache_read_usd, 2), usd(c.cache_write_usd, 2), usd(c.portfolio_no_cache_month), ok(c) ? usd(c.portfolio_with_cache_month) : "—", ok(c) ? pct(c.savings_pct) : "—", ok(c) ? usd(c.portfolio_year) : "—", c.estimate_status]),
          { columnStyles: { 1: { halign: "left" }, 10: { halign: "left" } },
            didParseCell: c => { if (c.section !== "body") return; const row = r.comparison[c.row.index]; if (row.selected) { c.cell.styles.fillColor = tint; c.cell.styles.fontStyle = "bold"; } if (!ok(row) && c.column.index === 10) c.cell.styles.textColor = amber; } });
    if (y > 150) { doc.addPage(); y = M; }
    h2("Cache sensitivity — savings are scenarios, not promises");
    table(["Cache-read share", "Portfolio USD/mo", "Portfolio USD/year", "Monthly savings", "Savings %", "Blended input USD/M", "Output USD/mo", "Cache-write USD/mo", "Write share of all input", "Status"],
          r.cache_scenarios.map(s => [pct(s.cache_read_share), usd(s.portfolio_month), usd(s.portfolio_year), usd(s.savings_month), pct(s.savings_pct), usd(s.blended_input_usd, 4), usd(s.output_usd_month), usd(s.cache_write_usd_month), pct(s.cache_write_share_all), s.status]),
          { columnStyles: { 0: { halign: "right" }, 9: { halign: "left" } } });
    small(`Rates: ${RATE_SOURCE}, snapshot ${RATE_SNAPSHOT_DATE}. Caching percentages model billing only and do not enable or guarantee endpoint caching. Validate current prices, contract terms and endpoint support before quoting.`);

    // footer
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...grey);
      doc.text(`FMAPI pricing estimate — ${a.model} — generated ${now()}`, M, doc.internal.pageSize.getHeight() - 8);
      doc.text(`Page ${i}`, W - M, doc.internal.pageSize.getHeight() - 8, { align: "right" });
    }
    doc.save(fileStem(r) + ".pdf");
  }

  window.FMAPI_EXPORT = { buildXlsx, buildPdf };
})();
