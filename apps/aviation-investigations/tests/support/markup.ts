/**
 * Parses markup as a browser would, with jsdom (a dev dependency without type declarations;
 * the unit project has no DOM library): HTML for the page-head tests, and XML strictly (a
 * document that is not well-formed throws) for the sitemap tests. Only what those tests read
 * is typed.
 */
import { createRequire } from 'node:module';

export interface MarkupElement {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly textContent: string | null;
  readonly innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): MarkupElement | null;
}

export interface MarkupNodes extends Iterable<MarkupElement> {
  readonly length: number;
}

export interface MarkupDocument {
  readonly title: string;
  readonly documentElement: MarkupElement;
  readonly head: MarkupElement;
  querySelector(selector: string): MarkupElement | null;
  querySelectorAll(selector: string): MarkupNodes;
  getElementsByTagName(name: string): MarkupNodes;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (markup: string, options?: { contentType?: string }) => { window: { document: MarkupDocument } };
};

export function parseHtml(html: string): MarkupDocument {
  return new JSDOM(html).window.document;
}

/** Throws when `xml` is not well-formed. */
export function parseXml(xml: string): MarkupDocument {
  return new JSDOM(xml, { contentType: 'application/xml' }).window.document;
}
