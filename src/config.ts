// Client-side constants. Nothing sensitive is baked in anymore — the OCI
// keys live in Worker secrets and the app talks to its own same-origin
// server functions. (The old build embedded VITE_NEXUS_* values; those days
// are over.)

export const config = {
  appVersion: __APP_VERSION__,
  maxKnownSchema: 1,
} as const
