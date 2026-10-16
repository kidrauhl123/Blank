import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runPromptEvaluation, safeFailure } from "../evals/prompt-eval";

async function main() {
  const { values } = parseArgs({ options: {
    "dry-run": { type: "boolean", default: false }, "env-file": { type: "string" },
    output: { type: "string", default: ".prompt-eval" }, "max-calls": { type: "string", default: "80" },
    repeat: { type: "string", default: "1" }, case: { type: "string" },
  } });
  if (values["env-file"]) loadEnvFile(resolve(values["env-file"]));
  const report = await runPromptEvaluation({ dryRun: values["dry-run"], outputDir: resolve(values.output), maxCalls: Number(values["max-calls"]), repeat: Number(values.repeat), caseIds: values.case?.split(",") });
  console.log(JSON.stringify({ mode: report.mode, model: report.model, ...report.summary }));
  if (report.mode === "BLOCKED_CONFIG" || report.summary.notRun > 0 && report.mode !== "DRY_RUN") process.exitCode = 2;
  else if (report.summary.checksFailed > 0 || report.summary.errors > 0) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
