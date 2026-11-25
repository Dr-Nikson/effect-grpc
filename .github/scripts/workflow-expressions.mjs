// .github/scripts/workflow-expressions.mjs
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";

const STATUS_FUNCTIONS = ["always", "success", "failure", "cancelled"];

const unwrap = (expression) => {
  const text = String(expression);
  return /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text)?.[1] ?? text;
};

function evaluateToData(expression, contexts, status = "success") {
  const functions = Object.entries({
    always: true,
    success: status === "success",
    failure: status === "failure",
    cancelled: false,
  }).map(([name, value]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(value),
  }));
  const ast = new Parser(
    new Lexer(unwrap(expression)).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver);
  return new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate();
}

/**
 * Evaluates a workflow expression, with or without `${{ }}`. The evaluator knows no job status,
 * so always() is true and success() and failure() follow `status`.
 *
 * @param {string | boolean} expression
 * @param {Record<string, unknown>} contexts
 * @param {"success" | "failure"} [status]
 */
export function evaluate(expression, contexts, status = "success") {
  return truthy(evaluateToData(expression, contexts, status));
}

export function expand(value, contexts) {
  return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
    evaluateToData(expression, contexts).coerceString(),
  );
}

/**
 * Whether a job or step with this `if:` runs. As on GitHub, a missing `if:` is `success()`, and a
 * condition that calls no status function also needs `success()`.
 *
 * @param {string | boolean | undefined} condition
 * @param {Record<string, unknown>} contexts
 * @param {"success" | "failure"} [status]
 */
export function runs(condition = "success()", contexts, status = "success") {
  const text = unwrap(condition);
  const callsStatus = new Lexer(text)
    .lex()
    .tokens.some(
      (token, index, tokens) =>
        STATUS_FUNCTIONS.includes(token.lexeme.toLowerCase()) && tokens[index + 1]?.lexeme === "(",
    );
  return evaluate(callsStatus ? text : `success() && (${text})`, contexts, status);
}
