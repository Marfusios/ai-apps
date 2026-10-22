/**
 * Exact `cl100k_base` token counts (the tokenizer of OpenAI `text-embedding-3-*`).
 *
 * `js-tiktoken` encodes text by splitting it with the encoding's pre-tokenizer regex
 * and byte-pair encoding every piece on its own, so a text's token count is the sum
 * of its pieces' counts. `countTokens` does the same split and memoizes the count of
 * each distinct piece, which is several times faster on narrative text than encoding
 * every passage from scratch and gives exactly `encode(text).length` (a unit test
 * compares both on the fixtures and on edge cases). Special-token strings such as
 * `<|endoftext|>` are counted as ordinary text, never as special tokens.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

export const TOKENIZER = 'cl100k_base';

let encoder: Tiktoken | undefined;
let pieces: RegExp | undefined;
const memo = new Map<string, number>();
/** Bound on memoized pieces; the memo is cleared when it grows past it. */
const MEMO_LIMIT = 500_000;

function tokenizer(): { enc: Tiktoken; re: RegExp } {
  if (!encoder || !pieces) {
    encoder = new Tiktoken(cl100kBase);
    pieces = new RegExp(cl100kBase.pat_str, 'gu');
  }
  return { enc: encoder, re: pieces };
}

/** Exact `cl100k_base` token count of `text` (special-token strings count as text). */
export function countTokens(text: string): number {
  if (text === '') return 0;
  const { enc, re } = tokenizer();
  let n = 0;
  for (const m of text.matchAll(re)) {
    const piece = m[0];
    let c = memo.get(piece);
    if (c === undefined) {
      c = enc.encode(piece, [], []).length;
      if (memo.size >= MEMO_LIMIT) memo.clear();
      memo.set(piece, c);
    }
    n += c;
  }
  return n;
}

/** Reference count by full encoding (tests compare it with `countTokens`). */
export function encodeLength(text: string): number {
  return tokenizer().enc.encode(text, [], []).length;
}
