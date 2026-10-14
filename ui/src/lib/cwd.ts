/** Split a working directory into a shrinkable parent and a fixed folder name, with home as ~. */
export function cwdParts(cwd: string): { dir: string; base: string } {
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  const trimmed = home.length > 1 ? home.replace(/\/+$/, '') : home;
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return { dir: '', base: trimmed };
  return { dir: trimmed.slice(0, cut + 1), base: trimmed.slice(cut + 1) || '/' };
}
