import { grepArgs, shQuote } from "./utils";

// Shared by Python find and the grep fallback, including subdirectories and
// worktrees whose .git entry is not at the search root.
const SEARCH_FILES = `
import fnmatch, json, os, subprocess, sys
payload = json.load(sys.stdin)
root = payload['root']
def matches(path, pattern):
    if '{' in pattern and '}' in pattern:
        start = pattern.index('{')
        end = pattern.index('}', start)
        return any(matches(path, pattern[:start] + alt + pattern[end+1:]) for alt in pattern[start+1:end].split(','))
    if '/' not in pattern:
        return fnmatch.fnmatchcase(path.rsplit('/', 1)[-1], pattern)
    def parts_match(parts, pats):
        if not pats: return not parts
        if pats[0] == '**':
            return parts_match(parts, pats[1:]) or bool(parts) and parts_match(parts[1:], pats)
        return bool(parts) and fnmatch.fnmatchcase(parts[0], pats[0]) and parts_match(parts[1:], pats[1:])
    return parts_match(path.split('/'), (pattern[2:] if pattern.startswith('./') else pattern).split('/'))
def files(pattern):
    if not os.path.exists(root):
        raise FileNotFoundError(root)
    if os.path.isfile(root):
        return [root] if not pattern or matches(os.path.basename(root), pattern) else []
    candidates = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in {'.git', 'node_modules'})
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            if not pattern or matches(rel, pattern): candidates.append(rel)
    if candidates:
        try:
            proc = subprocess.run(['git', '-C', root, 'check-ignore', '--no-index', '-z', '--stdin'],
                input='\\0'.join(candidates) + '\\0', capture_output=True, text=True)
            if proc.returncode in (0, 1):
                ignored = set(proc.stdout.split('\\0'))
                candidates = [c for c in candidates if c not in ignored]
        except FileNotFoundError:
            pass
    return [os.path.join(root, c) for c in candidates]
`;

export function remoteFindCommand(): string {
	return `python3 -c ${shQuote(`${SEARCH_FILES}
print(json.dumps([os.path.relpath(p, root).replace(os.sep, '/') for p in files(payload['pattern'])][:int(payload['limit'])]))
`)}`;
}

export function remoteGrepCommand(params: { root: string; pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number }): string {
	const args = ["--line-number", "--color=never", "--hidden", "--no-heading", "--glob", "!.git/**", "--glob", "!node_modules/**"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.context && params.context > 0) args.push("--context", String(Math.floor(params.context)));
	if (params.glob) args.push("--glob", params.glob);
	const rg = `rg ${grepArgs([...args, "--", params.pattern, params.root])}`;
	const fallback = `python3 -c ${shQuote(`${SEARCH_FILES}
status = 1
for path in files(payload.get('glob')):
    args = ['grep', '-nHI']
    if payload.get('ignoreCase'): args.append('-i')
    if payload.get('literal'): args.append('-F')
    else: args.append('-E')
    if payload.get('context', 0) > 0: args += ['-C', str(int(payload['context']))]
    proc = subprocess.run(args + ['--', payload['pattern'], path], capture_output=True)
    sys.stdout.buffer.write(proc.stdout)
    sys.stderr.buffer.write(proc.stderr)
    if proc.returncode not in (0, 1): sys.exit(proc.returncode)
    if proc.returncode == 0: status = 0
sys.exit(status)
`)}`;
	return `if command -v rg >/dev/null 2>&1; then ${rg}; else ${fallback}; fi`;
}
