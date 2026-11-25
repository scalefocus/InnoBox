// The implementation board's page logic that needs no DOM (INNOBOX_SPEC.md §46.7, §46.8): a card
// moved in place while its request is in flight, a card put back on a refusal, and the rule for
// which read answer the page may apply. Kept free of React so it is unit-testable under node:test.
import {
  IMPLEMENTATION_BOARD_COLUMN_MAX,
  compareBoardCards,
  type BoardColumn,
  type BoardMoveMode,
} from "@innobox/shared/implementation-board";

export interface BoardPerson {
  userId: string | null;
  displayName: string;
  anonymous: boolean;
  active?: boolean;
  scrubbed?: boolean;
  external?: boolean;
}

/** A card as GET /api/implementation-board sends it (§46.13). */
export interface BoardCardData {
  number: string;
  status: BoardColumn;
  statusChangedAt: string;
  author: BoardPerson;
  authors: BoardPerson[];
  likeCount: number;
  hype?: number;
  moves: BoardColumn[];
  moveMode?: BoardMoveMode;
  challengeNumber: string;
  challengeTitle: string;
  challengeStatus: string;
  namespaceSlug: string;
  impactAreaName: string;
  topics: { id: string; name: string; active: boolean }[];
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeActive: boolean | null;
  assigneeScrubbed: boolean | null;
}

export interface BoardData {
  columns: { status: BoardColumn; total: number; cards: BoardCardData[] }[];
  namespaces: { id: string; slug: string }[];
}

function withoutCard(board: BoardData, number: string): { board: BoardData; removed: BoardCardData | null } {
  let removed: BoardCardData | null = null;
  const columns = board.columns.map((col) => {
    const i = col.cards.findIndex((c) => c.number === number);
    if (i < 0) return col;
    removed = col.cards[i]!;
    return { ...col, total: Math.max(0, col.total - 1), cards: col.cards.filter((_, j) => j !== i) };
  });
  return { board: { ...board, columns }, removed };
}

function withCard(board: BoardData, card: BoardCardData): { board: BoardData; index: number; beyondCap: boolean } {
  let index = -1;
  let beyondCap = false;
  const columns = board.columns.map((col) => {
    if (col.status !== card.status) return col;
    const cards = [...col.cards, card].sort(compareBoardCards);
    index = cards.findIndex((c) => c.number === card.number);
    // §46.3: a read carries the first 100 — a card whose place lies beyond them is counted, not drawn.
    beyondCap = index >= IMPLEMENTATION_BOARD_COLUMN_MAX;
    return { ...col, total: col.total + 1, cards: beyondCap ? cards.filter((c) => c.number !== card.number) : cards };
  });
  return { board: { ...board, columns }, index, beyondCap };
}

/**
 * §46.7 While it is in flight: the card leaves its column and takes its place in the new one by the
 * column's order — a card that has just arrived — with no moves until the next read gives them (§46.6).
 * Returns null when the card is not on the board.
 */
export function moveCardLocally(
  board: BoardData,
  number: string,
  to: BoardColumn,
  now: Date,
): { board: BoardData; original: BoardCardData; index: number; beyondCap: boolean } | null {
  const { board: without, removed } = withoutCard(board, number);
  if (!removed) return null;
  const moved: BoardCardData = { ...removed, status: to, statusChangedAt: now.toISOString(), moves: [] };
  delete moved.moveMode;
  const placed = withCard(without, moved);
  return { board: placed.board, original: removed, index: placed.index, beyondCap: placed.beyondCap };
}

/** §46.8: a refused move puts the card back where it was, as the last read gave it. `movedTo` is the
 *  column it was moved into, whose count drops even when the card was past the 100 and not drawn. */
export function restoreCard(board: BoardData, original: BoardCardData, movedTo?: BoardColumn): BoardData {
  const { board: without, removed } = withoutCard(board, original.number);
  const fixed =
    removed || !movedTo
      ? without
      : { ...without, columns: without.columns.map((c) => (c.status === movedTo ? { ...c, total: Math.max(0, c.total - 1) } : c)) };
  return withCard(fixed, original).board;
}

/** A card with no moves while its own move is in flight or until the read after it lands (§46.7). */
export function withoutMoves(board: BoardData, number: string): BoardData {
  return {
    ...board,
    columns: board.columns.map((col) => ({
      ...col,
      cards: col.cards.map((c) => (c.number === number ? { ...c, moves: [], moveMode: undefined } : c)),
    })),
  };
}

/**
 * §46.8 Which answer is applied: only the answer to the latest read the page sent, when none of the
 * viewer's moves was sent or answered after that read was sent, and nothing is being dragged and no
 * menu or confirmation is open. Any other answer is dropped.
 */
export function shouldApplyRead(input: {
  readSeq: number;
  latestReadSeq: number;
  moveEpochAtSend: number;
  moveEpochNow: number;
  movesInFlight: number;
  interacting: boolean;
}): boolean {
  return (
    input.readSeq === input.latestReadSeq &&
    input.moveEpochAtSend === input.moveEpochNow &&
    input.movesInFlight === 0 &&
    !input.interacting
  );
}

export function findCard(board: BoardData | null, number: string): BoardCardData | undefined {
  return board?.columns.flatMap((c) => c.cards).find((c) => c.number === number);
}
