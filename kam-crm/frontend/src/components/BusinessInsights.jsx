import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, scopeQuery } from "../api.js";
import EChart from "./EChart.jsx";

const int = (v) => Number(v ?? 0).toLocaleString("en-US");
const money = (v) => `৳${Math.round(Number(v ?? 0)).toLocaleString("en-US")}`;
const pct = (n, d) => (Number(d) ? (Number(n) / Number(d)) * 100 : 0);
const pctText = (v) => `${(Number.isFinite(v) ? v : 0).toFixed(1)}%`;

/* ---- bracket helpers, ported from the Apps Script dashboard ----
   Nothing is hardcoded: the label list arrives from the API, and the colours,
   the ≤3 / 4–6 / 6+ split and the KPI steps are all derived from it. So a
   vocabulary change (7+ becoming 10+, an extra bucket) follows automatically. */
function parseBracket(label) {
  const s = String(label).trim();
  return { v: parseInt(s, 10), plus: s.includes("+"), unknown: !/^\d/.test(s) };
}
function bracketLabel(label) {
  const p = parseBracket(label);
  if (p.unknown) return String(label);
  return `${label}${p.v === 1 && !p.plus ? " Day" : " Days"}`;
}
const RAMP = [
  [34, 197, 138], [126, 217, 87], [196, 229, 81], [255, 204, 0],
  [245, 166, 35], [249, 115, 22], [255, 92, 92], [192, 57, 43],
];
function bracketColors(labels) {
  const n = labels.length;
  return labels.map((label, i) => {
    if (parseBracket(label).unknown) return "#6B7280";
    const t = n <= 1 ? 0 : (i / (n - 1)) * (RAMP.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, RAMP.length - 1);
    const f = t - lo;
    const c = [0, 1, 2].map((k) => Math.round(RAMP[lo][k] + (RAMP[hi][k] - RAMP[lo][k]) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });
}
function bracketGroups(labels) {
  const g = { le3: [], mid: [], six: [], known: [] };
  labels.forEach((label, i) => {
    const p = parseBracket(label);
    if (p.unknown) return;
    g.known.push(i);
    if (p.v > 6) g.six.push(i);
    else if (p.v >= 4) g.mid.push(i);
    else g.le3.push(i);
  });
  return g;
}
/** Terminal cards read cumulatively; in-process cards read each bracket alone. */
function agingSteps(dist, labels) {
  const g = bracketGroups(labels);
  const total = g.known.reduce((sum, i) => sum + (dist[i] || 0), 0);
  const steps = [];
  let running = 0;
  g.le3.concat(g.mid).forEach((i) => {
    const own = dist[i] || 0;
    running += own;
    steps.push({
      key: labels[i], own, cum: running,
      pct: total ? (running / total) * 100 : 0,
      ownPct: total ? (own / total) * 100 : 0,
    });
  });
  if (g.six.length) {
    const own = g.six.reduce((sum, i) => sum + (dist[i] || 0), 0);
    running += own;
    steps.push({
      key: "6+", own, cum: running,
      pct: total ? (running / total) * 100 : 0,
      ownPct: total ? (own / total) * 100 : 0,
    });
  }
  return { total, steps };
}

function AgingKpis({ label, dist, labels, mode }) {
  const { total, steps } = agingSteps(dist, labels);
  const isTerminal = mode !== "ip";
  return (
    <div className="kpi-grid kpi-dense">
      <div className="kpi">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{int(total)}</div>
      </div>
      {steps.map((step) => (
        <div className="kpi" key={step.key}>
          <div
            className="kpi-label"
            title={isTerminal
              ? `Cumulative through ${step.key} — ${int(step.cum)} of ${int(total)}; this bracket alone ${int(step.own)}`
              : `This bracket only — ${int(step.own)} of ${int(total)}`}
          >
            {isTerminal
              ? `Terminal within ${step.key} ${step.key === "1" ? "Day" : "Days"}`
              : `${bracketLabel(step.key)} Aging`}
          </div>
          <div className="kpi-value">
            {pctText(isTerminal ? step.pct : step.ownPct)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- stacked aging-mix chart ---- */
function mixOption(mix, labels, mode) {
  const colors = bracketColors(labels);
  const keys = mix.map((row) => row.period);
  const series = labels.map((label, i) => ({
    name: bracketLabel(label),
    type: "bar",
    stack: "m",
    itemStyle: { color: colors[i] },
    data: mix.map((row) => {
      const total = row.values.reduce((s, v) => s + v, 0);
      return mode === "pct"
        ? Number((total ? (row.values[i] / total) * 100 : 0).toFixed(1))
        : row.values[i];
    }),
  }));
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 10 } },
    grid: { left: 50, right: 16, top: 30, bottom: 28 },
    xAxis: { type: "category", data: keys, axisLabel: { fontSize: 10 } },
    yAxis: {
      type: "value", min: 0, max: mode === "pct" ? 100 : null,
      axisLabel: { fontSize: 10, formatter: mode === "pct" ? "{value}%" : undefined },
    },
    series,
  };
}

/* ---- aging breakdown table with the spine bar ---- */
function AgingTable({ table, labels, unit }) {
  const g = bracketGroups(labels);
  const colors = bracketColors(labels);
  const rows = table.map((row) => {
    const total = g.known.reduce((sum, i) => sum + (row.values[i] || 0), 0);
    const share = (list) => (total ? (list.reduce((s, i) => s + (row.values[i] || 0), 0) / total) * 100 : 0);
    return {
      name: row.name,
      total,
      le3: share(g.le3),
      mid: share(g.mid),
      six: share(g.six),
      sixCount: g.six.reduce((s, i) => s + (row.values[i] || 0), 0),
      spine: row.values.map((v) => (total ? (v / total) * 100 : 0)),
    };
  });
  return (
    <div className="table-wrap" style={{ maxHeight: "46vh" }}>
      <table>
        <thead>
          <tr>
            <th className="sticky-col">Name</th>
            <th>{unit}</th>
            <th>≤3d %</th>
            <th>4–6d %</th>
            <th>6+ Share</th>
            <th style={{ width: "26%" }}>Aging Spine</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="sticky-col">{row.name}</td>
              <td>{int(row.total)}</td>
              <td>{pctText(row.le3)}</td>
              <td>{pctText(row.mid)}</td>
              <td className={row.six > 10 ? "neg" : ""}>
                {pctText(row.six)} ({int(row.sixCount)})
              </td>
              <td>
                <span className="spine">
                  {row.spine.map((width, i) => (
                    <span key={i} style={{ width: `${width}%`, background: colors[i] }}
                          title={`${bracketLabel(labels[i])}: ${pctText(width)}`} />
                  ))}
                </span>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={6} className="empty">Nothing in this selection.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- overview --- */
function Overview({ query }) {
  const [data, setData] = useState(null);
  const [statusFeed, setStatusFeed] = useState("fid");
  const [status, setStatus] = useState([]);

  useEffect(() => {
    api(`/api/insights/overview?${query}`).then(setData).catch(() => setData(null));
  }, [query]);
  useEffect(() => {
    api(`/api/insights/status?${query}&feed=${statusFeed}`)
      .then((body) => setStatus(body.rows))
      .catch(() => setStatus([]));
  }, [query, statusFeed]);

  if (!data || !data.kpis) return <div className="empty">Pick a date range.</div>;
  const k = data.kpis;
  const statusTotal = status.reduce((s, row) => s + Number(row.value), 0);

  return (
    <>
      <div className="kpi-grid">
        <div className="kpi"><div className="kpi-label">Processed</div><div className="kpi-value">{int(k.processed)}</div></div>
        <div className="kpi"><div className="kpi-label">Delivered</div><div className="kpi-value">{int(k.delivered)}</div></div>
        <div className="kpi"><div className="kpi-label">Return</div><div className="kpi-value">{int(k.returned)}</div></div>
        <div className="kpi green"><div className="kpi-label">Success Rate</div><div className="kpi-value">{pctText(pct(k.delivered, k.processed))}</div><div className="kpi-hint">Delivered ÷ Processed</div></div>
        <div className="kpi red"><div className="kpi-label">Return Rate</div><div className="kpi-value">{pctText(pct(k.returned, k.processed))}</div></div>
        <div className="kpi"><div className="kpi-label">SLA Breach</div><div className="kpi-value">{pctText(pct(k.sla_breached, k.processed))}</div><div className="kpi-hint">{int(k.sla_breached)} breached</div></div>
        <div className="kpi"><div className="kpi-label">Revenue</div><div className="kpi-value">{money(k.revenue)}</div></div>
        <div className="kpi"><div className="kpi-label">GMV</div><div className="kpi-value">{money(k.gmv)}</div><div className="kpi-hint">Collected Amount</div></div>
      </div>

      <div className="panel">
        <h2>Volume</h2>
        <p className="sub">Delivered · Return · Lost &amp; Damage · In Process — sorted-date cohort.</p>
        <EChart
          height={320}
          option={{
            backgroundColor: "transparent",
            tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
            legend: { top: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 10 } },
            grid: { left: 52, right: 16, top: 30, bottom: 28 },
            xAxis: { type: "category", data: data.trend.map((r) => r.d), axisLabel: { fontSize: 10 } },
            yAxis: { type: "value", axisLabel: { fontSize: 10 } },
            series: [
              { name: "Delivered", type: "bar", stack: "v", itemStyle: { color: "#22C58A" }, data: data.trend.map((r) => Number(r.delivered)) },
              { name: "Return", type: "bar", stack: "v", itemStyle: { color: "#EF4444" }, data: data.trend.map((r) => Number(r.returned)) },
              { name: "Lost & Damage", type: "bar", stack: "v", itemStyle: { color: "#B78CFF" }, data: data.trend.map((r) => Number(r.lost_damage)) },
              { name: "In Process", type: "bar", stack: "v", itemStyle: { color: "#6B7280" }, data: data.trend.map((r) => Number(r.in_process)) },
            ],
          }}
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>In-Process Parcels by Status</h2>
            <p className="sub">Snapshot dated by COALESCE(Sorted at, Created at).</p>
          </div>
          <div className="seg">
            {["fid", "reverse", "cr"].map((feed) => (
              <button key={feed} className={statusFeed === feed ? "on" : ""}
                      onClick={() => setStatusFeed(feed)}>
                {feed.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap" style={{ maxHeight: "36vh" }}>
          <table>
            <thead><tr><th className="sticky-col">System Status</th><th>Parcels</th><th>Share %</th></tr></thead>
            <tbody>
              {status.map((row) => (
                <tr key={row.name}>
                  <td className="sticky-col">{row.name}</td>
                  <td>{int(row.value)}</td>
                  <td>{pctText(pct(row.value, statusTotal))}</td>
                </tr>
              ))}
              {!status.length && <tr><td colSpan={3} className="empty">Nothing in this selection.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Merchant Health Matrix</h2>
        <div className="table-wrap" style={{ maxHeight: "50vh" }}>
          <table>
            <thead>
              <tr>
                <th className="sticky-col">Merchant</th>
                <th>Processed</th><th>Delivered</th><th>Return</th>
                <th>Success %</th><th>Return %</th><th>In Process %</th>
                <th>SLA Breach %</th><th>Avg Aging (d)</th><th>GMV</th><th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.merchants.map((m) => (
                <tr key={m.business_id}>
                  <td className="sticky-col">{m.business_name}</td>
                  <td>{int(m.processed)}</td>
                  <td>{int(m.delivered)}</td>
                  <td>{int(m.returned)}</td>
                  <td className={pct(m.delivered, m.processed) < 80 ? "neg" : "pos"}>
                    {pctText(pct(m.delivered, m.processed))}
                  </td>
                  <td>{pctText(pct(m.returned, m.processed))}</td>
                  <td>{pctText(pct(m.in_process, m.processed))}</td>
                  <td>{pctText(pct(m.sla_breached, m.processed))}</td>
                  <td>{Number(m.avg_aging ?? 0).toFixed(2)}</td>
                  <td>{money(m.gmv)}</td>
                  <td>{money(m.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------- aging view --- */
function AgingView({ query, feed, type, stage, unit, mode, groupable }) {
  const [data, setData] = useState(null);
  const [group, setGroup] = useState("biz");
  const [chartMode, setChartMode] = useState("count");

  const url = useMemo(() => {
    const parts = [query, `feed=${feed}`, `group=${group}`];
    if (type) parts.push(`type=${type}`);
    if (stage) parts.push(`stage=${stage}`);
    return `/api/insights/aging?${parts.join("&")}`;
  }, [query, feed, group, type, stage]);

  useEffect(() => {
    api(url).then(setData).catch(() => setData(null));
  }, [url]);

  if (!data) return <div className="empty">Pick a date range.</div>;
  const labels = data.brackets;

  return (
    <>
      <AgingKpis label={unit} dist={data.dist} labels={labels} mode={mode} />

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Aging Mix</h2>
            <p className="sub">{unit} by aging bracket, per day.</p>
          </div>
          <div className="seg">
            <button className={chartMode === "count" ? "on" : ""} onClick={() => setChartMode("count")}>Counts</button>
            <button className={chartMode === "pct" ? "on" : ""} onClick={() => setChartMode("pct")}>Share %</button>
          </div>
        </div>
        <EChart height={320} option={mixOption(data.mix, labels, chartMode)} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Breakdown</h2>
            <p className="sub">6+ means strictly more than six days.</p>
          </div>
          {groupable && (
            <div className="seg">
              {["region", "division", "biz"].map((g) => (
                <button key={g} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
                  {g === "biz" ? "Merchant" : g[0].toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
        <AgingTable table={data.table} labels={labels} unit={unit} />
      </div>
    </>
  );
}

/* -------------------------------------------------------------- the tab --- */
const SUB_TABS = [
  { id: "overview", label: "Merchant Overview" },
  { id: "forward", label: "Forward Aging" },
  { id: "reverse", label: "Reverse" },
  { id: "cr", label: "CR" },
];

export default function BusinessInsights({ scope }) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [sub, setSub] = useState("overview");
  const [view, setView] = useState("term"); // term | ip, for Forward and Reverse
  const [crStage, setCrStage] = useState("ip"); // pending | ip | term
  const [range, setRange] = useState({ from: "", to: "" });
  const [businessId, setBusinessId] = useState("");

  const scopeQs = scopeQuery(scope);

  useEffect(() => {
    api(`/api/insights/meta${scopeQs ? `?${scopeQs}` : ""}`)
      .then((body) => {
        setMeta(body);
        if (body.date_min && body.date_max) {
          setRange({ from: body.date_min, to: body.date_max });
        }
      })
      .catch((err) => setError(err.message));
  }, [scopeQs]);

  const query = useMemo(() => {
    const parts = [
      range.from ? `from=${range.from}` : "",
      range.to ? `to=${range.to}` : "",
      scopeQs,
      businessId ? `business_id=${businessId}` : "",
    ].filter(Boolean);
    return parts.join("&");
  }, [range, scopeQs, businessId]);

  const exportCsv = useCallback(
    (kind, type) => {
      const parts = [
        `kind=${kind}`,
        scopeQs,
        type ? `type=${type}` : "",
        businessId ? `business_id=${businessId}` : "",
      ].filter(Boolean);
      // The export needs the bearer token, so it is fetched and turned into a
      // blob rather than opened as a plain link.
      fetch(`${import.meta.env.VITE_API_URL || ""}/api/insights/export?${parts.join("&")}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      })
        .then((response) => response.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${kind}_in_process.csv`;
          document.body.appendChild(link);
          link.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
            link.remove();
          }, 400);
        })
        .catch(() => setError("Export failed."));
    },
    [scopeQs, businessId]
  );

  if (error) return <div className="panel error-text">{error}</div>;
  if (!meta) return <div className="panel empty">Loading Business Insights…</div>;
  if (!meta.date_max) {
    return (
      <div className="panel empty">
        No Business Insights data yet. Run{" "}
        <code>carrybee_business_insights.py</code> to build the 30-day window.
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Business Insights</h2>
            <p className="sub">
              Rolling window {meta.last_run?.window_start} → {meta.last_run?.window_end}{" "}
              · {int(meta.last_run?.merchants)} merchants · last refresh{" "}
              {meta.last_run?.finished_at
                ? String(meta.last_run.finished_at).replace("T", " ").slice(0, 16)
                : "—"}
              {meta.last_run?.status !== "ok" && (
                <b className="neg"> · last run {meta.last_run?.status}</b>
              )}
            </p>
          </div>
          <div className="seg">
            <button onClick={() => exportCsv("fid")}>⬇ FID CSV</button>
            <button onClick={() => exportCsv("rid", sub === "cr" ? "CR" : "Reverse")}>
              ⬇ {sub === "cr" ? "CR" : "RID"} CSV
            </button>
          </div>
        </div>

        <div className="toolbar">
          <label>From <input type="date" value={range.from} min={meta.date_min}
                             max={meta.date_max}
                             onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label>To <input type="date" value={range.to} min={meta.date_min}
                           max={meta.date_max}
                           onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <label>
            Merchant{" "}
            <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">All merchants</option>
              {meta.merchants.map((m) => (
                <option key={m.business_id} value={m.business_id}>{m.business_name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="seg">
          {SUB_TABS.map((item) => (
            <button key={item.id} className={sub === item.id ? "on" : ""}
                    onClick={() => setSub(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {sub === "overview" && <Overview query={query} />}

      {(sub === "forward" || sub === "reverse") && (
        <>
          <div className="panel" style={{ paddingBottom: 10 }}>
            <div className="seg">
              <button className={view === "term" ? "on" : ""} onClick={() => setView("term")}>Terminal</button>
              <button className={view === "ip" ? "on" : ""} onClick={() => setView("ip")}>In Process</button>
            </div>
          </div>
          {sub === "forward" ? (
            <AgingView
              query={query}
              feed={view === "term" ? "fwdT" : "fid"}
              unit={view === "term" ? "Terminal Parcels" : "In-Process Parcels"}
              mode={view === "term" ? "term" : "ip"}
              groupable={view === "term"}
            />
          ) : (
            <AgingView
              query={query}
              feed={view === "term" ? "revT" : "rid"}
              type="Reverse"
              unit={view === "term" ? "Terminal Reverse CIDs" : "In-Process Reverse CIDs"}
              mode={view === "term" ? "term" : "ip"}
              groupable={view === "term"}
            />
          )}
        </>
      )}

      {sub === "cr" && (
        <>
          <div className="panel" style={{ paddingBottom: 10 }}>
            <div className="seg">
              {[["pending", "Pending"], ["ip", "In Process"], ["term", "Terminal"]].map(
                ([id, label]) => (
                  <button key={id} className={crStage === id ? "on" : ""}
                          onClick={() => setCrStage(id)}>{label}</button>
                )
              )}
            </div>
            <p className="sub" style={{ marginBottom: 0 }}>
              Pending is the three awaiting-pickup statuses; In Process is every
              other status in RID In Process; Terminal comes from the reverse
              terminal feed with RID Type = CR.
            </p>
          </div>
          <AgingView
            query={query}
            feed={crStage === "term" ? "revT" : "rid"}
            type="CR"
            stage={crStage === "term" ? "" : crStage}
            unit={
              crStage === "pending" ? "Pending CR CIDs"
              : crStage === "ip" ? "In-Process CR CIDs"
              : "Terminal CR CIDs"
            }
            mode={crStage === "term" ? "term" : "ip"}
            groupable={crStage === "term"}
          />
        </>
      )}
    </>
  );
}
