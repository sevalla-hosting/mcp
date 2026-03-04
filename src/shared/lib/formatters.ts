export const formatCpuPercent = (value: number): string => `${(value * 100).toFixed(1)}%`

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`
}

export const formatDateTime = (timestamp: number, hoursAgo: number): string => {
  const date = new Date(timestamp)
  if (hoursAgo <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (hoursAgo <= 168) {
    return (
      date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
      ' ' +
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    )
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
