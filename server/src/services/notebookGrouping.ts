import type { NotebookGroup, NotebookMeta } from "../types/index.js";

const VERSION_SUFFIX_PATTERNS: RegExp[] = [
  /[_\-]v\d+$/i,
  /[_\-]version\d+$/i,
  /[_\-](final|draft|copy|old|new|backup|bak|wip)$/i,
  /\(\d+\)$/,
  /[_\-]\d+$/
];

export function normalizeNotebookName(name: string): string {
  let base = name.trim();
  base = base.replace(/\.(py|sql|scala|r|ipynb)$/i, "");

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of VERSION_SUFFIX_PATTERNS) {
      const stripped = base.replace(pattern, "");
      if (stripped !== base && stripped.length > 0) {
        base = stripped;
        changed = true;
      }
    }
  }

  return base.toLowerCase().replace(/[\s_\-]+/g, "_").replace(/^_+|_+$/g, "");
}

function slugify(key: string): string {
  return key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
}

export function groupNotebooksByNamingPattern(notebooks: NotebookMeta[]): NotebookGroup[] {
  const byBaseKey = new Map<string, string[]>();

  for (const nb of notebooks) {
    const baseKey = normalizeNotebookName(nb.name);
    const existing = byBaseKey.get(baseKey);
    if (existing) {
      existing.push(nb.path);
    } else {
      byBaseKey.set(baseKey, [nb.path]);
    }
  }

  const groups: NotebookGroup[] = [];
  for (const [baseKey, notebookPaths] of byBaseKey.entries()) {
    groups.push({
      id: slugify(baseKey),
      baseKey,
      notebookPaths
    });
  }

  return groups.sort((a, b) => a.baseKey.localeCompare(b.baseKey));
}
