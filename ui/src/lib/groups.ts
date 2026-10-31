import type { SectionInfo, SessionInfo } from '../ipc';

/** Id of the group for DMs with no stored section. */
export const DEFAULT_GROUP = '__default__';
export const STARRED_GROUP = '__starred__';
export const ARCHIVED_GROUP = '__archived__';

export type GroupKind = 'starred' | 'section' | 'divider' | 'default' | 'archived';

export interface Group {
  id: string;
  kind: GroupKind;
  title: string;
  /** The stored section behind this group, if any. */
  section: SectionInfo | null;
  items: SessionInfo[];
}

/**
 * Sidebar groups in display order: Starred, the stored sections, Direct messages, Archived.
 * Starred and Archived are flags, not sections. An archived DM shows only under Archived and a
 * starred one only under Starred; neither shows in its section.
 */
export function buildGroups(sections: SectionInfo[], sessions: SessionInfo[]): Group[] {
  const known = new Set(sections.filter((s) => s.kind !== 'divider').map((s) => s.id));
  const live = sessions.filter((s) => !s.archived);
  const plain = live.filter((s) => !s.starred);
  return [
    {
      id: STARRED_GROUP,
      kind: 'starred',
      title: 'Starred',
      section: null,
      items: live.filter((s) => s.starred),
    },
    ...sections.map<Group>((section) => ({
      id: section.id,
      kind: section.kind === 'divider' ? 'divider' : 'section',
      title: section.name,
      section,
      // A divider holds no DMs of its own.
      items: section.kind === 'divider' ? [] : plain.filter((s) => s.sectionId === section.id),
    })),
    {
      id: DEFAULT_GROUP,
      kind: 'default',
      title: 'Sessions',
      section: null,
      // A DM whose section was deleted, or that has none, falls back to Direct messages.
      items: plain.filter((s) => s.sectionId === null || !known.has(s.sectionId)),
    },
    {
      id: ARCHIVED_GROUP,
      kind: 'archived',
      title: 'Archived',
      section: null,
      items: sessions.filter((s) => s.archived),
    },
  ];
}

/** Non-archived DMs in the order the sidebar shows them (collapsed groups included). */
export function visibleOrder(sections: SectionInfo[], sessions: SessionInfo[]): SessionInfo[] {
  return buildGroups(sections, sessions)
    .filter((g) => g.kind !== 'archived')
    .flatMap((g) => g.items);
}

/** A divider with a label can fold the groups below it; one without is a rule only. */
export const isFoldingDivider = (g: Group) => g.kind === 'divider' && g.title.trim() !== '';

/**
 * For each group, the labeled divider it sits under: the nearest labeled divider above it with no
 * other divider in between. Starred comes first, so it never sits under one. An unlabeled divider
 * still ends the group above it. Direct messages and Archived, which follow the stored sections,
 * belong to the last divider's group.
 */
export function dividerOf(groups: Group[]): Map<string, Group | null> {
  const out = new Map<string, Group | null>();
  let cur: Group | null = null;
  for (const g of groups) {
    if (g.kind === 'divider') {
      out.set(g.id, null);
      cur = isFoldingDivider(g) ? g : null;
    } else out.set(g.id, cur);
  }
  return out;
}
