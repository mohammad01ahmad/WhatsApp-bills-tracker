// Command parsing for the group. Images are handled in socket.ts directly; this
// only classifies text messages.

export const COMMANDS = ['today', 'week', 'month', 'undo'] as const
export type Command = (typeof COMMANDS)[number]

/**
 * Returns the command if `text` starts with `/today`, `/week`, `/month`, or
 * `/undo` (case-insensitive, must be a whole word — `/todays` doesn't match).
 * Trailing text is allowed (`/undo please` → 'undo'). Otherwise undefined.
 */
export function parseCommand(text: string): Command | undefined {
    const m = text.trim().toLowerCase().match(/^\/(today|week|month|undo)\b/)
    return m ? (m[1] as Command) : undefined
}
