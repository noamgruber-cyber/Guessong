/** Light haptic feedback where supported (Android); silently ignored elsewhere. */
export function haptic(kind: 'tap' | 'success' | 'error' = 'tap') {
  try {
    const pattern = kind === 'tap' ? 8 : kind === 'success' ? [12, 40, 18] : [30, 40, 30];
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

export async function shareLink(opts: { title: string; text: string; url: string }): Promise<'shared' | 'copied' | 'failed'> {
  try {
    if (navigator.share) {
      await navigator.share(opts);
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'failed';
  }
  try {
    await navigator.clipboard.writeText(`${opts.text} ${opts.url}`);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}
