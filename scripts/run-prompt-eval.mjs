import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Compile only the evaluation entry and its local imports. This avoids tsx's
// OS-account lookup in restricted Windows sessions; dependencies stay native.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts", "eval-prompts.ts");
const outputRoot = join(root, ".prompt-eval", "runtime");
const visited = new Set();
function compile(sourcePath) {
  const relativePath = relative(root, sourcePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("EVAL_SOURCE_OUTSIDE_PROJECT");
  if (visited.has(sourcePath)) return;
  visited.add(sourcePath);
  const source = readFileSync(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.ES2022, true);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier?.text;
    if (!specifier?.startsWith(".")) continue;
    const base = resolve(dirname(sourcePath), specifier);
    const dependency = [base + ".ts", base.replace(/\.js$/, ".ts"), join(base, "index.ts")].find(candidate => existsSync(candidate) && candidate.endsWith(".ts"));
    if (!dependency) throw new Error("EVAL_LOCAL_IMPORT_NOT_FOUND");
    compile(dependency);
  }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = join(outputRoot, relativePath.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, output, "utf8");
}
try {
  compile(entry);
  const child = spawnSync(process.execPath, [join(outputRoot, "scripts", "eval-prompts.js"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: process.env });
  process.exitCode = child.status ?? 1;
} catch {
  console.error("EVAL_RUNNER_START_FAILED"); process.exitCode = 1;
}
