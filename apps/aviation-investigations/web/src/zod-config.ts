/**
 * Imported first by the entry (main.tsx), before any module that parses with Zod.
 * The server's CSP has no 'unsafe-eval': Zod's compiled object parsers would probe
 * `new Function`, which the browser reports as a CSP violation even though Zod
 * catches the error. Parse without them.
 */
import { z } from 'zod';

z.config({ jitless: true });
