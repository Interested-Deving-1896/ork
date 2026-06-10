export { parse } from "./parser.js";
export { ShellParseError } from "./errors.js";
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
