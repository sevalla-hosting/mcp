export type Timeframe = {
  label: string
  key: string
  intervalInSeconds: number
  hoursAgo: number
}

export const timeframes: Timeframe[] = [
  { label: '1h', key: '1h', hoursAgo: 1, intervalInSeconds: 60 },
  { label: '6h', key: '6h', hoursAgo: 6, intervalInSeconds: 60 },
  { label: '24h', key: '24h', hoursAgo: 24, intervalInSeconds: 600 },
  { label: '7d', key: '7d', hoursAgo: 168, intervalInSeconds: 1800 },
]

export const getTimeRange = (tf: Timeframe): { start: string; end: string } => {
  const end = new Date()
  const start = new Date(end.getTime() - tf.hoursAgo * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const getXAxisDateFormat = (hoursAgo: number): string => {
  if (hoursAgo <= 24) {
    return 'HH:mm'
  }
  if (hoursAgo <= 168) {
    return 'MMM dd HH:mm'
  }
  return 'MMM dd'
}
