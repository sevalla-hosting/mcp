import { describe, it } from 'node:test'
import { ok, strictEqual } from 'node:assert'
import { fetchClientMetadataDocument, parseClientMetadata, validateClientIdUrl } from '../../src/client-metadata.ts'
import { redirectUriMatches, validateRedirectUri } from '../../src/oauth.ts'

const KNOWN_CLIENTS = [
  {
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    name: 'Claude',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  },
  {
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    name: 'Claude Code',
    redirectUri: 'http://localhost:54321/callback',
  },
  {
    clientId: 'https://chatgpt.com/oauth/client.json',
    name: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  },
  {
    clientId: 'https://vscode.dev/oauth/client-metadata.json',
    name: 'Visual Studio Code',
    redirectUri: 'https://vscode.dev/redirect',
  },
]

describe('live client ID metadata documents of known MCP clients', () => {
  for (const client of KNOWN_CLIENTS) {
    it(`fetches and accepts the ${client.name} document`, async () => {
      const document = await fetchClientMetadataDocument(validateClientIdUrl(client.clientId))
      const metadata = parseClientMetadata(client.clientId, document.body)
      strictEqual(metadata.clientName, client.name)
      ok(metadata.redirectUris.every(validateRedirectUri), metadata.redirectUris.join(', '))
      ok(metadata.redirectUris.some((uri) => redirectUriMatches(uri, client.redirectUri)))
    })
  }
})
