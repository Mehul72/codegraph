/**
 * Node version gate plus warning cleanup. node:sqlite is still flagged
 * experimental, and its warning would otherwise show up in the middle of
 * every command's output.
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 5;

export function requiredNodeVersion(): string {
  return `${MIN_MAJOR}.${MIN_MINOR}.0`;
}

export function checkNodeVersion(): void {
  const [majorStr = '0', minorStr = '0'] = process.versions.node.split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const tooOld = major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR);
  if (!tooOld) return;

  process.stderr.write(
    [
      `codegraph needs Node ${requiredNodeVersion()} or newer, this is Node ${process.versions.node}.`,
      '',
      'It uses the built-in node:sqlite module, which older releases do not have.',
      'Upgrade Node (nvm install 22, or https://nodejs.org) and try again.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export function silenceExperimentalWarnings(): void {
  const original = process.emitWarning.bind(process);
  // The signature is overloaded, so keep it loose and hand the rest straight back.
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : String((warning as Error)?.message ?? '');
    const type = typeof rest[0] === 'string' ? (rest[0] as string) : (rest[0] as { type?: string })?.type;
    if (type === 'ExperimentalWarning' && /SQLite|sqlite/.test(text)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
