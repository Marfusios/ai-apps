/**
 * Build-time helpers for the web client: the CSP check for inline scripts, the
 * B612 preload link, and the SIL OFL notices for the self-hosted fonts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/** `sha256-…` source expressions for every inline script in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)].map(
    (m) => `sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}`,
  );
}

/**
 * Fails the build when the built `index.html` has an inline script whose hash is
 * not listed, so the server CSP can never silently block the theme script.
 */
export function cspHashGuard(allowed: readonly string[]): Plugin {
  return {
    name: 'casebook:csp-hash-guard',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        for (const hash of inlineScriptHashes(html)) {
          if (!allowed.includes(hash)) {
            throw new Error(
              `Inline script hash ${hash} is not in web/src/csp-hashes.ts. ` +
                'Update CSP_SCRIPT_HASHES after changing an inline script in web/index.html.',
            );
          }
        }
        return html;
      },
    },
  };
}

/** Adds `<link rel="preload">` for the emitted font file whose name matches. */
export function preloadFont(fileName: RegExp): Plugin {
  let base = '/';
  return {
    name: 'casebook:preload-font',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const asset = Object.values(ctx.bundle ?? {}).find(
          (file) => file.type === 'asset' && fileName.test(file.fileName),
        );
        if (!asset) throw new Error(`No emitted font matches ${fileName}; cannot add its preload link.`);
        return {
          html,
          tags: [
            {
              tag: 'link',
              attrs: {
                rel: 'preload',
                href: `${base}${asset.fileName}`,
                as: 'font',
                type: 'font/woff2',
                crossorigin: '',
              },
              injectTo: 'head',
            },
          ],
        };
      },
    },
  };
}

/** Emits the SIL Open Font License notices of the bundled fonts next to the build. */
export function fontLicenses(packages: readonly string[], fileName = 'licenses/fonts.txt'): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'casebook:font-licenses',
    apply: 'build',
    generateBundle() {
      const sections = packages.map((name) => {
        const text = readFileSync(require.resolve(`${name}/LICENSE`), 'utf8').trim();
        return `${name}\n${'='.repeat(name.length)}\n\n${text}\n`;
      });
      this.emitFile({
        type: 'asset',
        fileName,
        source: `Fonts bundled with AirCase\n\n${sections.join('\n\n')}`,
      });
    },
  };
}
