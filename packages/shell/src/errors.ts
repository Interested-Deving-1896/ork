// Error thrown by the lexer and parser of @ork/shell for any syntax that is
// malformed or outside the supported v1 subset.
export class ShellParseError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
    this.name = "ShellParseError";
  }
}
