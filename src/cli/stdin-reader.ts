// Stdin reading utility extracted from hook patterns
// See src/hooks/save-hook.ts for the original pattern
//
// IMPORTANT: This function must properly clean up stdin listeners to prevent
// "ghost stdin listener" bugs when the same process handles multiple hooks
// or when switching between remote and local modes in Claude Code.

export async function readJsonFromStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let input = '';

    // Named handlers so we can remove them after use
    const onData = (chunk: Buffer | string) => {
      input += chunk;
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    const onEnd = () => {
      cleanup();
      try {
        resolve(input.trim() ? JSON.parse(input) : undefined);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Stdin read error: ${err.message}`));
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}
