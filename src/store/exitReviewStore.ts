import { create } from 'zustand'

// The review offered right after someone ends a connection from a chat.
// Unmatching deletes the match, which unmounts the chat — so the review is
// handed to ReviewPrompter (app-wide) instead of living in ChatView.
export interface ExitReview {
  matchId: string
  generation: number
  partnerUid: string
  name: string
}

interface ExitReviewState {
  pending: ExitReview | null
  offer: (review: ExitReview) => void
  clear: () => void
}

export const useExitReviewStore = create<ExitReviewState>((set) => ({
  pending: null,
  offer: (review) => set({ pending: review }),
  clear: () => set({ pending: null }),
}))
