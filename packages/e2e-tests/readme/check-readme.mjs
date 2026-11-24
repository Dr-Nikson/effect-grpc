// packages/e2e-tests/readme/check-readme.mjs
//
// Type-checks README.md's code as a reader would run it. Writes the README's fenced blocks into a
// scratch project, runs `buf generate` with the README's own buf.gen.yaml and protos, compiles every
// TypeScript block with the repository's compiler options, and checks each excerpt of generated code
// against the file buf wrote. Every error names a README line.
//
// The rules, read from each block's info string and first line:
// - A first-line path comment (`// src/server.ts`, `// proto/example/v1/hello.proto`, `# buf.gen.yaml`)
//   makes the block that file of the project, in any language.
// - A TypeScript block whose path is under src/generated/ is an excerpt: each declaration in it must
//   equal the generated declaration of the same name, comments and layout aside. An excerpt's
//   `declare const x: T` matches the type of the generated `const x: T = ...`.
// - Any other TypeScript block (`ts` or `typescript`) is its own module next to src/server.ts. It
//   imports what it uses and writes `declare const` for values it does not build.
// - Other blocks are not read. Packages that README examples import but no workspace installs are
//   declared in modules.d.ts next to this file.
//
// usage: node packages/e2e-tests/readme/check-readme.mjs [README.md] [host package dir] [repository root]
// The arguments default to the repository's README, packages/e2e-tests and the repository root.
// Exit code 0: every block compiles. 1: README problems, printed as README.md:<line>:<col>. 2: setup.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[4] ?? join(here, "..", "..", ".."));
const readmePath = resolve(process.argv[2] ?? join(root, "README.md"));
const host = resolve(process.argv[3] ?? join(here, ".."));
const readmeName = readmePath.startsWith(root + sep) ? relative(root, readmePath) : readmePath;
const project = join(host, "readme", "project");
const ts = createRequire(join(host, "noop.js"))("typescript");

const fatal = (message) => {
  console.error(`check-readme: ${message}`);
  process.exit(2);
};

const plugin = join(root, "packages", "effect-grpc", "dist", "protocGenPlugin.js");
if (!existsSync(plugin)) {
  fatal(`the library is not built; build it first: pnpm --dir ${root} run build:recur`);
}
if (
  statSync(join(root, "packages", "effect-grpc", "src", "protocGenPlugin.ts")).mtimeMs >
  statSync(plugin).mtimeMs
) {
  fatal(
    `${relative(root, plugin)} is older than its source; build the library first: pnpm --dir ${root} run build:recur`,
  );
}

const lines = readFileSync(readmePath, "utf8").split("\n");
const fences = [];
for (let i = 0, open = null; i < lines.length; i++) {
  const fence = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
  if (!fence) continue;
  if (open === null) {
    open = { line: i + 1, indent: fence[1].length, marker: fence[2], lang: fence[3].toLowerCase() };
  } else if (
    lines[i].trim() === fence[2] &&
    fence[2][0] === open.marker[0] &&
    fence[2].length >= open.marker.length
  ) {
    const body = lines
      .slice(open.line, i)
      .map((text) => text.slice(Math.min(open.indent, text.search(/\S|$/))));
    fences.push({ ...open, body });
    open = null;
  }
}

const isTs = (fence) => fence.lang === "ts" || fence.lang === "typescript";
const pathOf = (fence) =>
  /^\s*(?:\/\/|#)\s*([\w.@/-]+\.(?:ts|proto|ya?ml))\s*$/.exec(fence.body[0] ?? "")?.[1];

const problems = [];
const at = (fence, bodyLine, column, code, message) =>
  problems.push({ line: fence.line + 1 + bodyLine, col: column + 1 + fence.indent, code, message });

const files = new Map();
const excerpts = [];
for (const fence of fences) {
  const path = pathOf(fence);
  if (isTs(fence) && path?.startsWith("src/generated/")) {
    excerpts.push({ ...fence, path });
  } else if (path !== undefined || isTs(fence)) {
    const target = path ?? `src/readme-L${fence.line}.ts`;
    const other = files.get(target);
    if (other)
      at(fence, 0, 0, "path", `${target} is also written by the block at line ${other.line}`);
    else files.set(target, fence);
  }
}

rmSync(project, { recursive: true, force: true });
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
write(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n");
write(
  join(project, "src", "readme-modules.d.ts"),
  readFileSync(join(here, "modules.d.ts"), "utf8"),
);
for (const [path, fence] of files) write(join(project, path), fence.body.join("\n") + "\n");

if (files.has("buf.gen.yaml")) {
  const bins = [join(host, "node_modules", ".bin"), join(root, "node_modules", ".bin")];
  const buf = spawnSync("buf", ["generate"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: [...bins, process.env.PATH ?? ""].join(delimiter) },
  });
  if (buf.error) fatal(`could not run buf: ${buf.error.message}`);
  if (buf.status !== 0) {
    const mapped = buf.stderr.replace(
      /((?:proto|src)\/[\w./-]+):(\d+):(\d+)/g,
      (whole, path, line, col) => {
        const fence = files.get(path);
        return fence ?
            `${readmeName}:${fence.line + Number(line)}:${Number(col) + fence.indent}`
          : whole;
      },
    );
    fatal(`buf generate failed on the README's protos:\n${mapped}`);
  }
}

const tsFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));

const basePath = join(root, "tsconfig.base.json");
const base = ts.readConfigFile(basePath, ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(
  { ...base.config, files: [], include: [] },
  ts.sys,
  root,
  {
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    noUnusedParameters: false,
    moduleDetection: ts.ModuleDetectionKind.Force,
  },
  basePath,
);

// Every .ts file the check wrote is a root, wherever its path comment put it.
const program = ts.createProgram({ rootNames: tsFiles(project), options });
const byFile = new Map([...files].map(([path, fence]) => [join(project, path), fence]));
for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n  ");
  const code = `TS${diagnostic.code}`;
  const fence = diagnostic.file && byFile.get(resolve(diagnostic.file.fileName));
  if (!diagnostic.file) {
    problems.push({ line: 1, col: 1, code, message });
  } else if (!fence) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    const file = relative(project, diagnostic.file.fileName);
    problems.push({
      line: 1,
      col: 1,
      code,
      message: `${file}:${line + 1}:${character + 1} (code the README's protos generate): ${message}`,
    });
  } else {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    const hint =
      diagnostic.code === 2307 && /'[^.'][^']*'/.test(message) ?
        " Install it in packages/e2e-tests or declare it in readme/modules.d.ts."
      : "";
    at(fence, line, character, code, message + hint);
  }
}

const printer = ts.createPrinter({ removeComments: true });
const flat = (node, file) =>
  printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, " ").trim();

// Each declaration keyed by kind and name. A variable maps to its declarator, so `export const` and
// `export declare const` compare equal.
const kindOf = (statement) =>
  ts.isInterfaceDeclaration(statement) ? "interface"
  : ts.isTypeAliasDeclaration(statement) ? "type"
  : ts.isFunctionDeclaration(statement) ? "function"
  : undefined;
const declarations = (file) => {
  const found = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declarator of statement.declarationList.declarations) {
        found.push({ key: `const ${declarator.name.getText(file)}`, node: declarator });
      }
    } else if (kindOf(statement) && statement.name) {
      found.push({ key: `${kindOf(statement)} ${statement.name.text}`, node: statement });
    }
  }
  return found;
};
// What an excerpt's declaration is held to: a const without an initializer shows only its type, and a
// function without a body shows only its signature.
const compared = (node, file, shown) => {
  if (ts.isVariableDeclaration(node) && !shown.initializer) return flat(node.type ?? node, file);
  if (ts.isFunctionDeclaration(node) && !shown.body) {
    const typeParameters = (node.typeParameters ?? []).map((p) => flat(p, file)).join(", ");
    const parameters = node.parameters.map((p) => flat(p, file)).join(", ");
    return `function ${node.name?.text}<${typeParameters}>(${parameters}): ${node.type ? flat(node.type, file) : "void"}`;
  }
  return flat(node, file);
};

for (const excerpt of excerpts) {
  const generatedPath = join(project, excerpt.path);
  if (!existsSync(generatedPath)) {
    at(excerpt, 0, 0, "excerpt", `${excerpt.path} is not generated from the README's protos`);
    continue;
  }
  const generated = ts.createSourceFile(
    generatedPath,
    readFileSync(generatedPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const shown = ts.createSourceFile(
    "excerpt.ts",
    excerpt.body.join("\n"),
    ts.ScriptTarget.Latest,
    true,
  );
  const index = new Map(declarations(generated).map((entry) => [entry.key, entry.node]));
  if (declarations(shown).length === 0) {
    at(excerpt, 0, 0, "excerpt", "an excerpt of generated code must show at least one declaration");
  }
  for (const { key, node } of declarations(shown)) {
    const { line, character } = shown.getLineAndCharacterOfPosition(node.getStart(shown));
    const actual = index.get(key);
    if (!actual) {
      at(excerpt, line, character, "excerpt", `\`${key}\` is not declared in ${excerpt.path}`);
    } else if (compared(actual, generated, node) !== compared(node, shown, node)) {
      at(
        excerpt,
        line,
        character,
        "excerpt",
        `\`${key}\` differs from ${excerpt.path}, which declares:\n  ${compared(actual, generated, node)}`,
      );
    }
  }
}

problems.sort((a, b) => a.line - b.line || a.col - b.col);
for (const { line, col, code, message } of problems) {
  console.log(`${readmeName}:${line}:${col} error ${code}: ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `::error file=${readmeName},line=${line},col=${col}::${code} ${message.replace(/%/g, "%25").replace(/\n/g, "%0A")}`,
    );
  }
}
const modules = [...files.keys()].filter((path) => path.endsWith(".ts")).length;
console.log(
  problems.length === 0 ?
    `${readmeName}: ${modules} TypeScript blocks compile and ${excerpts.length} excerpts match the generated code`
  : `${readmeName}: ${problems.length} problem(s)`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
