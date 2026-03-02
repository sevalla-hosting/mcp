import { randomBytes, createHash } from 'node:crypto'

export const verifyPkce = (verifier: string, challenge: string): boolean =>
  createHash('sha256').update(verifier).digest('base64url') === challenge

export const generateAuthCode = (): string => randomBytes(32).toString('base64url')
