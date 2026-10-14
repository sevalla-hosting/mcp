import { z } from 'zod'

export const UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/

export const uuid = (description: string) =>
  z
    .string()
    .refine((value) => UUID_PATTERN.test(value), 'must be a UUID such as 3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f')
    .describe(description)

export const serviceType = z.enum(['application', 'static_site']).describe('Kind of service that service_id refers to.')

export const detail = z.enum(['summary', 'full']).default('summary').describe('full adds every field the API returns.')

export const timeWindow = {
  since_minutes: z
    .number()
    .int()
    .min(1)
    .max(43_200)
    .optional()
    .describe('Window length in minutes, ending at end_time. Default 60.'),
  end_time: z.string().optional().describe('Window end as an ISO 8601 timestamp. Default now.'),
}

export interface Page<T> {
  data: T[]
  total: number
  offset: number
  limit: number
}

export type ApiRecord = Record<string, any>
