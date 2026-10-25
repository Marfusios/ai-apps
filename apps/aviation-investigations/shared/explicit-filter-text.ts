/** Bounded text preflight for conservative filter permission, never an instruction parser. */
export function explicitFilterText(question: string): string | null {
  if (question.length > 600 || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(question)) return null;
  const text = question.normalize('NFKC');
  if (/["“”«»`<>]|(?:^|\W)'[^']+'(?:\W|$)/u.test(text)) return null;
  if (/\b(?:not|no|never|without|except|exclud\w*|excluding|outside|avoid\w*|rather\s+than|instead\s+of|other\s+than|neither|nor|or|unless|non[-\s]|ignore\w*|disregard\w*|override\w*|instructions?|system|assistant|prompt|pretend\w*|hypothetic\w*|imagine\w*|examples?|quoted?|quotations?|maybe|perhaps|possibly|uncertain|if)\b|n['’]t\b|\b(?:set|add|apply|output|return|force)\s+(?:the\s+)?(?:year|date|category|filter|json)\b/i.test(text)) return null;
  return text;
}
