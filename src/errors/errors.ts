/* Searches backwards and forwards till it hits a newline */
export function getFullLine(source: string, current: number): { lineIndex: number; fullLine: string } {
  let back: number = current;
  let forward: number = current;

  while (back > 0 && source[back] != "\n") {
    back--;
  }
  if (source[back] === "\n") {
    back++;
  }
  while (forward < source.length && source[forward] != "\n") {
    forward++;
  }

  const lineIndex = source.slice(0, back).split('\n').length;
  const fullLine = source.slice(back, forward);

  return {lineIndex, fullLine};
}

export function createErrorIndicator(
  snippet: string,
  errorOp: string = "/"
): string {
  const pos = snippet.indexOf(errorOp);
  let indicator = "";
  for (let i = 0; i < snippet.length; i++) {
    indicator += i === pos ? "^" : "~";
  }
  return indicator;
}

/*
    The offset is calculated as follows:    
    Current position is one after real position of end of token: 1
*/
export const MAGIC_OFFSET = 1;

export const SPECIAL_CHARS = new RegExp("[\\\\$'\"]", "g");

function escape(unsafe: string): string {
    // @TODO escape newlines
    return unsafe.replace(SPECIAL_CHARS, "\\$&");
}

