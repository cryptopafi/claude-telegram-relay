export type BiRunCommand =
  | {
      mode: "all";
      slug: null;
    }
  | {
      mode: "project";
      slug: string;
    };

export function parseBiRunCommand(text: string): BiRunCommand | null {
  const match = text.trim().match(/^\/bi(?:-run|_run)(?:@[\w_]+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const rawArg = (match[1] || "").trim();
  if (!rawArg) {
    return { mode: "all", slug: null };
  }

  if (!isValidBiSlug(rawArg)) {
    return null;
  }

  return { mode: "project", slug: rawArg.toLowerCase() };
}

export function isValidBiSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value.trim());
}
