// Test double for the claude CLI. Replays FAKE_FIXTURE to stdout.
// FAKE_EXIT: exit code. FAKE_STDERR: text for stderr. FAKE_HANG=1: never exit.
// FAKE_NO_OUTPUT=1: print nothing. FAKE_ARGS_FILE: append argv (JSON) as one line.
// FAKE_STDIN_FILE: append the stdin text (JSON string) as one line.
import fs from "node:fs";

if (process.env.FAKE_ARGS_FILE) {
  fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
}
if (process.env.FAKE_STDIN_FILE) {
  fs.appendFileSync(process.env.FAKE_STDIN_FILE, JSON.stringify(fs.readFileSync(0, "utf8")) + "\n");
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + "\n");
if (process.env.FAKE_HANG === "1") {
  setInterval(() => {}, 1000);
} else {
  if (process.env.FAKE_FIXTURE && process.env.FAKE_NO_OUTPUT !== "1") {
    process.stdout.write(fs.readFileSync(process.env.FAKE_FIXTURE, "utf8"));
  }
  process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
}
