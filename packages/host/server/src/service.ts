/**
 * {@link ServerService} — the route-mounting glue for `/mu/v1/*`.
 *
 * The service depends on three mounted plugins (the web server, the
 * looker, and the authenticator) plus the PostgreSQL store. Its only
 * responsibility is to translate a list of {@link RouteSpec} entries
 * into `webServer.register()` calls during `[Service.init]`. Disposal
 * walks the recorded disposers and tears the routes down.
 *
 * It does NOT carry business logic — handlers live in `./handlers/`.
 * The split keeps `service.ts` small and the handler bodies pure.
 *
 * @module @deepseek-ai/dsh-host-server
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { LookupService } from '@deepseek-ai/dsh-host-lookup'
import type { AuthService } from '@deepseek-ai/dsh-host-auth'
import type { PgStoreService } from '@deepseek-ai/dsh-storage-postgres'
import {
  makeEnsureHandler,
  makeHealthHandler,
  makeLookupHandler,
  makeTokenHandler,
} from './handlers/index.ts'

/** Plain route description — registered into the {@link WebServer} at init. */
export interface RouteSpec {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
}

/** Configuration consumed by {@link ServerService}. */
export interface ServerConfig {
  /** Shared machine API key checked by the Bearer middleware. */
  readonly apiKey: string
}

/** Dependencies injected at construction. */
export interface ServerDeps {
  readonly webServer: WebServer
  readonly lookup: LookupService
  readonly auth: AuthService
  readonly pgstore: PgStoreService
}

/**
 * The route registry. Activation registers every spec against
 * {@link WebServer} and stores the disposer; disposal walks and invokes
 * them in reverse order.
 */
export class ServerService extends Service {
  private readonly disposers: Array<() => void> = []

  constructor(
    ctx: Context,
    /** Configuration passed in by the cordis plugin. Public for inspection. */
    public readonly config: ServerConfig,
    /** Dependencies provided by other plugins. */
    private readonly deps: ServerDeps,
  ) {
    super(ctx, 'dshServer')
  }

  /** Returns the four built-in `/mu/v1/*` route specs. */
  buildRoutes(): readonly RouteSpec[] {
    const ensure = makeEnsureHandler.bind(null)
    const ensureUser = ensure('user', { lookup: this.deps.lookup, apiKey: this.config.apiKey })
    const ensureWorkspace = ensure('workspace', { lookup: this.deps.lookup, apiKey: this.config.apiKey })
    const ensureSession = ensure('session', { lookup: this.deps.lookup, apiKey: this.config.apiKey })
    return [
      { method: 'GET', path: '/mu/v1/health', handler: makeHealthHandler(this.deps.pgstore) },
      { method: 'GET', path: '/mu/v1/lookup', handler: makeLookupHandler({ lookup: this.deps.lookup, apiKey: this.config.apiKey }) },
      { method: 'POST', path: '/mu/v1/ensure/user', handler: ensureUser },
      { method: 'POST', path: '/mu/v1/ensure/workspace', handler: ensureWorkspace },
      { method: 'POST', path: '/mu/v1/ensure/session', handler: ensureSession },
      { method: 'POST', path: '/mu/v1/auth/token:issue', handler: makeTokenHandler({ auth: this.deps.auth, apiKey: this.config.apiKey }) },
    ]
  }

  /** Wire each spec into the {@link WebServer} and remember the disposer. */
  registerAll(specs: readonly RouteSpec[]): void {
    for (const spec of specs) {
      const dispose = this.deps.webServer.register({
        kind: 'exact',
        path: spec.path,
        handler: spec.handler,
      })
      this.disposers.push(dispose)
    }
  }

  /** Reverse-order tear-down. Safe to call on an empty list. */
  unregisterAll(): void {
    while (this.disposers.length > 0) {
      const dispose = this.disposers.pop()
      try { dispose?.() } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  async [Service.init](): Promise<void> {
    this.registerAll(this.buildRoutes())
    // Record disposal so cordis tears the routes down on plugin dispose.
    this.ctx.effect(() => () => { this.unregisterAll() }, 'host-server.routes')
  }
}
