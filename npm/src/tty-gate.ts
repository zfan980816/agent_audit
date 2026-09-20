// Ledger M (win32 colors): picocolors decides color support ONCE, at import
// time — `isColorSupported` is a module-level `let` computed from env/argv and
// `module.exports = createColors()` bakes the formatters in immediately, so a
// NO_COLOR assignment made later (e.g. at the top of main()) has no effect.
// Python's rich instead gates each Console on .isatty() per creation, so a
// piped run renders plain there. To match: this gate must run BEFORE
// picocolors is first imported. cli.ts imports this module as its FIRST import
// (ESM evaluates imports in declaration order), which guarantees the ordering
// against report.js -> picocolors. Verified with picocolors 1.1.1 source:
// no lazy per-call env re-read exists.
//
// Matches the Python CLI surface: colored when stdout is a real terminal,
// plain when piped/captured. NO_COLOR already set means the user opted out
// explicitly and is always respected.
if (!process.stdout.isTTY && !process.env.NO_COLOR) {
  process.env.NO_COLOR = "1";
}
