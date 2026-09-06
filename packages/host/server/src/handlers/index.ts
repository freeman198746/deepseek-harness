/**
 * Re-export barrel for the four control-plane handlers. The router in
 * `service.ts` imports them by name so the route surface stays in one
 * place.
 *
 * @module @deepseek-ai/dsh-host-server
 */

export { makeHealthHandler } from './health.ts'
export { makeLookupHandler } from './lookup.ts'
export { makeEnsureHandler } from './ensure.ts'
export { makeTokenHandler } from './token.ts'
