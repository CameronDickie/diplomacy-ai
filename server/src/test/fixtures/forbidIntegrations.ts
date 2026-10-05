// Actual-process showcase smoke guard: importing an optional integration fails startup.
export async function resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => Promise<unknown>): Promise<unknown> {
  if (specifier === 'discord.js' || specifier.startsWith('@discordjs/') || /\/(discord|voice)\//.test(specifier)) {
    throw new Error('INTEGRATION_MODULE_LOADED');
  }
  return next(specifier, context);
}
