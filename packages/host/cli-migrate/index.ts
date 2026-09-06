/**
 * `@deepseek-ai/dsh-host-cli-migrate` — `#14` operator command:
 * `dsh-migrate-multiuser`. See `./src/cli.ts` for the implementation.
 *
 * The package ships one binary: `bin/dsh-migrate-multiuser.ts`. It calls
 * {@link runCli} from the source module so the shebang line stays a
 * thin wrapper around the same code path that the tests exercise.
 *
 * @module @deepseek-ai/dsh-host-cli-migrate
 */

import { runCli } from './src/cli.ts'

// Invoke with the test equivalents: argv.slice(2) under `node` /
// `tsx`. When the bin is launched directly this drops straight into
// `runCli(process.argv.slice(2))` and exits with the returned code.
const exitCode = await runCli(process.argv.slice(2))
process.exit(exitCode)
