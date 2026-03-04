type Props = {
  data: { country: string; total: number; response_time: number }[]
}

export const TopCountriesTable = ({ data }: Props) => {
  const maxTotal = Math.max(...data.map((d) => d.total), 1)

  return (
    <div className="chart-card">
      <h3>Top countries</h3>
      <div className="subtitle">&nbsp;</div>
      <div className="table-list">
        {data.map((row) => (
          <div key={row.country} className="table-row">
            <span className="table-label">{row.country}</span>
            <div className="table-bar-container">
              <div className="table-bar" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
            </div>
            <span className="table-value">{row.total.toLocaleString()}</span>
            <span className="table-secondary">{Math.round(row.response_time)} ms</span>
          </div>
        ))}
        {data.length === 0 && <div className="loading">No data</div>}
      </div>
    </div>
  )
}
