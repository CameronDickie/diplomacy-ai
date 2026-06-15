import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import type { Power } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import type { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import type { GameManager } from '../GameManager.js';
import type { DiscordLinkService } from './DiscordLinkService.js';

interface DiscordBotConfig {
  guildId: string;
  coordinatorToken: string;
  powerTokens: Partial<Record<Power, string>>;
}

export class DiscordBotManager {
  private coordinator: Client | null = null;
  private powerClients = new Map<Power, Client>();
  private presenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: DiscordBotConfig,
    private readonly gameManager: GameManager,
    private readonly links: DiscordLinkService,
    private readonly diplomacy: DiplomacyService
  ) {}

  async start(): Promise<void> {
    this.coordinator = this.createCoordinatorClient();
    await this.coordinator.login(this.config.coordinatorToken);

    await Promise.all(
      ALL_POWERS.map(async power => {
        const token = this.config.powerTokens[power];
        if (!token) {
          console.warn(`Discord ${power} bot is disabled: token is not configured`);
          return;
        }
        const client = this.createPowerClient(power);
        this.powerClients.set(power, client);
        await client.login(token);
      })
    );
    this.syncPowerPresence();
    this.presenceTimer = setInterval(() => this.syncPowerPresence(), 15_000);
  }

  async stop(): Promise<void> {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    await Promise.all([
      this.coordinator?.destroy(),
      ...[...this.powerClients.values()].map(client => client.destroy()),
    ]);
  }

  getPowerClient(power: Power): Client | undefined {
    return this.powerClients.get(power);
  }

  getCoordinatorClient(): Client | null {
    return this.coordinator;
  }

  notifyStatuses(gameId: string): void {
    const room = this.gameManager.getRoom(gameId);
    if (!room) return;
    for (const player of room.getState().players) {
      if (player.kind !== 'HUMAN') continue;
      room.emitToPlayer(player.id, 'discord_link_status', {
        status: this.links.getStatus(room.gameId, player.id),
      });
    }
    this.syncPowerPresence();
  }

  private createCoordinatorClient(): Client {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });
    client.once(Events.ClientReady, async readyClient => {
      const guild = await readyClient.guilds.fetch(this.config.guildId);
      await guild.commands.set(coordinatorCommands.map(command => command.toJSON()));
      readyClient.user.setPresence({
        status: 'online',
        activities: [{ name: 'Diplomacy setup' }],
      });
      console.log(`Discord coordinator ready as ${readyClient.user.tag}`);
    });
    client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isChatInputCommand()) return;
      void this.handleCoordinatorCommand(interaction);
    });
    return client;
  }

  private createPowerClient(power: Power): Client {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });
    client.once(Events.ClientReady, readyClient => {
      console.log(`Discord ${power} bot ready as ${readyClient.user.tag}`);
      this.syncPowerPresence();
    });
    client.on(Events.MessageCreate, message => {
      void this.handlePowerDirectMessage(power, message);
    });
    return client;
  }

  private async handleCoordinatorCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    try {
      if (interaction.guildId !== this.config.guildId) {
        await interaction.reply({ content: 'This deployment serves another server.', ephemeral: true });
        return;
      }
      if (interaction.commandName === 'link') {
        const code = interaction.options.getString('code', true);
        const member = await interaction.guild?.members.fetch(interaction.user.id);
        const link = this.links.linkPlayer(
          code,
          interaction.user.id,
          member?.displayName ?? interaction.user.displayName
        );
        this.notifyStatuses(link.gameId);
        await interaction.reply({
          content: `Linked Discord to the ${this.gameManager.getRoom(link.gameId)?.getPlayerById(link.playerId)?.power} seat.`,
          ephemeral: true,
        });
        return;
      }
      if (interaction.commandName === 'unlink') {
        const linked = this.links.resolveDiscordUser(interaction.user.id);
        const removed = this.links.unlinkDiscordUser(interaction.user.id);
        if (linked) this.notifyStatuses(linked.gameId);
        await interaction.reply({
          content: removed ? 'Discord link removed.' : 'No player link was found.',
          ephemeral: true,
        });
        return;
      }
      if (interaction.commandName === 'game') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'bind') {
          const gameId = this.links.bindGuild(
            interaction.options.getString('code', true),
            interaction.guildId
          );
          this.notifyStatuses(gameId);
          await interaction.reply({
            content: `This server is now bound to game ${gameId}.`,
            ephemeral: true,
          });
          return;
        }
        const gameId = this.links.getBoundGameId();
        await interaction.reply({
          content: gameId
            ? `This server is bound to game ${gameId}.`
            : 'No browser game is bound to this server.',
          ephemeral: true,
        });
      }
    } catch (error) {
      const content = error instanceof Error ? error.message : 'Discord command failed';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }

  private async handlePowerDirectMessage(
    power: Power,
    message: Message
  ): Promise<void> {
    if (message.author.bot || message.guildId || !message.content.trim()) return;
    const linked = this.links.resolveDiscordUser(message.author.id);
    if (!linked) {
      await message.reply('Link your browser seat first with the coordinator bot using `/link`.');
      return;
    }
    const room = this.gameManager.getRoom(linked.gameId);
    const llm = room?.getLlmPlayer(power);
    if (!room || !llm) {
      await message.reply(`${power} is not an active LLM power in the bound game.`);
      return;
    }
    if (linked.player.power === power) {
      await message.reply('You cannot send private diplomacy to your own power.');
      return;
    }

    const wasBusy = room.isVoiceBusy(power);
    if (wasBusy) {
      await message.reply(`${power} is in a voice conversation. Your message was stored and its reply is queued.`);
    } else if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    try {
      const messages = await this.diplomacy.send({
        gameId: room.gameId,
        fromPower: linked.player.power,
        toPower: power,
        body: message.content,
        source: 'DISCORD_TEXT',
        externalMessageId: message.id,
      });
      const reply = messages.find(candidate => candidate.automated);
      if (reply) await message.reply(reply.body);
    } catch (error) {
      console.error(`Discord diplomacy failed for ${power}:`, error);
      await message.reply('The message could not be processed. Check the browser event log.');
    }
  }

  private syncPowerPresence(): void {
    const gameId = this.links.getBoundGameId();
    const room = gameId ? this.gameManager.getRoom(gameId) : undefined;
    for (const [power, client] of this.powerClients) {
      if (!client.user) continue;
      const active = Boolean(room?.getLlmPlayer(power));
      client.user.setPresence({
        status: active ? 'online' : 'invisible',
        activities: active ? [{ name: `as ${power}` }] : [],
      });
    }
  }
}

const coordinatorCommands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your browser player')
    .addStringOption(option =>
      option.setName('code').setDescription('One-time browser link code').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove your Discord player link'),
  new SlashCommandBuilder()
    .setName('game')
    .setDescription('Manage the browser game bound to this Discord server')
    .addSubcommand(subcommand =>
      subcommand
        .setName('bind')
        .setDescription('Bind this server to a browser game')
        .addStringOption(option =>
          option.setName('code').setDescription('One-time host bind code').setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand.setName('status').setDescription('Show the currently bound game')
    ),
];

export function readDiscordBotConfig(): DiscordBotConfig | null {
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const coordinatorToken = process.env.DISCORD_COORDINATOR_TOKEN?.trim();
  if (!guildId || !coordinatorToken) return null;

  const powerTokens = Object.fromEntries(
    ALL_POWERS.flatMap(power => {
      const token = process.env[`DISCORD_${power}_TOKEN`]?.trim();
      return token ? [[power, token]] : [];
    })
  ) as Partial<Record<Power, string>>;
  return { guildId, coordinatorToken, powerTokens };
}
