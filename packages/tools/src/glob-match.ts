/**
 * Glob → RegExp compilation for matching a full relative path.
 *
 * Supported syntax:
 *  - `*`   matches any run of characters except `/`
 *  - `**`  matches any run of characters including `/` (crosses directories);
 *          `**​/` also matches zero directories (so `**​/x` matches `x`)
 *  - `?`   matches a single character except `/`
 *  - `[...]` character class (with leading `!` or `^` negation), passed through
 *          to RegExp with `/` excluded
 *
 * The pattern is anchored: it must match the whole path.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — consume the run of stars.
        i += 2;
        // `**/` collapses to "any path prefix incl. none".
        if (pattern[i] === "/") {
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      // Character class: copy through to the closing ].
      let j = i + 1;
      let neg = false;
      if (pattern[j] === "!" || pattern[j] === "^") {
        neg = true;
        j++;
      }
      let body = "";
      while (j < pattern.length && pattern[j] !== "]") {
        const ch = pattern[j]!;
        // Escape regex-special chars inside the class (except range dash).
        body += ch === "\\" ? "\\\\" : ch;
        j++;
      }
      if (j >= pattern.length) {
        // Unterminated class: treat `[` literally.
        re += "\\[";
        i++;
        continue;
      }
      re += `[${neg ? "^/" : ""}${body}]`;
      i = j + 1;
      continue;
    }
    // Literal char — escape regex metacharacters.
    re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}
