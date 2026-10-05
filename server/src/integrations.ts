import type { RuntimeConfig } from '../../config/runtime.cjs';
import type { Power } from '@diplomacy/shared';
import type { GameManager } from './GameManager.js';
import type { DiplomacyService } from './diplomacy/DiplomacyService.js';
import type { DiscordLinkService } from './discord/DiscordLinkService.js';
import type { DiscordBotManager } from './discord/DiscordBotManager.js';
import type { VoiceSessionManager } from './voice/VoiceSessionManager.js';

export interface Integrations {
  links: DiscordLinkService;
  bots: DiscordBotManager;
  voice: VoiceSessionManager | null;
}
async function construct(config: RuntimeConfig, manager: GameManager, diplomacy: DiplomacyService): Promise<Integrations> {
  const [{ DiscordLinkService }, { DiscordBotManager, readDiscordBotConfig }] = await Promise.all([
    import('./discord/DiscordLinkService.js'), import('./discord/DiscordBotManager.js'),
  ]);
  const discord = readDiscordBotConfig();
  if (!discord) throw new Error('Enabled Discord integration is not configured.');
  const links = new DiscordLinkService(manager, discord.guildId, new Set(Object.keys(discord.powerTokens) as Power[]), config.discord.voiceEnabled);
  const bots = new DiscordBotManager(discord, manager, links, diplomacy);
  let voice: VoiceSessionManager | null = null;
  if (config.discord.voiceEnabled) {
    const { VoiceSessionManager } = await import('./voice/VoiceSessionManager.js');
    voice = new VoiceSessionManager(manager, links, bots, true, config.discord.voiceDebug, config.discord.autoListen);
  }
  return { links, bots, voice };
}
export async function createIntegrations(config: RuntimeConfig, manager: GameManager, diplomacy: DiplomacyService,
    factory = construct): Promise<Integrations | null> {
  // This gate is before SDK imports, secret reads, constructors and connections.
  if (config.profile === 'showcase' || !config.discord.enabled) return null;
  return factory(config, manager, diplomacy);
}
