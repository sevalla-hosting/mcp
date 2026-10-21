import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { ApiError, encodePath, type SevallaClient } from '../sevalla/client.ts'
import { ToolInputError, writeTool } from './define.ts'
import { formatApiErrorShort, omitEmpty, toolResult } from './format.ts'
import { listAllVariables } from './configuration.ts'
import { summarizeDeployment } from './services.ts'
import { uuid, type ApiRecord } from './schemas.ts'

const displayName = (what: string) => z.string().min(2).max(64).describe(`Display name of the new ${what}.`)

const clusterId = uuid('Region ID (get_platform_options).')

const projectId = uuid('Project to add the service to.').optional()

export const createApplication = writeTool('create', {
  name: 'create_application',
  title: 'Create Sevalla application',
  description:
    'Creates a Sevalla application from a Git repository or Docker image with one web process, and by default starts its first deployment. It is billed by the size and number of its process instances.',
  input: z
    .object({
      display_name: displayName('application'),
      cluster_id: clusterId,
      source: z
        .enum(['privateGit', 'publicGit', 'dockerImage'])
        .describe(
          'privateGit: via the account GitHub, GitLab or Bitbucket connection. publicGit: a public repository URL.',
        ),
      repo_url: z.string().url().optional().describe('Repository URL, for Git sources.'),
      git_type: z
        .enum(['github', 'gitlab', 'bitbucket'])
        .optional()
        .describe('Provider, when not detectable from the URL.'),
      default_branch: z.string().min(1).max(255).optional().describe('Branch to deploy. Default: repository default.'),
      docker_image: z.string().min(1).max(512).optional().describe('Image, e.g. nginx:1.27, for source dockerImage.'),
      docker_registry_credential_id: uuid('Registry credential for private images.').optional(),
      project_id: projectId,
      deploy: z.boolean().default(true).describe('Start the first deployment.'),
    })
    .strict(),
  run: async (args, { api }) => {
    if (args.source !== 'dockerImage' && !args.repo_url) {
      throw new ToolInputError('repo_url is required when source is privateGit or publicGit.')
    }
    if (args.source === 'dockerImage' && !args.docker_image) {
      throw new ToolInputError('docker_image is required when source is dockerImage.')
    }
    const app = await api.post<ApiRecord>(
      '/applications',
      omitEmpty({
        display_name: args.display_name,
        cluster_id: args.cluster_id,
        source: args.source,
        repo_url: args.repo_url,
        git_type: args.git_type,
        default_branch: args.default_branch,
        docker_image: args.docker_image,
        docker_registry_credential_id: args.docker_registry_credential_id,
        project_id: args.project_id,
      }),
    )
    let deployment: ReturnType<typeof summarizeDeployment>
    let deploymentError: string | undefined
    if (args.deploy) {
      try {
        deployment = summarizeDeployment(await api.post<ApiRecord>(encodePath`/applications/${app.id}/deployments`, {}))
      } catch (err) {
        if (!(err instanceof ApiError)) {
          throw err
        }
        deploymentError = formatApiErrorShort(err)
      }
    }
    return toolResult(
      omitEmpty({
        application: omitEmpty({
          id: app.id,
          name: app.name,
          display_name: app.display_name,
          status: app.status,
          source: app.source,
          repo_url: app.repo_url,
          default_branch: app.default_branch,
          docker_image: app.docker_image,
          build_type: app.build_type,
        }),
        deployment,
        deployment_error: deploymentError,
        note: deployment ? 'get_deployment reports the progress of the first deployment.' : undefined,
      }),
    )
  },
})

const deployPaths = z.array(z.string().min(1).max(255)).min(1).max(50).optional()

export const createStaticSite = writeTool('create', {
  name: 'create_static_site',
  title: 'Create Sevalla static site',
  description:
    'Creates a Sevalla static site from a Git repository and starts its first build. Omitted build settings are detected automatically.',
  input: z
    .object({
      display_name: displayName('static site'),
      repo_url: z.string().url().describe('Repository URL.'),
      default_branch: z.string().min(1).max(255).describe('Branch to build.'),
      source: z
        .enum(['privateGit', 'publicGit'])
        .optional()
        .describe('privateGit: via the account Git connection. publicGit: a public repository.'),
      git_type: z
        .enum(['github', 'gitlab', 'bitbucket'])
        .optional()
        .describe('Provider, when not detectable from the URL.'),
      install_command: z.string().max(500).optional().describe('e.g. npm ci'),
      build_command: z.string().max(500).optional().describe('e.g. npm run build'),
      published_directory: z.string().max(255).optional().describe('Build output directory, e.g. dist.'),
      root_directory: z.string().max(255).optional().describe('Repository subdirectory of the site.'),
      node_version: z.string().max(20).optional().describe('Node.js version, e.g. 22.'),
      auto_deploy: z.boolean().optional().describe('Deploy on every push.'),
      allow_deploy_paths: deployPaths.describe('Only pushes changing these globs deploy.'),
      ignore_deploy_paths: deployPaths.describe('Pushes changing only these globs skip deployment.'),
      is_preview_enabled: z.boolean().optional().describe('Preview deployments for pull requests.'),
      index_file: z.string().min(1).max(255).optional().describe('e.g. index.html'),
      error_file: z.string().min(1).max(255).optional().describe('Not-found page, e.g. 404.html'),
      project_id: projectId,
    })
    .strict(),
  run: async (args, { api }) => {
    if (args.allow_deploy_paths && args.ignore_deploy_paths) {
      throw new ToolInputError('allow_deploy_paths and ignore_deploy_paths are mutually exclusive.')
    }
    const site = await api.post<ApiRecord>('/static-sites', omitEmpty({ ...args }))
    return toolResult({
      static_site: omitEmpty({
        id: site.id,
        name: site.name,
        display_name: site.display_name,
        status: site.status,
        hostname: site.hostname,
        repo_url: site.repo_url,
        default_branch: site.default_branch,
      }),
      note: 'The first build starts automatically; list_deployments reports its progress.',
    })
  },
})

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

export const generatePassword = (length = 32): string =>
  Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('')

const toDbName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63) || 'app'

const DATABASE_TYPES = ['postgresql', 'mysql', 'mariadb', 'redis', 'valkey'] as const

type DatabaseType = (typeof DATABASE_TYPES)[number]

export const connectionUrl = (
  type: DatabaseType,
  user: string,
  password: string,
  host: string,
  port: string,
  dbName: string,
) => {
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
  if (type === 'redis' || type === 'valkey') {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}`
  }
  const scheme = type === 'postgresql' ? 'postgresql' : 'mysql'
  return `${scheme}://${credentials}@${host}:${port}/${encodeURIComponent(dbName)}`
}

const resolveVersion = async (
  api: SevallaClient,
  type: DatabaseType,
  clusterId: string,
  version: string | undefined,
) => {
  if (version) {
    return version
  }
  const options = await api.get<{ type: string; versions: string[] }[]>('/resources/database-versions', {
    cluster_id: clusterId,
    type,
  })
  const versions = options.find((o) => o.type === type)?.versions ?? []
  const newest = versions[versions.length - 1]
  if (!newest) {
    throw new ToolInputError(`No ${type} versions are available in this cluster.`)
  }
  return newest
}

const addVariable = async (api: SevallaClient, applicationId: string, key: string, value: string) => {
  const base = encodePath`/applications/${applicationId}/env-vars`
  if ((await listAllVariables(api, base)).some((v) => v.key === key)) {
    return `${key} already exists and was left unchanged; the connection URL was not stored`
  }
  await api.post(base, { key, value })
  return `${key} created`
}

export const createDatabase = writeTool('create', {
  name: 'create_database',
  title: 'Create Sevalla database',
  openWorld: false,
  description:
    'Creates a managed Sevalla database (billed by size). Its password is generated on the server and never returned. connect_to_application_id also connects it to that application and stores the connection URL in the application variable env_var_name, unless that variable already exists. Provisioning is asynchronous; get_database shows when it is ready.',
  input: z
    .object({
      display_name: displayName('database'),
      type: z.enum(DATABASE_TYPES).describe('Database engine.'),
      version: z
        .string()
        .min(1)
        .max(20)
        .optional()
        .describe('Engine version, e.g. 17 for PostgreSQL. Default: the newest in the cluster.'),
      cluster_id: clusterId,
      size_id: uuid('Size ID (get_platform_options).'),
      db_name: z
        .string()
        .regex(/^[A-Za-z0-9_+-]{2,100}$/, 'must be 2 to 100 letters, digits, underscores, hyphens or plus signs')
        .optional()
        .describe('Database name. Default: from display_name.'),
      db_user: z.string().min(2).max(32).optional().describe('Username; not root or postgres.'),
      extensions: z
        .object({ vector: z.boolean().optional(), postgis: z.boolean().optional(), cron: z.boolean().optional() })
        .strict()
        .optional()
        .describe('PostgreSQL extensions to enable.'),
      project_id: projectId,
      connect_to_application_id: uuid('Application in the same region to connect.').optional(),
      env_var_name: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name')
        .default('DATABASE_URL')
        .describe('Variable that receives the connection URL.'),
    })
    .strict(),
  run: async (args, { api }) => {
    if (args.extensions && args.type !== 'postgresql') {
      throw new ToolInputError('extensions apply to PostgreSQL only.')
    }
    if (args.db_user && ['root', 'postgres'].includes(args.db_user.toLowerCase())) {
      throw new ToolInputError('db_user cannot be root or postgres.')
    }
    const version = await resolveVersion(api, args.type, args.cluster_id, args.version)
    const password = generatePassword()
    const dbName = args.db_name ?? toDbName(args.display_name)
    const usesUser = args.type === 'postgresql' || args.type === 'mysql' || args.type === 'mariadb'
    const dbUser = usesUser ? (args.db_user ?? (args.connect_to_application_id ? 'app_user' : undefined)) : undefined
    const created = await api.post<ApiRecord>(
      '/databases',
      omitEmpty({
        display_name: args.display_name,
        type: args.type,
        version,
        cluster_id: args.cluster_id,
        resource_type_id: args.size_id,
        db_name: dbName,
        db_user: dbUser,
        db_password: password,
        project_id: args.project_id,
        extensions: args.extensions
          ? omitEmpty({
              enable_vector: args.extensions.vector,
              enable_postgis: args.extensions.postgis,
              enable_cron: args.extensions.cron,
            })
          : undefined,
      }),
    )
    const database = omitEmpty({
      id: created.id,
      name: created.name,
      display_name: created.display_name,
      type: created.type,
      version: created.version,
      status: created.status,
      size: created.resource_type_name,
      db_name: dbName,
      db_user: dbUser,
    })
    if (!args.connect_to_application_id) {
      return toolResult({
        database,
        note: 'The generated password is not returned; the Sevalla dashboard shows it. get_database reports when the status is ready.',
      })
    }
    const connection: Record<string, unknown> = { application_id: args.connect_to_application_id }
    try {
      const details = await api.get<ApiRecord>(encodePath`/databases/${created.id}`)
      try {
        await api.post(encodePath`/databases/${created.id}/internal-connections`, {
          target_id: args.connect_to_application_id,
          target_type: 'app',
        })
        connection.internal_connection = 'created'
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) {
          throw err
        }
        connection.internal_connection = 'already existed'
      }
      if (!details.internal_hostname || !details.internal_port) {
        connection.env_var = 'not set: the internal hostname is not assigned yet'
      } else {
        const url = connectionUrl(
          args.type,
          dbUser ?? 'app_user',
          password,
          details.internal_hostname,
          String(details.internal_port),
          dbName,
        )
        connection.env_var = await addVariable(api, args.connect_to_application_id, args.env_var_name, url)
      }
    } catch (err) {
      if (!(err instanceof ApiError)) {
        throw err
      }
      connection.error = formatApiErrorShort(err)
    }
    return toolResult({
      database,
      connection,
      note: 'The connection URL contains the password and is stored only in the application environment variable. The application uses it after its next deployment (trigger_deployment), once get_database reports the database as ready.',
    })
  },
})

export const CREATE_TOOLS = [createApplication, createStaticSite, createDatabase]
