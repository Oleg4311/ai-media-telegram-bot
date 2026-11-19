export async function translateToEnglish(text: string): Promise<string> {
  if (!text || !/[а-яё]/i.test(text)) return text;
  try {
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|en`);
    if (!response.ok) return text;
    const data = (await response.json()) as { responseData?: { translatedText?: string } };
    const translated = data.responseData?.translatedText;
    if (!translated || /mymemory warning/i.test(translated)) return text;
    return translated;
  } catch {
    return text;
  }
}
