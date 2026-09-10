/** Stable views into the stored original text; selecting a view does not prove a claim. */
export function sourcePassages(text: string) {
  const result: Array<{ passageId: string; offset: number; quote: string }> = [];
  for (let offset = 0; offset < text.length; offset += 1200) {
    const quote = text.slice(offset, offset + 1200);
    if (quote.trim().length >= 8) result.push({ passageId: `text_${offset / 1200}`, offset, quote });
  }
  return result;
}
