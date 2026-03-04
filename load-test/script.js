import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'https://mcp.sevalla.com'
const API_KEY = __ENV.SEVALLA_API_KEY || 'test-api-key'

const connectionErrors = new Counter('connection_errors')
const status200 = new Counter('status_200')
const status500 = new Counter('status_500')
const status401 = new Counter('status_401')
const status429 = new Counter('status_429')
const status503 = new Counter('status_503')
const initDuration = new Trend('init_duration', true)
const listToolsDuration = new Trend('list_tools_duration', true)
const searchDuration = new Trend('search_duration', true)
const executeDuration = new Trend('execute_duration', true)

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 200 },
    { duration: '1m', target: 200 },
    { duration: '1m', target: 500 },
    { duration: '1m', target: 500 },
    { duration: '1m', target: 1000 },
    { duration: '30s', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<10000'],
    connection_errors: ['count<500'],
    init_duration: ['p(95)<5000'],
    list_tools_duration: ['p(95)<5000'],
    search_duration: ['p(95)<10000'],
    execute_duration: ['p(95)<10000'],
  },
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
}

const searchQueries = [
  'sevalla.search({ query: "applications", tag: "Applications" })',
  'sevalla.search({ query: "databases", tag: "Databases" })',
  'sevalla.search({ query: "projects", tag: "Projects" })',
  'sevalla.search({ query: "static sites", tag: "Static sites" })',
  'sevalla.search({ query: "GET /applications", tag: "Applications" })',
  'sevalla.search({ query: "list all databases" })',
  'sevalla.search({ query: "create application" })',
  'sevalla.search({ query: "environment variables" })',
]

const executeQueries = [
  'const res = await sevalla.request("GET /applications"); return res;',
  'const res = await sevalla.request("GET /projects"); return res;',
  'const res = await sevalla.request("GET /databases"); return res;',
  'const res = await sevalla.request("GET /static-sites"); return res;',
]

const mcpRequest = (method, params) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params: params || {},
  })

const toolCallRequest = (toolName, code) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: { code },
    },
  })

const trackStatus = (res) => {
  if (res.status === 0) {
    connectionErrors.add(1)
  } else if (res.status === 200) {
    status200.add(1)
  } else if (res.status === 401) {
    status401.add(1)
  } else if (res.status === 429) {
    status429.add(1)
  } else if (res.status === 500) {
    status500.add(1)
  } else if (res.status === 503) {
    status503.add(1)
  }
}

export default () => {
  const vuId = __VU

  // 1. Initialize
  const initRes = http.post(
    `${BASE_URL}/mcp`,
    mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'k6-load-test', version: '1.0.0' },
    }),
    { headers, tags: { endpoint: 'initialize' } },
  )

  initDuration.add(initRes.timings.duration)
  trackStatus(initRes)
  check(initRes, {
    'initialize: got response': (r) => r.status !== 0,
    'initialize: not overloaded': (r) => r.status !== 503,
  })

  sleep(0.5)

  // 2. List tools
  const listRes = http.post(`${BASE_URL}/mcp`, mcpRequest('tools/list'), {
    headers,
    tags: { endpoint: 'tools_list' },
  })

  listToolsDuration.add(listRes.timings.duration)
  trackStatus(listRes)
  check(listRes, {
    'tools/list: got response': (r) => r.status !== 0,
    'tools/list: not overloaded': (r) => r.status !== 503,
  })

  sleep(0.5)

  // 3. Search
  const searchCode = searchQueries[vuId % searchQueries.length]
  const searchRes = http.post(`${BASE_URL}/mcp`, toolCallRequest('search', searchCode), {
    headers,
    tags: { endpoint: 'search' },
  })

  searchDuration.add(searchRes.timings.duration)
  trackStatus(searchRes)
  check(searchRes, {
    'search: got response': (r) => r.status !== 0,
    'search: not overloaded': (r) => r.status !== 503,
  })

  sleep(Math.random() * 2 + 1)

  // 4. Execute
  const executeCode = executeQueries[vuId % executeQueries.length]
  const executeRes = http.post(`${BASE_URL}/mcp`, toolCallRequest('execute', executeCode), {
    headers,
    tags: { endpoint: 'execute' },
  })

  executeDuration.add(executeRes.timings.duration)
  trackStatus(executeRes)
  check(executeRes, {
    'execute: got response': (r) => r.status !== 0,
    'execute: not overloaded': (r) => r.status !== 503,
  })

  sleep(Math.random() * 2 + 1)
}
