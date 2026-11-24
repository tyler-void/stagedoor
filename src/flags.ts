// Application flags (https://docs.discord.com/developers/resources/application#application-object-application-flags).
// Only the three *_LIMITED intent flags can be changed through the API: they are the privileged
// intent switches on the portal's Bot page, for apps in under 100 servers.

export const FLAGS: Record<string, number> = {
  APPLICATION_AUTO_MODERATION_RULE_CREATE_BADGE: 1 << 6,
  GATEWAY_PRESENCE: 1 << 12,
  GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  VERIFICATION_PENDING_GUILD_LIMIT: 1 << 16,
  EMBEDDED: 1 << 17,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
  APPLICATION_COMMAND_BADGE: 1 << 23,
};

/** The intents as the portal names them, and the flags that mean "on". */
export const INTENTS = {
  presence: { label: "Presence Intent", limited: FLAGS.GATEWAY_PRESENCE_LIMITED as number, verified: FLAGS.GATEWAY_PRESENCE as number },
  members: { label: "Server Members Intent", limited: FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED as number, verified: FLAGS.GATEWAY_GUILD_MEMBERS as number },
  "message-content": { label: "Message Content Intent", limited: FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED as number, verified: FLAGS.GATEWAY_MESSAGE_CONTENT as number },
} as const;

export type IntentName = keyof typeof INTENTS;

export const SETTABLE_MASK = INTENTS.presence.limited | INTENTS.members.limited | INTENTS["message-content"].limited;

export function flagNames(flags: number): string[] {
  return Object.entries(FLAGS)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name);
}

/** Each intent: on via the switch (limited), via verification (100+ servers), or off. */
export function intentStates(flags: number): Record<IntentName, "on" | "on (verified app)" | "off"> {
  const out = {} as Record<IntentName, "on" | "on (verified app)" | "off">;
  for (const [name, bits] of Object.entries(INTENTS) as [IntentName, (typeof INTENTS)[IntentName]][]) {
    out[name] = (flags & bits.limited) !== 0 ? "on" : (flags & bits.verified) !== 0 ? "on (verified app)" : "off";
  }
  return out;
}

/**
 * The `flags` value to send to turn an intent on or off. Only the settable bits are sent, since the
 * docs say only those "can be updated via the API"; the current settable bits are kept.
 */
export function withIntent(flags: number, intent: IntentName, on: boolean): number {
  const current = flags & SETTABLE_MASK;
  const bit = INTENTS[intent].limited;
  return on ? current | bit : current & ~bit;
}

export function isIntentName(name: string): name is IntentName {
  return Object.hasOwn(INTENTS, name);
}
