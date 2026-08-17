/**
 * Dependency-free responsive SVG line chart.
 * series: [{ name, color, values: number[] }]  (all series share `labels`)
 */
export default function LineChart({ labels = [], series = [], height = 220 }) {
  const width = 640;
  const pad = { top: 14, right: 16, bottom: 28, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const allValues = series.flatMap((s) => s.values);
  const maxRaw = Math.max(1, ...allValues);
  // Round the axis ceiling up to a friendly step.
  const step = Math.pow(10, Math.max(0, String(Math.floor(maxRaw)).length - 1));
  const maxY = Math.ceil(maxRaw / step) * step;

  const x = (index) =>
    labels.length <= 1
      ? pad.left + innerW / 2
      : pad.left + (index * innerW) / (labels.length - 1);
  const y = (value) => pad.top + innerH - (value / maxY) * innerH;

  const gridLines = 4;
  const gridValues = Array.from({ length: gridLines + 1 }, (_, i) =>
    Math.round((maxY / gridLines) * i)
  );

  if (!labels.length || !series.length) {
    return <div className="empty">No data to chart yet.</div>;
  }

  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img">
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={pad.left - 8}
              y={y(value) + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
            >
              {value.toLocaleString()}
            </text>
          </g>
        ))}
        {labels.map((label, index) => (
          <text
            key={label + index}
            x={x(index)}
            y={height - 8}
            textAnchor="middle"
            fontSize="10"
            fill="var(--muted)"
          >
            {label}
          </text>
        ))}
        {series.map((s) => {
          const points = s.values
            .map((value, index) => `${x(index)},${y(value)}`)
            .join(" ");
          return (
            <g key={s.name}>
              <polyline
                points={points}
                fill="none"
                stroke={s.color}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.values.map((value, index) => (
                <circle
                  key={index}
                  cx={x(index)}
                  cy={y(value)}
                  r="3.5"
                  fill={s.color}
                  stroke="var(--panel)"
                  strokeWidth="1.5"
                >
                  <title>{`${s.name} · ${labels[index]}: ${value.toLocaleString()}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name}>
            <span className="dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
