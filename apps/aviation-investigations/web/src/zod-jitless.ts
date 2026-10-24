/**
 * Stands in for `zod` in the web build: vite.config.ts maps every `import 'zod'` of the client
 * (the shared contracts' schemas included) to this module, which loads Zod and turns off its
 * compiled parsers before any importer can build a schema.
 *
 * Why: the server's CSP has no 'unsafe-eval'. Zod compiles object parsers with `new Function`
 * and probes for it when an object schema is built; the browser reports that blocked probe as
 * a CSP violation even though Zod catches the error. `jitless` skips the probe, but only if it
 * is set before the first schema is built. Importing a configuring module first in the entry
 * (what this file used to be) does not hold in the production build: the bundler puts Zod and
 * the contracts, which the entry and the lazy pages share, in one chunk that the entry
 * imports, and a chunk runs before the code of its importer. Importing Zod through this module
 * puts the configuration between Zod and every schema, in whatever chunk they land.
 *
 * It imports `zod/v4`, the same code as `zod`, because the alias for `zod` would otherwise
 * point this file at itself (tests/unit/web-bundle-eval.test.ts boots the built bundle).
 */
import { z } from 'zod/v4';

z.config({ jitless: true });

export * from 'zod/v4';
export { z };
