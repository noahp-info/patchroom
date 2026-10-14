import type { ChatItem } from '../ipc';

/** Plain text of a chat item, for Copy and list snapshots. */
export function itemText(it: ChatItem): string {
  switch (it.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
      return it.text;
    case 'plan':
      return it.plan;
    case 'question':
      return it.questions.map((q) => q.question).join('\n');
    case 'tool':
      return `${it.name} ${typeof it.input === 'string' ? it.input : JSON.stringify(it.input)}`;
    case 'subagent':
      return it.description;
    case 'fallback':
      return it.summary;
  }
}
