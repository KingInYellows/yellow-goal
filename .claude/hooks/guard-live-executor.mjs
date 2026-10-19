#!/usr/bin/env node
// PreToolUse guard: blocks the real-spend entry points that CLAUDE.md reserves
// for a human operator (npm run runner, run approve, and the claude-code /
// agx-claude-code executors). Exit 2 blocks the call and shows stderr to Claude.
//
// The command is tokenized with shell quoting rules and split on control
// operators, so only the word that actually runs is inspected: `git commit -m
// "npm run runner"` or `grep "run approve" docs/` pass, while wrappers (env,
// time, nohup, sudo, xargs, bash -c "...") and path-qualified launchers
// (/usr/bin/npm, node_modules/.bin/tsx) are unwrapped and checked. Node is
// required by every command this guards, so it is always available here.
//
// Scope: this is a guardrail against accidental real-spend runs, not a sandbox.
// A determined command can still evade a shell tokenizer, and deliberate
// bypasses are out of scope; the settings.json deny rules and the rule in
// CLAUDE.md remain the primary control.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'tsx', 'node', 'goal-gen', 'goal-gen.mjs']);
const WRAPPERS = new Set(['env', 'time', 'nohup', 'command', 'exec', 'sudo', 'doas', 'runuser', 'nice', 'ionice', 'chrt', 'taskset', 'setsid', 'flock', 'unshare', 'nsenter', 'chroot', 'strace', 'ltrace', 'su', 'script', 'xargs', 'builtin', 'stdbuf', 'timeout', 'watch']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const INTERPRETERS = new Set(['node', 'tsx', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl']);
// npm's script runner, its documented aliases (`npm run --help`) and the
// abbreviations npm also accepts (run-s, run-scr ...).
const RUN = { has: (w) => /^(run(-s(c(r(i(pt?)?)?)?)?)?|rum|urn)$/.test(w) };
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', '}', '!', 'time']);

// Decode the body of a Bash ANSI-C quoted string ($'...').
const C_ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function ansiC(body) {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/gs, (m, e) => {
    if (/^[xuU]/.test(e)) {
      const cp = parseInt(e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'c') return String.fromCharCode(e.charCodeAt(1) & 31);
    return C_ESC[e] ?? m;
  });
}

// Stands in for the value of a command substitution or parameter expansion,
// which the guard cannot know.
const SUBST = '\u0000';

// Nested commands (substitutions, eval, sh -c, npx …) are checked recursively.
// Past this depth the guard throws, and the error handler blocks the call.
const MAX_DEPTH = 6;
function nest(depth) {
  if (depth >= MAX_DEPTH) throw new Error('commands nest too deeply to check');
  return depth + 1;
}

// Return [body, index of the closing character] for the $( or ` at i.
function substitution(line, i) {
  if (line[i] === '`') {
    // Inside backticks, \` \$ and \\ are escapes; an escaped backtick nests.
    let body = '';
    let j = i + 1;
    for (; j < line.length && line[j] !== '`'; j++) {
      if (line[j] === '\\' && '`$\\'.includes(line[j + 1] ?? '')) body += line[++j];
      else body += line[j];
    }
    return [body, j];
  }
  // Quotes and escapes inside $( ... ) hide their parentheses.
  let depth = 0;
  let j = i + 1;
  for (; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') j++;
    else if (c === "'") {
      const k = line.indexOf("'", j + 1);
      j = k < 0 ? line.length : k;
    } else if (c === '"') {
      for (j++; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\') j++;
        else if (line[j] === '$' && line[j + 1] === '(') j = substitution(line, j)[1];
      }
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  return [line.slice(i + 2, j), j];
}

// Return the index of the last character of a parameter expansion ($VAR,
// ${VAR}, $1, $@ ...) starting at i, or -1 when the $ is literal.
function parameter(line, i) {
  const n = line[i + 1] ?? '';
  if (n === '{') {
    const j = line.indexOf('}', i + 2);
    return j < 0 ? line.length - 1 : j;
  }
  if (/[A-Za-z_]/.test(n)) {
    let j = i + 1;
    while (/\w/.test(line[j + 1] ?? '')) j++;
    return j;
  }
  return /[0-9@*#?!$-]/.test(n) ? i + 1 : -1;
}

// Split a command line into simple commands (arrays of words), honouring
// comments, single quotes, ANSI-C quotes, double quotes and backslash escapes.
// Command substitutions are parsed as commands of their own and leave SUBST
// in the word they expand into.
function parse(line, depth = 0) {
  const commands = [];
  const nested = [];
  let words = [];
  let word = null;
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const isSubst = (k) => line[k] === '`' || (line[k] === '$' && line[k + 1] === '(');
  const heredocs = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      // A heredoc: remember its delimiter; its body starts after this line.
      let j = i + 2;
      const strip = line[j] === '-';
      if (strip) j++;
      while (line[j] === ' ' || line[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      for (; j < line.length && !/[\s;&|()<>]/.test(line[j]); j++) {
        if (line[j] === "'" || line[j] === '"') {
          const k = line.indexOf(line[j], j + 1);
          delim += line.slice(j + 1, k < 0 ? line.length : k);
          quoted = true;
          j = k < 0 ? line.length : k;
        } else if (line[j] === '\\') {
          quoted = true;
          delim += line[++j] ?? '';
        } else delim += line[j];
      }
      if (delim) heredocs.push({ delim, strip, quoted, cmd: words });
      i = j - 1;
    } else if (c === '#' && word === null) {
      // A comment runs to the end of the line.
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
    } else if (c === '$' && line[i + 1] === "'") {
      let j = i + 2;
      while (j < line.length && line[j] !== "'") j += line[j] === '\\' ? 2 : 1;
      word = (word ?? '') + ansiC(line.slice(i + 2, Math.min(j, line.length)));
      i = j;
    } else if (c === '$' && line[i + 1] === '"') {
      // $"..." is a locale-translated double-quoted string; drop the $.
    } else if (c === "'") {
      const j = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, j < 0 ? line.length : j);
      i = j < 0 ? line.length : j;
    } else if (c === '"') {
      let s = '';
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length) {
          // Inside double quotes a backslash escapes only these; \<newline> vanishes.
          const n = line[i + 1];
          if (n === '\n') i++;
          else if ('$`"\\'.includes(n)) s += line[++i];
          else s += '\\';
        } else if (line[i] === '$' && parameter(line, i) >= 0) {
          s += SUBST;
          i = parameter(line, i);
        } else if (isSubst(i)) {
          const [body, j] = substitution(line, i);
          nested.push(body);
          s += SUBST;
          i = j;
        } else s += line[i];
      }
      word = (word ?? '') + s;
    } else if (isSubst(i)) {
      const [body, j] = substitution(line, i);
      nested.push(body);
      word = (word ?? '') + SUBST;
      i = j;
    } else if (c === '$' && parameter(line, i) >= 0) {
      word = (word ?? '') + SUBST;
      i = parameter(line, i);
    } else if (c === '\\' && i + 1 < line.length) {
      // A backslash-newline is a line continuation and disappears.
      if (line[i + 1] === '\n') i++;
      else word = (word ?? '') + line[++i];
    } else if (/\s/.test(c)) {
      if (c !== '\n') endWord();
      else {
        endCommand();
        // Heredoc bodies are data, not commands; only an unquoted body's
        // substitutions run.
        for (const h of heredocs.splice(0)) {
          const body = [];
          let start = i + 1;
          while (start <= line.length) {
            const nl = line.indexOf('\n', start);
            const end = nl < 0 ? line.length : nl;
            const text = line.slice(start, end);
            i = end;
            if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) break;
            body.push(text);
            if (!h.quoted) {
              for (let k = 0; k < text.length; k++) {
                if (text[k] === '`' || (text[k] === '$' && text[k + 1] === '(')) {
                  const [body, e] = substitution(text, k);
                  nested.push(body);
                  k = e;
                }
              }
            }
            start = end + 1;
          }
          // Kept on the command so a shell reading it as stdin can be checked.
          (h.cmd.heredocs ??= []).push(body.join('\n'));
        }
      }
    } else if (';&|()'.includes(c)) {
      endCommand();
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand();
  // Command substitutions still run; check them too.
  for (const sub of nested) commands.push(...parse(sub, nest(depth)));
  return commands;
}

const base = (w) => w.split('/').pop();

// A shell script run by the command is checked as commands of its own. One the
// guard cannot read yet (written earlier in the same command) is blocked.
let cwd = process.cwd();

// The guard cannot follow JavaScript, Python, Ruby or Perl, so a script that
// names a guarded entry point as a string ('runner', 'approve', claude-code,
// runner.ts) is blocked, and so is one it cannot read yet.
const NAMES_ENTRY = /(['"`])(runner|approve)\1|run\s+approve|claude-code|runner\.ts/;
// Inline code that can start a process or names a guarded word.
const SPAWNS = /child_process|\bspawn|\bexec|\bfork|\bsystem\b|subprocess|\bpopen|`|runner|approve|claude-code|process\.binding|\bimport\s*\(/;
function checkNodeScript(path) {
  if (path.includes(SUBST)) return 'the script path comes from an expansion the guard cannot check';
  if (/^\/(dev\/(stdin|fd\/)|proc\/self\/fd\/)/.test(path)) return `${path} is input the guard cannot check`;
  let text;
  try {
    text = readFileSync(resolve(cwd, path), 'utf8');
  } catch {
    return `the guard cannot read ${path} yet; write the script in one call and run it in another`;
  }
  if (NAMES_ENTRY.test(text)) {
    return `${path} names a real-spend entry point (runner, approve or claude-code)`;
  }
  return null;
}
function checkScript(path, checkLine, executable = false) {
  if (path.includes(SUBST)) return 'the script path comes from an expansion the guard cannot check';
  // /dev/stdin and descriptors are the command's future input, not a file the
  // guard can read now.
  if (/^\/(dev\/(stdin|fd\/)|proc\/self\/fd\/)/.test(path)) return `${path} is input the guard cannot check`;
  let text;
  try {
    text = readFileSync(resolve(cwd, path), 'utf8');
  } catch {
    return `the guard cannot read ${path} yet; write the script in one call and run it in another`;
  }
  // An executable with a non-shell interpreter (#!/usr/bin/env node) is not
  // shell code; the launcher checks do not apply to it.
  if (text.includes('\u0000')) return null; // a binary, not a script
  // The shebang line is tokenized with shell quoting (#!/usr/bin/env -S 'bash'
  // -e). Only a known non-shell interpreter with no shell named is exempt.
  const shebang = text.match(/^#!([^\n]*)/);
  if (executable && shebang) {
    const words = parse(shebang[1]).flat().map((w) => base(w.replace(/^-S/, '')));
    if (!words.some((w) => SHELLS.has(w)) && words.some((w) => INTERPRETERS.has(w))) return null;
  }
  return checkLine(text);
}

// Bash expands unquoted braces before the command starts (run{n,}er becomes
// runner runer). The quotes are gone by now, so quoted braces expand too; that
// only adds words to check.
function braces(word, depth = 0) {
  if (depth > 4) return [word];
  for (let i = word.indexOf('{'); i >= 0; i = word.indexOf('{', i + 1)) {
    let level = 0;
    const parts = [];
    let from = i + 1;
    let j = i;
    for (; j < word.length; j++) {
      if (word[j] === '{') level++;
      else if (word[j] === '}' && --level === 0) break;
      else if (word[j] === ',' && level === 1) { parts.push(word.slice(from, j)); from = j + 1; }
    }
    if (j >= word.length) break;
    const head = word.slice(0, i);
    const tail = word.slice(j + 1);
    let items = null;
    if (parts.length) items = [...parts, word.slice(from, j)];
    else {
      const m = word.slice(i + 1, j).match(/^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/);
      if (m) {
        const num = /\d/.test(m[1]);
        const a = num ? Number(m[1]) : m[1].charCodeAt(0);
        const b = num ? Number(m[2]) : m[2].charCodeAt(0);
        if (Math.abs(b - a) > 256) return [word];
        items = [];
        for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) items.push(num ? String(v) : String.fromCharCode(v));
      }
    }
    if (items) return items.flatMap((x) => braces(head + x + tail, depth + 1));
  }
  return [word];
}

// Redirections can sit anywhere in a simple command, including before its name
// (>/dev/null npm …). Drop them and the operand of a bare operator.
const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>|&>|>>|>\||>&|<&|<<<|<<-|<<|<>|>|<)(.*)$/s;
function stripRedirects(words) {
  const out = [];
  out.heredocs = words.heredocs;
  for (let k = 0; k < words.length; k++) {
    const m = REDIRECT.exec(words[k]);
    if (!m) out.push(words[k]);
    else if (m[1] === '') k++;
  }
  return out;
}

function check(words, depth = 0) {
  words = stripRedirects(words);
  let i = 0;
  // Skip shell reserved words (then npm …, do npm …, { npm …, ! npm …).
  // `time -p pipeline`: the keyword takes its own options.
  // `function name { body; }`: the body's first command follows the brace.
  while (i < words.length && (KEYWORDS.has(words[i]) || words[i] === 'function' || words[i - 1] === 'function' || (words[i - 1] === 'time' && /^-/.test(words[i])))) i++;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  // Wrappers take flags with values (env -u VAR, sudo -u user, nice -n 10,
  // timeout -s KILL 10), so skip to the first launcher, shell or eval after
  // one instead of parsing each wrapper's flags.
  if (i < words.length && WRAPPERS.has(base(words[i]))) {
    // command -v / -V only looks a name up.
    if (words[i] === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) return null;
    // env -S / --split-string splits its value into further arguments.
    const k = words.findIndex((w, n) => n > i && /^(-S|--split-string)/.test(w));
    if (base(words[i]) === 'env' && k >= 0) {
      const m = words[k].match(/^(?:-S|--split-string=?)(.*)$/s);
      const value = m[1] !== '' ? m[1] : (words[k + 1] ?? '');
      const rest = words.slice(m[1] !== '' ? k + 1 : k + 2);
      for (const sub of parse(value)) {
        const r = check([...sub, ...rest], nest(depth));
        if (r) return r;
      }
    }
    // Many wrappers run a command string through the shell (flock -c, runuser
    // -c, su -c, script -c, watch 'cmd'). Any argument that holds more than one
    // word, including an --option=value, is checked as a command line.
    for (let k = i + 1; k < words.length; k++) {
      const value = words[k].replace(/^--?[A-Za-z-]+=/, '');
      if (!/\s/.test(value.trim())) continue;
      for (const sub of parse(value)) {
        const r = check(sub, nest(depth));
        if (r) return r;
      }
    }
    const j = words.findIndex((w, k) => k > i && (LAUNCHERS.has(base(w)) || SHELLS.has(base(w)) || INTERPRETERS.has(base(w)) || ['eval', 'source', '.'].includes(w)));
    if (j < 0) return null;
    // xargs appends words read from stdin, which the guard cannot see.
    if (words.slice(i, j).some((w) => base(w) === 'xargs')) {
      if (SHELLS.has(base(words[j])) || words[j] === 'eval') {
        return 'xargs feeds stdin to a shell, which the guard cannot check';
      }
      return check([...words.slice(j), SUBST], depth);
    }
    i = j;
  }
  const checkLine = (line) => {
    for (const sub of parse(line)) {
      const r = check(sub, nest(depth));
      if (r) return r;
    }
    return null;
  };
  // A non-interactive shell runs the file BASH_ENV (or ENV for sh) names
  // before its command, so that file is checked wherever the variable is set.
  const startup = words.slice(0, i < words.length && ['export', 'declare', 'typeset', 'readonly', 'local'].includes(words[i]) ? words.length : i);
  for (const w of startup) {
    const m = w.match(/^(?:BASH_ENV|ENV)=(.+)$/s);
    if (!m) continue;
    const r = checkScript(m[1], checkLine);
    if (r) return r;
  }
  if (i >= words.length) return null;
  const cmd = base(words[i]);
  const args = words.slice(i + 1).flatMap((w) => braces(w));
  if (cmd === 'eval') return checkLine(args.join(' '));
  if (SHELLS.has(cmd)) {
    // --rcfile / --init-file run before the command string.
    for (let k = 0; k < args.length; k++) {
      const m = args[k].match(/^--(?:rcfile|init-file)(?:=(.*))?$/s);
      if (!m) continue;
      const r = checkScript(m[1] ?? args[k + 1] ?? '', checkLine);
      if (r) return r;
    }
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    // bash -c -- 'cmd': the option terminator comes before the command string.
    const cv = args[c + 1] === '--' ? c + 2 : c + 1;
    if (c >= 0 && args[cv] !== undefined) return checkLine(args[cv]);
    if (c >= 0) return 'sh -c has no command to check';
    const script = args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
    // Without a script operand (or with -s, /dev/stdin, /dev/fd/N) the shell
    // runs its stdin. A heredoc body can be checked; a pipe or file cannot.
    if (script === undefined || /^\/dev\/(stdin|fd\/\d+)$/.test(script) || args.some((a) => /^-[A-Za-z]*s[A-Za-z]*$/.test(a))) {
      if (!words.heredocs?.length) {
        return 'the shell reads commands from stdin, which the guard cannot check; use -c "..."';
      }
      for (const body of words.heredocs) {
        const r = checkLine(body);
        if (r) return r;
      }
      return null;
    }
    return checkScript(script, checkLine);
  }
  if ((cmd === 'source' || cmd === '.') && args[0] !== undefined) return checkScript(args[0], checkLine);
  // A path-qualified command that is not a launcher may be a shell script.
  if (words[i].includes('/') && !LAUNCHERS.has(cmd)) return checkScript(words[i], checkLine, true);
  if (cmd.includes(SUBST)) {
    return 'the command name comes from an expansion the guard cannot check; spell it out';
  }
  // find -exec/-execdir/-ok/-okdir run a command per match, up to ; or +.
  if (cmd === 'find') {
    for (let k = 0; k < args.length; k++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[k])) continue;
      const end = args.findIndex((a, n) => n > k && (a === ';' || a === '+'));
      const sub = args.slice(k + 1, end < 0 ? args.length : end).map((a) => (a.includes('{}') ? SUBST : a));
      const r = check(sub, nest(depth));
      if (r) return r;
    }
    return null;
  }
  // Python, Ruby, Perl, Deno and Bun run inline code (-c, -e) or a script file.
  if (INTERPRETERS.has(cmd.replace(/[\d.]+$/, '')) && !LAUNCHERS.has(cmd)) {
    const flag = /^python/.test(cmd) ? /^-[A-Za-z]*c[A-Za-z]*$/ : /^(-[A-Za-z]*[eE][A-Za-z]*|--eval|eval)(=|$)/;
    const e = args.findIndex((a) => flag.test(a));
    if (e >= 0) {
      const code = args[e].includes('=') ? args[e].slice(args[e].indexOf('=') + 1) : (args[e + 1] ?? '');
      if (code.includes(SUBST) || SPAWNS.test(code)) {
        return `inline ${cmd} code that can start a process is not checked; put it in a script file`;
      }
      return null;
    }
    // python -m mod runs mod.py or mod/__main__.py; a local one is checked.
    const m = args.indexOf('-m');
    if (m >= 0) {
      const mod = (args[m + 1] ?? '').replace(/\./g, '/');
      for (const path of [`${mod}.py`, `${mod}/__main__.py`]) {
        try { readFileSync(resolve(cwd, path)); } catch { continue; }
        return checkNodeScript(path);
      }
      return null;
    }
    const script = args.find((a) => !a.startsWith('-') && a !== 'run');
    if (script === undefined || args.includes('-')) {
      if (!words.heredocs?.length) {
        return args.some((a) => /^(-V|--version|-h|--help)$/.test(a)) ? null : `${cmd} with no script runs code from stdin, which the guard cannot check`;
      }
      return words.heredocs.some((b) => NAMES_ENTRY.test(b)) ? `${cmd} code on stdin names a real-spend entry point` : null;
    }
    return checkNodeScript(script);
  }
  if (!LAUNCHERS.has(cmd)) return null;
  // An expanded word could become `runner`, `approve` or `claude-code`; a path
  // built from one ("$(git rev-parse --show-toplevel)/goal-gen") cannot. After
  // `--` only the words the checks below look at matter.
  const unknown = (a) => a.includes(SUBST) && !a.includes('/');
  // A `--` before the subcommand (npm -- run runner) only ends npm's options.
  while (args[0] === '--') args.shift();
  const sep = args.indexOf('--');
  const after = sep < 0 ? [] : args.slice(sep + 1);
  if ((sep < 0 ? args : args.slice(0, sep)).some(unknown) ||
      after.some((a, k) => unknown(a) && (after[k - 1] === 'run' || after[k - 1] === '--executor' || a.startsWith('--executor')))) {
    return 'a launcher argument comes from an expansion the guard cannot check; spell it out';
  }
  // npm exec -c / npx -c / --call run their value as a shell command.
  if (cmd === 'npm' || cmd === 'npx') {
    for (let k = 0; k < args.length; k++) {
      const m = args[k].match(/^(?:-c|--call)(?:=(.*))?$/s);
      if (!m) continue;
      const value = m[1] ?? args[k + 1];
      if (value === undefined) return 'npm exec -c has no command to check';
      const r = checkLine(value);
      if (r) return r;
    }
  }
  // node/tsx -e/-p run inline code, and with no script they run stdin. The
  // guard cannot follow JavaScript, so inline code that can start a process or
  // names a guarded word is blocked.
  if (cmd === 'node' || cmd === 'tsx') {
    // Preloads (--require, --import, loaders) run before the main code; a
    // local file is checked like a script. Package names are left alone.
    for (let k = 0; k < args.length; k++) {
      const m = args[k].match(/^(?:-r|--require|--import|--loader|--experimental-loader)(?:=(.*))?$/s);
      if (!m) continue;
      const value = m[1] ?? args[k + 1] ?? '';
      if (/^(\.{1,2}\/|\/|file:)|\.[cm]?[jt]s$/.test(value)) {
        const r = checkNodeScript(value.replace(/^file:\/\//, ''));
        if (r) return r;
      }
    }
    const e = args.findIndex((a) => /^(-[A-Za-z]*[ep][A-Za-z]*|--eval|--print)(=|$)/.test(a));
    if (e >= 0) {
      const code = args[e].includes('=') ? args[e].slice(args[e].indexOf('=') + 1) : (args[e + 1] ?? '');
      if (code.includes(SUBST) || /child_process|\bspawn|\bexec|\bfork|runner|approve|claude-code|process\.binding|\bimport\s*\(/.test(code)) {
        return 'inline node code that can start a process is not checked; put it in a script file';
      }
    } else {
      // The script operand: the first word that is not an option or an
      // option's value (tsx watch file.ts names the file after `watch`).
      let script;
      for (let k = 0; k < args.length; k++) {
        if (/^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file|--tsconfig)$/.test(args[k])) k++;
        else if (!args[k].startsWith('-') && !(cmd === 'tsx' && args[k] === 'watch')) { script = args[k]; break; }
      }
      if (script === undefined) {
        if (!args.some((a) => /^(-v|--version|-h|--help|--test|--run)(=|$)/.test(a))) {
          return 'node with no script runs code from stdin, which the guard cannot check';
        }
      } else {
        const r = checkNodeScript(script);
        if (r) return r;
      }
    }
  }
  // Flag values (--prefix dir, -w pkg, -C dir, --filter pkg) stay in the
  // positional list, so match words anywhere rather than adjacent pairs.
  // The script name comes before `--`; what follows goes to the script.
  const positional = args.filter((a) => !a.startsWith('-'));
  const dd = args.indexOf('--');
  const script = (dd < 0 ? args : args.slice(0, dd)).filter((a) => !a.startsWith('-'));
  // A glob in the subcommand position (npm r?n runner) can expand to `run`.
  if (['npm', 'pnpm', 'yarn'].includes(cmd) && /[*?[]/.test(script[0] ?? '')) {
    return 'the npm subcommand is a glob the guard cannot resolve; spell it out';
  }
  let r = script.findIndex((a) => RUN.has(a));
  // npm run -- runner: with no script before `--`, the next word is the script.
  if (r >= 0 && r === script.length - 1 && dd >= 0 && args[dd + 1] !== undefined) script.push(args[dd + 1]);
  // A glob (run?er) can expand to a file named after a guarded script.
  if (r >= 0 && /[*?[]/.test(script[r + 1] ?? '')) {
    return 'the script name is a glob the guard cannot resolve; spell it out';
  }
  if (script.slice(r + 1).includes('runner') && (r >= 0 || cmd === 'pnpm' || cmd === 'yarn')) {
    return 'the M1 runner (npm run runner) can invoke real claude -p';
  }
  const a = positional.indexOf('run');
  if (a >= 0 && positional.slice(a + 1).includes('approve')) {
    return 'run approve mints a real-run approval and is human-only';
  }
  if (args.some((a) => /(^|\/)backend\/src\/runner\.ts$/.test(a))) {
    return 'the M1 runner (backend/src/runner.ts) can invoke real claude -p';
  }
  for (let k = 0; k < args.length; k++) {
    const v = args[k] === '--executor' ? args[k + 1] : args[k].startsWith('--executor=') ? args[k].slice(11) : null;
    if (v === 'claude-code' || v === 'agx-claude-code') {
      return 'the claude-code and agx-claude-code executors are real spend';
    }
  }
  // npx/npm exec (with or without `--`) can launch another launcher.
  for (let k = 0; k < args.length; k++) {
    if (!LAUNCHERS.has(base(args[k]))) continue;
    const r = check(args.slice(k), nest(depth));
    if (r) return r;
  }
  return null;
}

let command = '';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  command = input?.tool_input?.command ?? '';
  if (typeof input?.cwd === 'string') cwd = input.cwd;
} catch {
  process.exit(0);
}
// Any other exit code lets the command run, so an internal error blocks.
let reason = null;
try {
  for (const words of parse(String(command))) {
    reason = check(words);
    if (reason) break;
  }
} catch (err) {
  reason = `the guard could not parse this command (${err?.message ?? err})`;
}
if (reason) {
  process.stderr.write(`Blocked: ${reason}. Real-spend commands are human-only (goal-gen/CLAUDE.md). Use --executor stub for tests.\n`);
  process.exit(2);
}
process.exit(0);
