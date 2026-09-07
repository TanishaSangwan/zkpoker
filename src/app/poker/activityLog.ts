'use client';

// A single, shared feed for what PhasePanel and RevealPanel report --
// transaction confirmations, errors, and the automatic-coordination status
// messages that used to be a growing <pre> block buried inside RevealPanel.
//
// Before this, each panel rendered its own result inline at the bottom of
// its own section. Fine for one action, but a full hand fires results from
// both panels repeatedly, at different depths of a long page -- so "did my
// last action work?" meant scrolling to wherever that panel happened to be.
// One feed, rendered once near the top (see ActivityLog.tsx), newest first,
// answers that without scrolling at all.
//
// Deliberately NOT a replacement for the inline busy/pending indicator next
// to the button you just clicked -- that stays where the click happened,
// which is exactly where you're already looking. This is for the RESULT,
// which is the part worth keeping around to glance back at.

import { create } from 'zustand';

export type LogKind = 'ok' | 'error' | 'info';

export type LogEntry = {
  id: number;
  kind: LogKind;
  text: string;
  detail?: string;
  ts: number;
};

let nextId = 1;

type ActivityLogState = {
  entries: LogEntry[];
  push: (kind: LogKind, text: string, detail?: string) => void;
  clear: () => void;
};

// Capped rather than unbounded -- a long session should not carry every
// share-relay status message it ever printed.
const MAX_ENTRIES = 40;

export const useActivityLog = create<ActivityLogState>()((set) => ({
  entries: [],
  push: (kind, text, detail) =>
    set((s) => ({
      entries: [{ id: nextId++, kind, text, detail, ts: Date.now() }, ...s.entries].slice(0, MAX_ENTRIES),
    })),
  clear: () => set({ entries: [] }),
}));
