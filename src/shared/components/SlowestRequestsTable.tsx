type Props = {
  data: {
    client_request_method: string
    client_request_path: string
    average_response_time_ms: number
    count_of_requests: number
  }[]
}

export const SlowestRequestsTable = ({ data }: Props) => {
  const maxTime = Math.max(...data.map((d) => d.average_response_time_ms), 1)

  return (
    <div className="chart-card">
      <h3>Slowest requests</h3>
      <div className="subtitle">&nbsp;</div>
      <div className="table-list">
        {data.map((row, i) => (
          <div key={i} className="table-row">
            <span className="table-badge">{row.client_request_method}</span>
            <span className="table-label mono" title={row.client_request_path}>
              {row.client_request_path}
            </span>
            <div className="table-bar-container">
              <div className="table-bar" style={{ width: `${(row.average_response_time_ms / maxTime) * 100}%` }} />
            </div>
            <span className="table-value">{Math.round(row.average_response_time_ms)} ms</span>
            <span className="table-secondary">{row.count_of_requests}×</span>
          </div>
        ))}
        {data.length === 0 && <div className="loading">No data</div>}
      </div>
    </div>
  )
}
