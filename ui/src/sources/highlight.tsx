import type { ReactNode } from 'react';

/** A small tokenizer for TypeScript and JavaScript: enough colour to read, no dependency. */

const KEYWORDS = new Set(
  'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return satisfies static super switch this throw true try type typeof undefined var void while with yield'.split(
    ' '
  )
);

const TOKEN = /(\/\/.*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|(<\/?[A-Za-z][\w.-]*)/g;

export function highlightLine(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [token, comment, string, number, word, tag] = match;

    let className = '';
    if (comment) className = 'text-zinc-500 italic';
    else if (string) className = 'text-emerald-300';
    else if (number) className = 'text-amber-300';
    else if (tag) className = 'text-sky-300';
    else if (word && KEYWORDS.has(word)) className = 'text-violet-300';
    else if (word && /^[A-Z]/.test(word)) className = 'text-teal-200';

    // Identifiers (and `this`) carry their column so the viewer can evaluate them on hover.
    const identifier = word && (!KEYWORDS.has(word) || word === 'this');

    parts.push(
      className || identifier ? (
        <span key={key++} className={className || undefined} data-ident={identifier ? word : undefined} data-col={identifier ? index : undefined}>
          {token}
        </span>
      ) : (
        token
      )
    );
    last = index + token.length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return parts;
}
