import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

/**
 * Targets sheet: every KAM's targets for one month on one screen. The admin
 * types into the grid, or uploads an Excel/CSV file with the same column
 * names, then saves everything at once (PUT /api/targets/bulk).
 *
 * A blank cell inherits the lead / global value; a row left completely blank
 * removes that KAM's own target for the month.
 */
const COLUMNS = [
  { key: "target_revenue", label: "Target Revenue" },
  { key: "unlock_threshold_pct", label: "Unlock %" },
  { key: "incentive_pct", label: "Incentive %" },
  { key: "incremental_target_pct", label: "Incremental Target %" },
  { key: "retention_target_pct", label: "Retention Target %" },
];
const NAME_HEADER = "KAM Name";

const norm = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const cell = (value) => (value === null || value === undefined ? "" : String(Number(value)));

export default function TargetSheet({ month, onClose, onSaved }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  useEffect(() => {
    Promise.all([api("/api/filters"), api(`/api/targets?month=${month}`)])
      .then(([filters, targets]) => {
        const byKam = new Map(
          targets.rows
            .filter((row) => row.scope_type === "kam")
            .map((row) => [norm(row.scope_value), row])
        );
        setRows(
          filters.kams.map((kam) => {
            const saved = byKam.get(norm(kam.kam_name)) || {};
            return {
              kam_name: kam.kam_name,
              lead_name: kam.lead_name,
              ...Object.fromEntries(COLUMNS.map((c) => [c.key, cell(saved[c.key])])),
            };
          })
        );
      })
      .catch((err) => setError(err.message));
  }, [month]);

  const setValue = (index, key) => (event) => {
    const next = [...rows];
    next[index] = { ...next[index], [key]: event.target.value };
    setRows(next);
  };

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet([
      [NAME_HEADER, ...COLUMNS.map((c) => c.label)],
      ...rows.map((row) => [row.kam_name, ...COLUMNS.map((c) => row[c.key])]),
    ]);
    sheet["!cols"] = [{ wch: 30 }, ...COLUMNS.map(() => ({ wch: 20 }))];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Targets");
    XLSX.writeFile(book, `KAM_Targets_${month.slice(0, 7)}.xlsx`);
  }

  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setNotice("");
    try {
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer());
      const records = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
        defval: "",
        raw: false,
      });
      if (!records.length) throw new Error("The file has no rows.");

      // Match headers loosely: "kam name", "KAM Name ", "Target Revenue (৳)".
      const headerFor = (label) =>
        Object.keys(records[0]).find((h) => norm(h).replace(/\s*\(.*\)$/, "") === norm(label));
      const nameHeader = headerFor(NAME_HEADER);
      if (!nameHeader) throw new Error(`The first row must include a "${NAME_HEADER}" column.`);
      const found = COLUMNS.filter((c) => headerFor(c.label));
      if (!found.length) {
        throw new Error(`No target columns found. Use: ${COLUMNS.map((c) => c.label).join(", ")}.`);
      }

      const byName = new Map(records.map((r) => [norm(r[nameHeader]), r]));
      let matched = 0;
      const next = rows.map((row) => {
        const record = byName.get(norm(row.kam_name));
        if (!record) return row;
        matched += 1;
        const updated = { ...row };
        found.forEach((c) => {
          updated[c.key] = String(record[headerFor(c.label)] ?? "").replace(/[,%৳\s]/g, "");
        });
        return updated;
      });
      const known = new Set(rows.map((row) => norm(row.kam_name)));
      const unknown = records
        .map((r) => String(r[nameHeader] ?? "").trim())
        .filter((name) => name && !known.has(norm(name)));
      setRows(next);
      setNotice(
        `Loaded ${matched} KAM${matched === 1 ? "" : "s"} from ${file.name}. ` +
          (unknown.length
            ? `Not found in the KAM list (skipped): ${unknown.slice(0, 5).join(", ")}` +
              (unknown.length > 5 ? ` and ${unknown.length - 5} more` : "") + ". "
            : "") +
          "Check the sheet, then press Save all."
      );
    } catch (err) {
      setError(err.message || "Could not read that file.");
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = await api("/api/targets/bulk", {
        method: "PUT",
        body: JSON.stringify({ month, rows }),
      });
      onSaved();
      setNotice(`Saved targets for ${body.saved} KAMs${body.cleared ? `, cleared ${body.cleared}` : ""}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Targets sheet · {month}</h3>
        <div className="sub">
          Set every KAM's targets at once: type into the sheet, or upload an
          Excel file with the columns <b>{NAME_HEADER}</b>,{" "}
          {COLUMNS.map((c) => c.label).join(", ")}. A blank cell uses the lead
          or global target.
        </div>

        <div className="toolbar">
          <button className="btn" onClick={downloadTemplate} disabled={!rows}>
            Download sheet (.xlsx)
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={!rows}>
            Upload Excel
          </button>
          <input ref={fileInput} type="file" hidden onChange={upload}
                 accept=".xlsx,.xls,.csv" />
        </div>

        {notice && <div className="sub"><b>{notice}</b></div>}
        {error && <div className="error-text">{error}</div>}

        {!rows ? (
          <div className="empty">Loading KAMs…</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: "52vh" }}>
            <table className="sheet">
              <thead>
                <tr>
                  <th className="sticky-col">{NAME_HEADER}</th>
                  <th>Lead</th>
                  {COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.kam_name}>
                    <td className="sticky-col">{row.kam_name}</td>
                    <td>{row.lead_name}</td>
                    {COLUMNS.map((c) => (
                      <td key={c.key}>
                        <input type="number" min="0" step="any" value={row[c.key]}
                               onChange={setValue(i, c.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={busy || !rows}>
            {busy ? "Saving…" : "Save all"}
          </button>
        </div>
      </div>
    </div>
  );
}
