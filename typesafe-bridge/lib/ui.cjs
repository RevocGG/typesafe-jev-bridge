"use strict";
/**
 * lib/ui.cjs — tiny terminal helpers shared by bridge.js, setup and doctor.
 *
 * Colors are enabled only when stdout is a TTY, NO_COLOR is unset (or empty)
 * and --no-color was not passed. Everything degrades to plain, greppable lines.
 */

var IS_TTY = Boolean(process.stdout && process.stdout.isTTY);
var NO_COLOR = Boolean(process.env.NO_COLOR) || process.argv.indexOf("--no-color") !== -1;
var COLOR = IS_TTY && !NO_COLOR;

function paint(open, close, s) {
  if (!COLOR) return String(s);
  return "\x1b[" + open + "m" + String(s) + "\x1b[" + close + "m";
}

var ui = {
  isTTY: IS_TTY,
  color: COLOR,

  bold: function (s) { return paint(1, 22, s); },
  dim: function (s) { return paint(2, 22, s); },
  green: function (s) { return paint(32, 39, s); },
  yellow: function (s) { return paint(33, 39, s); },
  red: function (s) { return paint(31, 39, s); },
  cyan: function (s) { return paint(36, 39, s); },

  /** "✓"/"!" /"✗" prefix (plain "ok"/"warn"/"fail" words when not a TTY). */
  okMark: function () { return COLOR ? "\u2713" : "[ok]"; },
  warnMark: function () { return COLOR ? "!" : "[warn]"; },
  failMark: function () { return COLOR ? "\u2717" : "[FAIL]"; },

  ok: function (s) { return ui.green(ui.okMark() + " " + s); },
  warn: function (s) { return ui.yellow(ui.warnMark() + " " + s); },
  fail: function (s) { return ui.red(ui.failMark() + " " + s); },

  /**
   * Read a line from stdin without echoing (hidden key input).
   * Resolves with the trimmed line. Falls back to normal stdin if raw mode
   * is unavailable (e.g. piped input, which is fine for tests/CI).
   */
  readHidden: function (prompt) {
    return new Promise(function (resolve) {
      if (prompt) process.stderr.write(prompt);
      var stdin = process.stdin;
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        // Piped input: read one line without raw mode (still hidden in the
        // sense that piped input is never echoed by the terminal).
        var buf = "";
        var onData = function (c) {
          buf += c;
          var nl = buf.indexOf("\n");
          if (nl !== -1) {
            stdin.removeListener("data", onData);
            stdin.pause();
            resolve(buf.slice(0, nl).replace(/\r$/, "").trim());
          }
        };
        stdin.resume();
        stdin.on("data", onData);
        return;
      }
      var out = "";
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        try { stdin.setRawMode(false); } catch (e) { /* not raw */ }
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.pause();
        process.stderr.write("\n");
        resolve(value);
      };
      var onData = function (ch) {
        var c = String(ch);
        if (c === "\r" || c === "\n") return finish(out);
        if (c === "\u0003") { // Ctrl+C
          process.stderr.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") { // backspace
          if (out.length) out = out.slice(0, -1);
          return;
        }
        // Ignore control chars, accept everything printable.
        if (c >= " ") out += c;
      };
      var onEnd = function () { finish(out); };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdin.on("end", onEnd);
    });
  },

  /** Read a plain line (echoed) — used for y/n confirmations. */
  readLine: function (prompt) {
    return new Promise(function (resolve) {
      if (prompt) process.stderr.write(prompt);
      var stdin = process.stdin;
      var buf = "";
      var onData = function (c) {
        buf += c;
        var nl = buf.indexOf("\n");
        if (nl !== -1) {
          stdin.removeListener("data", onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, "").trim());
        }
      };
      stdin.resume();
      stdin.on("data", onData);
      stdin.on("end", function () { resolve(buf.trim()); });
    });
  },
};

module.exports = ui;
