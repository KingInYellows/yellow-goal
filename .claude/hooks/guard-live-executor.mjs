#!/usr/bin/env node
// PreToolUse guard: blocks the real-spend entry points that CLAUDE.md reserves
// for a human operator (npm run runner, run approve, and the claude-code /
// agx-claude-code executors). Exit 2 blocks the call and shows stderr to Claude.
//
// One quote-aware scan, then those four predicates. The scan does not read
// files, decode ANSI-C quotes, or expand braces.
//
// Scope: this is a guardrail against accidental real-spend runs, not a sandbox.
// A determined command can still evade a shell tokenizer, and deliberate
// bypasses are out of scope; the settings.json deny rules and the rule in
// CLAUDE.md remain the primary control.
import { readFileSync } from 'node:fs';

const LAUNCHERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'tsx', 'node', 'goal-gen', 'goal-gen.mjs']);
const WRAPPERS = new Set(['env', 'sudo', 'timeout', 'nohup', 'command']);
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', '}', '!', 'function']);
const INERT = new Set(['echo', 'grep', 'git']);
const SHELLS = new Set(['sh', 'bash']);
const REAL_EXECUTORS = new Set(['claude-code', 'agx-claude-code']);
const TAKES = new Set(['--prefix', '-w', '--workspace', '--filter', '--cwd', '-C', '--dir', '--executor']);
const EXECUTOR_EQ = '--executor=';
const RUNNER_SUFFIX = 'backend/src/runner.ts';
const RUN = /^(run(-s(c(r(i(pt?)?)?)?)?)?|rum|urn)$/;

const RUNNER = 'the M1 runner (npm run runner) can invoke real claude -p';
const APPROVE = 'run approve mints a real-run approval and is human-only';
const EXECUTOR = 'the claude-code and agx-claude-code executors are real spend';
const RUNNER_TS = 'the M1 runner (backend/src/runner.ts) can invoke real claude -p';
const UNENTERED = 'a forbidden literal sits in text the guard did not enter';

function base(word) {
  const slash = word.lastIndexOf('/');
  return slash < 0 ? word : word.slice(slash + 1);
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isFlag(word) {
  return word.startsWith('-') && word !== '-' && word !== '--';
}

function forbiddenIn(text) {
  for (const word of text.split(/[\s"'`;|&()<>]+/)) {
    if (!word) continue;
    if (word === 'runner' || word === 'approve' || REAL_EXECUTORS.has(word)) return UNENTERED;
    if (word.startsWith(EXECUTOR_EQ) && REAL_EXECUTORS.has(word.slice(EXECUTOR_EQ.length))) return UNENTERED;
    if (word.endsWith(RUNNER_SUFFIX)) return UNENTERED;
  }
  return null;
}

function stripPrefix(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (isAssignment(word)) {
      i++;
      continue;
    }
    if (word === 'time') {
      i++;
      if (words[i] === '-p') i++;
      continue;
    }
    if (RESERVED.has(word)) {
      i++;
      continue;
    }
    const name = base(word);
    if (!WRAPPERS.has(name)) break;
    const skipped = skipWrapper(name, words, i);
    if (skipped.allow) return { allow: true, rest: [] };
    i = skipped.index;
  }
  return { allow: false, rest: words.slice(i) };
}

// Wrapper options that take the next word as their argument.
const SUDO_TAKES = new Set([
  '-u', '--user', '-g', '--group', '-h', '--host', '-D', '--chdir',
  '-C', '--close-from', '-p', '--prompt', '-U', '--other-user',
  '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-R', '--chroot',
]);
const ENV_TAKES = new Set(['-u', '--unset', '-C', '--chdir', '-P']);

// Words a sudo flag spans. In a short cluster the first value-taking letter
// takes the rest of the cluster (`-uroot`) or, at the end, the next word
// (`-Eu me`).
function sudoFlagWidth(flag) {
  if (!/^-[A-Za-z]+$/.test(flag)) return SUDO_TAKES.has(flag) ? 2 : 1;
  for (let k = 1; k < flag.length; k++) {
    if (SUDO_TAKES.has(`-${flag[k]}`)) return k === flag.length - 1 ? 2 : 1;
  }
  return 1;
}

function skipWrapper(name, words, index) {
  let i = index + 1;
  if (name === 'command') {
    let allow = false;
    while (i < words.length && isFlag(words[i])) {
      if (words[i] === '-v' || words[i] === '-V') allow = true;
      i++;
    }
    if (words[i] === '--') i++;
    return allow ? { allow: true } : { index: i };
  }
  if (name === 'nohup') {
    while (i < words.length && isFlag(words[i])) i++;
    if (words[i] === '--') i++;
    return { index: i };
  }
  if (name === 'sudo') {
    while (i < words.length && (isFlag(words[i]) || words[i] === '--')) {
      const flag = words[i];
      if (flag === '--') {
        i++;
        break;
      }
      i += sudoFlagWidth(flag);
    }
    return { index: i };
  }
  if (name === 'env') {
    while (i < words.length) {
      const flag = words[i];
      if (isAssignment(flag)) {
        i++;
        continue;
      }
      if (ENV_TAKES.has(flag)) {
        i += 2;
        continue;
      }
      if (isFlag(flag) || flag === '--') {
        i++;
        if (flag === '--') break;
        continue;
      }
      break;
    }
    return { index: i };
  }
  if (name !== 'timeout') return { index: i };
  // Flags, the argument of -s/--signal/-k/--kill-after, then one duration.
  while (i < words.length && (isFlag(words[i]) || words[i] === '--')) {
    const flag = words[i];
    if (flag === '--') {
      i++;
      break;
    }
    i += flag === '-s' || flag === '--signal' || flag === '-k' || flag === '--kill-after' ? 2 : 1;
  }
  if (i < words.length) i++;
  return { index: i };
}

function optionSkip(word) {
  if (TAKES.has(word)) return 2;
  if (word.startsWith('--') && word.includes('=')) return 1;
  if (isFlag(word)) return 1;
  return 0;
}

function scriptIsRunner(args, implicit) {
  let seenSub = implicit;
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!seenSub && word === '--') continue;
    if (word === '--') {
      if (positionals.length > 0) return positionals.includes('runner');
      for (i += 1; i < args.length; i++) {
        const next = args[i];
        const skip = optionSkip(next);
        if (skip === 2) {
          i++;
          continue;
        }
        if (skip === 1) continue;
        return next === 'runner';
      }
      return false;
    }
    const skip = optionSkip(word);
    if (skip === 2) {
      i++;
      continue;
    }
    if (skip === 1) continue;
    if (!seenSub) {
      if (!RUN.test(word)) return false;
      seenSub = true;
      continue;
    }
    positionals.push(word);
  }
  return positionals.includes('runner');
}

function approveLater(args) {
  let seenRun = false;
  for (const word of args) {
    if (word === 'run') seenRun = true;
    else if (seenRun && word === 'approve') return true;
  }
  return false;
}

function badExecutor(args) {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const value = word === '--executor' ? args[i + 1] : word.startsWith(EXECUTOR_EQ) ? word.slice(EXECUTOR_EQ.length) : null;
    if (REAL_EXECUTORS.has(value)) return true;
  }
  return false;
}

function runnerSource(args) {
  return args.some((word) => word.endsWith(RUNNER_SUFFIX));
}

function nestedLauncher(words) {
  let started = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!started && word === '--') continue;
    const skip = optionSkip(word);
    if (skip === 2) {
      i++;
      continue;
    }
    if (skip === 1) continue;
    started = true;
    if (LAUNCHERS.has(base(word))) return words.slice(i);
    return null;
  }
  return null;
}

function launcherReason(words) {
  const name = base(words[0]);
  const args = words.slice(1);
  if (runnerSource(args)) return RUNNER_TS;
  if (badExecutor(args)) return EXECUTOR;
  if (approveLater(args)) return APPROVE;
  if (scriptIsRunner(args, false)) return RUNNER;
  if ((name === 'pnpm' || name === 'yarn') && scriptIsRunner(args, true)) return RUNNER;
  const nested = nestedLauncher(words);
  if (nested && nested.length < words.length) return launcherReason(nested);
  return null;
}

function shellPayload(words) {
  let sawC = false;
  let i = 1;
  for (; i < words.length; i++) {
    const word = words[i];
    if (!isFlag(word) && !/^\+[^+]/.test(word)) break;
    if (/^-[^-]*c/.test(word)) sawC = true;
    // `-o pipefail`, `-euo pipefail`, `+O extglob` and `--rcfile f` take
    // the next word.
    if (/^[-+][^-]*[oO]$/.test(word) || word === '--rcfile' || word === '--init-file') i++;
  }
  if (!sawC) return null;
  if (words[i] === '--') i++;
  return words[i] ?? null;
}

function finish(words, depth) {
  const stripped = stripPrefix(words);
  if (stripped.allow) return null;
  const rest = stripped.rest;
  if (rest.length === 0) return null;
  const name = base(rest[0]);
  if (INERT.has(name)) return null;
  if (name === 'eval') return reenter(rest.slice(1).join(' '), depth);
  if (SHELLS.has(name)) {
    const payload = shellPayload(rest);
    if (payload == null) return null;
    return reenter(payload, depth);
  }
  if (LAUNCHERS.has(name)) return launcherReason(rest);
  return null;
}

function reenter(text, depth) {
  if (depth >= 1) return forbiddenIn(text);
  return walk(text, depth + 1);
}

function walk(input, depth) {
  let i = 0;
  let words = [];
  const pending = [];

  function takeSub(body) {
    return reenter(body, depth);
  }

  function extractDollar(text, at) {
    let j = at + 2;
    let nest = 1;
    let quote = null;
    const start = j;
    // Heredocs opened inside the substitution: their bodies are data, so an
    // apostrophe in `don't` must not open a quote.
    const bodies = [];
    while (j < text.length && nest > 0) {
      const c = text[j];
      if (!quote && c === '<' && text[j + 1] === '<' && text[j + 2] !== '<') {
        const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;|&()<>]+))/.exec(text.slice(j));
        if (m) {
          bodies.push({ delim: m[2] ?? m[3] ?? m[4], dash: m[1] === '-' });
          j += m[0].length;
          continue;
        }
      }
      if (!quote && c === '\n' && bodies.length > 0) {
        j++;
        for (const { delim, dash } of bodies.splice(0)) {
          while (j < text.length) {
            const end = text.indexOf('\n', j);
            const line = text.slice(j, end < 0 ? text.length : end);
            j = end < 0 ? text.length : end + 1;
            if ((dash ? line.replace(/^\t+/, '') : line) === delim) break;
          }
        }
        continue;
      }
      if (quote === "'") {
        if (c === "'") quote = null;
        j++;
        continue;
      }
      if (quote === '"') {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '"') {
          quote = null;
          j++;
          continue;
        }
        // A quoted paren is text; only a nested `$(` inside the quotes nests.
        j = c === '$' && text[j + 1] === '(' ? extractDollar(text, j).end : j + 1;
        continue;
      } else if (c === "'") {
        quote = "'";
        j++;
        continue;
      } else if (c === '"') {
        quote = '"';
        j++;
        continue;
      }
      if (c === '(') nest++;
      else if (c === ')') {
        nest--;
        if (nest === 0) break;
      }
      j++;
    }
    const body = text.slice(start, j);
    if (text[j] === ')') j++;
    return { body, end: j };
  }

  function extractBacktick(text, at) {
    let j = at + 1;
    const start = j;
    while (j < text.length && text[j] !== '`') {
      if (text[j] === '\\') j += 2;
      else j++;
    }
    const body = text.slice(start, j);
    if (text[j] === '`') j++;
    return { body, end: j };
  }

  function readBacktick() {
    const sub = extractBacktick(input, i);
    i = sub.end;
    return sub.body;
  }

  function readWord() {
    let word = '';
    let quote = null;
    while (i < input.length) {
      const c = input[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        else word += c;
        i++;
        continue;
      }
      if (quote === '"') {
        // As in bash: `\`-newline vanishes, `\` before `$`, a backtick, `"`
        // or `\` drops, and any other backslash stays.
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next !== '\n') word += '$`"\\'.includes(next) ? next : c + next;
          i += 2;
          continue;
        }
        if (c === '"') {
          quote = null;
          i++;
          continue;
        }
        if (c === '`') {
          const reason = takeSub(readBacktick());
          if (reason) return { reason };
          continue;
        }
        if (c === '$' && input[i + 1] === '(') {
          const sub = extractDollar(input, i);
          i = sub.end;
          const reason = takeSub(sub.body);
          if (reason) return { reason };
          continue;
        }
        word += c;
        i++;
        continue;
      }
      if (c === '\\' && input[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (c === '\\' && i + 1 < input.length) {
        word += input[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") {
        quote = "'";
        i++;
        continue;
      }
      if (c === '"') {
        quote = '"';
        i++;
        continue;
      }
      if (c === '`') {
        const reason = takeSub(readBacktick());
        if (reason) return { reason };
        continue;
      }
      if (c === '$' && input[i + 1] === '(') {
        const sub = extractDollar(input, i);
        i = sub.end;
        const reason = takeSub(sub.body);
        if (reason) return { reason };
        continue;
      }
      if (/[\s;|&()<>]/.test(c) || (c === '#' && word === '')) break;
      word += c;
      i++;
    }
    return { word };
  }

  function skipSpaces() {
    while (input[i] === ' ' || input[i] === '\t') i++;
  }

  function startHeredoc() {
    i += 2;
    const dash = input[i] === '-';
    if (dash) i++;
    skipSpaces();
    let quoted = false;
    let delim = '';
    if (input[i] === "'" || input[i] === '"') {
      const q = input[i++];
      quoted = true;
      while (i < input.length && input[i] !== q) delim += input[i++];
      if (input[i] === q) i++;
    } else {
      while (i < input.length && !/[\s;|&()<>]/.test(input[i])) {
        if (input[i] === '\\') {
          quoted = true;
          i++;
          if (i < input.length && !/[\s;|&()<>]/.test(input[i])) delim += input[i++];
        } else {
          delim += input[i++];
        }
      }
    }
    pending.push({ delim, quoted, dash });
  }

  function parseRedirect() {
    if (input[i] === '<' && input[i + 1] === '<' && input[i + 2] === '<') {
      i += 3;
      skipSpaces();
      return readWord().reason ?? null;
    }
    if (input[i] === '<' && input[i + 1] === '<') {
      startHeredoc();
      return null;
    }
    // Two-character operators: `>>`, `>&`, `<&`, `<>`, and the clobber `>|`.
    if (/^(?:>[>&|]|<[&>])/.test(input.slice(i, i + 2))) i += 2;
    else i += 1;
    skipSpaces();
    if (i >= input.length || /[\n;|&()]/.test(input[i])) return null;
    return readWord().reason ?? null;
  }

  function consumeHeredocs() {
    for (const heredoc of pending) {
      let body = '';
      while (i < input.length) {
        const end = input.indexOf('\n', i);
        const lineEnd = end < 0 ? input.length : end;
        const line = input.slice(i, lineEnd);
        i = end < 0 ? input.length : end + 1;
        const compare = heredoc.dash ? line.replace(/^\t+/, '') : line;
        if (compare === heredoc.delim) break;
        body += `${line}\n`;
      }
      if (!heredoc.quoted) {
        const reason = visitSubs(body);
        if (reason) return reason;
      }
    }
    pending.length = 0;
    return null;
  }

  // Unquoted heredoc body: quotes are literal text (an apostrophe in `don't`
  // opens nothing), and only a backslash before $ ` \ or newline escapes.
  function visitSubs(text) {
    let j = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        j += /[$`\\\n]/.test(text[j + 1] ?? '') ? 2 : 1;
        continue;
      }
      if (c === '`') {
        const sub = extractBacktick(text, j);
        j = sub.end;
        const reason = takeSub(sub.body);
        if (reason) return reason;
        continue;
      }
      if (c === '$' && text[j + 1] === '(') {
        const sub = extractDollar(text, j);
        j = sub.end;
        const reason = takeSub(sub.body);
        if (reason) return reason;
        continue;
      }
      j++;
    }
    return null;
  }

  function endCommand() {
    const reason = finish(words, depth);
    words = [];
    return reason;
  }

  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\n') {
      i++;
      const heredocReason = consumeHeredocs();
      if (heredocReason) return heredocReason;
      const reason = endCommand();
      if (reason) return reason;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '&' && input[i + 1] === '>') {
      i += 2;
      skipSpaces();
      const target = readWord();
      if (target.reason) return target.reason;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
      i++;
      const reason = endCommand();
      if (reason) return reason;
      continue;
    }
    if (c === '<' || c === '>') {
      const reason = parseRedirect();
      if (reason) return reason;
      continue;
    }
    const before = i;
    const got = readWord();
    if (got.reason) return got.reason;
    const boundary = input[i];
    if (got.word !== '' && /^[0-9]+$/.test(got.word) && (boundary === '<' || boundary === '>')) {
      const reason = parseRedirect();
      if (reason) return reason;
      continue;
    }
    if (got.word !== '') words.push(got.word);
    if (i === before) i++;
  }
  const trailing = consumeHeredocs();
  if (trailing) return trailing;
  return endCommand();
}

let command = '';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  command = String(input?.tool_input?.command ?? '');
  // Extra fields, including a string cwd, are ignored. This hook does not open files.
} catch {
  process.exit(0);
}
let reason = null;
try {
  reason = walk(command, 0);
} catch (err) {
  reason = `the guard could not parse this command (${err?.message ?? err})`;
}
if (reason) {
  process.stderr.write(`Blocked: ${reason}. Real-spend commands are human-only (goal-gen/CLAUDE.md). Use --executor stub for tests.\n`);
  process.exit(2);
}
process.exit(0);
