import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const [target, stamp] = process.argv.slice(2);
if (!target || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(target) || !/^\d{8}T\d{6}Z$/.test(stamp ?? "")) throw new Error("Expected SSH target and release timestamp");
const local = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {};
const config = { ...process.env, ...local };
const key = config.TYPESAFE_API_KEY?.trim();
if (!key) {
  console.log("No local TypeSafe key; existing server configuration retained.");
  process.exit(0);
}
if (!/^[A-Za-z0-9_.:/+=-]{16,512}$/.test(key)) throw new Error("Invalid TypeSafe key format; value not displayed");
const values = { TYPESAFE_API_KEY: key };
if (config.TYPESAFE_MODEL) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(config.TYPESAFE_MODEL)) throw new Error("Invalid TypeSafe model");
  values.TYPESAFE_MODEL = config.TYPESAFE_MODEL;
}
for (const name of ["JEV_TIMEOUT_MS", "JEV_QUIET_THRESHOLD"]) {
  if (!config[name]) continue;
  const value = Number(config[name]);
  if (!Number.isFinite(value) || (name === "JEV_TIMEOUT_MS" ? !Number.isInteger(value) || value < 1000 || value > 15000 : value < 0 || value > 0.4)) throw new Error("Invalid Jev runtime setting");
  values[name] = String(value);
}
const code = `import json, os, pathlib, re, sys, tempfile
try:
    payload = json.load(sys.stdin)
    stamp = payload['stamp']
    if not re.fullmatch(r'\\d{8}T\\d{6}Z', stamp):
        raise ValueError()
    backup = pathlib.Path('/opt/bankpilot/backups') / ('release-' + stamp) / 'production.env'
    if not backup.is_file():
        raise ValueError()
    path = pathlib.Path('/opt/bankpilot/deploy/.env.production')
    text = path.read_text()
    allowed = {'TYPESAFE_API_KEY','TYPESAFE_MODEL','JEV_TIMEOUT_MS','JEV_QUIET_THRESHOLD'}
    for name, value in payload['values'].items():
        if name not in allowed or not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:/+=-]+', value):
            raise ValueError()
        line = name + '=' + value
        pattern = r'(?m)^' + re.escape(name) + r'=.*$'
        text = re.sub(pattern, lambda _: line, text) if re.search(pattern, text) else text.rstrip('\\n') + '\\n' + line + '\\n'
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.env.production.', delete=False) as handle:
        os.chmod(handle.name, 0o600)
        handle.write(text)
        temporary = handle.name
    os.replace(temporary, path)
    os.chmod(path, 0o600)
    print('TypeSafe private runtime configuration installed after backup.')
except Exception:
    print('Private TypeSafe configuration could not be installed; values not displayed.', file=sys.stderr)
    sys.exit(1)
`;
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
// The credential travels only in encrypted SSH stdin, never command arguments.
const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, `python3 -c ${shellQuote(code)}`], {
  input: JSON.stringify({ stamp, values }), encoding: "utf8", timeout: 30_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status !== 0) {
  console.error("TypeSafe configuration sync failed; deployment stopped.");
  process.exit(1);
}
