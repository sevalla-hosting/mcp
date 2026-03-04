type Props = {
  data: { page: string; total: number }[]
}

export const TopPathsTable = ({ data }: Props) => {
  const maxTotal = Math.max(...data.map((d) => d.total), 1)

  return (
    <div className="chart-card">
      <h3>Top paths</h3>
      <div className="subtitle">&nbsp;</div>
      <div className="table-list">
        {data.map((row) => (
          <div key={row.page} className="table-row">
            <span className="table-label mono" title={row.page}>
              {row.page}
            </span>
            <div className="table-bar-container">
              <div className="table-bar" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
            </div>
            <span className="table-value">{row.total.toLocaleString()}</span>
          </div>
        ))}
        {data.length === 0 && <div className="loading">No data</div>}
      </div>
    </div>
  )
}
