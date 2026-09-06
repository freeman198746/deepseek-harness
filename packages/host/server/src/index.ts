/**
 * `@deepseek-ai/dsh-host-server` — boots the `/mu/v1/*` control-plane
 * HTTP surface on top of `dsh-host-webserver`.
 *
 * The package does NOT define any new protocol — it wires together the
 * four packages that do:
 *
 *   • `dsh-host-webserver` (provides the `node:http` transport)
 *   • `dsh-host-lookup`   (provides the reverse-lookup and ensure family)
 *   • `dsh-host-auth`     (provides the EdDSA JWT issuer)
 *   • `dsh-storage-postgres` (provides the multi-tenant row store + RLS)
 *
 * Its `apply` hook is synchronous: it builds the
 * {@link ServerService}, registers every handler, and lets cordis mount
 * it. The plugin's `inject` list enforces the ordering so `webServer`,
 * `lookup`, `auth`, and `pgstore` are present by the time `apply` runs.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ServerService } from './service.ts'

/** Cordis plugin name. */
export const name = 'host-server'

/**
 * Mount strictly after the webserver + row store + identity packages
 * so the handler builders find their dependencies on `ctx`.
 */
export const inject: readonly string[] = ['webServer', 'pgstore', 'auth', 'lookup']

/**
 * Plugin configuration. `apiKey` is the shared machine secret the
 * Bearer middleware checks; rotate it through the operator's secret
 * store, not by editing a file. `keyId` is the optional `kid` used
 * for observability only — the v1 verifier does not dispatch on it.
 */
export interface HostServerConfig {
  /** Machine API key. Compared with constant-time equality. */
  readonly apiKey: string
  /** Optional id surfaced in logs. Free-form, never trusted for routing. */
  readonly keyId?: string
}

/** Schemastery validator for {@link HostServerConfig}. */
export const Config: z<HostServerConfig> = z.object({
  apiKey: z.string().min(16).required(),
  keyId: z.string().min(1).required(false),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The control-plane HTTP server. Mounted by `@deepseek-ai/dsh-host-server`. */
    dshServer: ServerService
  }
}

/**
 * Mount the control-plane HTTP server.
 *
 * @param ctx - Cordis context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: HostServerConfig): void {
  const service = new ServerService(
    ctx,
    { apiKey: config.apiKey },
    {
      webServer: ctx.webServer,
      lookup: ctx.lookup,
      auth: ctx.auth,
      pgstore: ctx.pgstore,
    },
  )
  ctx.provide('dshServer', service)
}

export { ServerService, type RouteSpec, type ServerConfig, type ServerDeps } from './service.ts'
export { ServerError, isServerError, type ServerErrorCode } from './error.ts'
export { AUTHORIZATION_HEADER, TENANT_HEADER, TRACE_HEADER, checkBearer, assertBearer } from './middleware.ts'
export { readJsonBody, writeJson, writeOk, writeError } from './http.ts'
export {
  makeHealthHandler,
  makeLookupHandler,
  makeEnsureHandler,
  makeTokenHandler,
} from './handlers/index.ts'
export type { BearerOutcome, MuRoute, RequestTenantContext } from './types.ts'
