// Runtime environment for the Worker (server functions + server routes).
// Mirrors wrangler.jsonc [vars] + the wrangler secrets. Local dev reads the
// same names from .dev.vars (gitignored).
interface Env {
  OCI_S3_ENDPOINT: string
  OCI_S3_BUCKET: string
  OCI_S3_REGION: string
  PART_SIZE: string
  OCI_S3_ACCESS_KEY_ID: string
  OCI_S3_SECRET_ACCESS_KEY: string
  SESSION_SECRET: string
  SETUP_TOKEN?: string
}

declare module 'cloudflare:workers' {
  export const env: Env
}
