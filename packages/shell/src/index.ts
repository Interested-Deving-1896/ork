export { parse } from "./parser.js";
export { ShellParseError, ShellError } from "./errors.js";
export { Shell, type ShellOptions, type ExecResult } from "./interpreter.js";
export { CommandRegistry, defaultRegistry } from "./registry.js";
export type { CommandContext, CommandImpl } from "./types.js";
export type {
  Script,
  Statement,
  AndOr,
  Pipeline,
  CommandNode,
  SimpleCommand,
  IfNode,
  IfClause,
  WhileNode,
  ForNode,
  Redirection,
  RedirOp,
  Assignment,
  Word,
  WordPart,
} from "./ast.js";
