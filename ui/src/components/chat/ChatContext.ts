import { createContext } from 'react';
import type { AppStore } from '../../state/store';

/** Which store and DM the chat components below belong to. */
export const ChatContext = createContext<{ store: AppStore; sessionId: string } | null>(null);
